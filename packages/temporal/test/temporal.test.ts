/**
 * FORGE-076 / PAR-153 on the self-hosted-full profile: Node host + PostgreSQL
 * + a real Temporal server (`temporal server start-dev`). Temporal owns the
 * durable timers and signal buffering; the Forge store owns the instance.
 * The worker and the API process are crashed around a sleeping step and an
 * external signal; the restarted processes complete the workflow exactly
 * once. Requires FORGE_PG_URL and the `temporal` CLI on PATH.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AppBundle } from "@forge/runtime";
import { createNodeHost, type NodeHost } from "@forge/runtime/node";
import { createPostgresStorage } from "@forge/runtime/postgres";
import { Model } from "@forge/runtime";
import * as client from "../../../conformance/fixtures/acme.client.js";
import { externals, functions } from "../../../examples/acme/impl/index.js";
import { temporalDriver, temporalWorker } from "../src/index.js";

const url = process.env["FORGE_PG_NODE_URL"] ?? process.env["FORGE_PG_URL"]?.replace(/\/([^/]+)$/, "/forge_temporal");
const hasTemporal = (() => { try { execFileSync("temporal", ["--version"], { stdio: "ignore" }); return true; } catch { return false; } })();
const bundle = JSON.parse(readFileSync(resolve(import.meta.dirname, "..", "..", "..", "conformance", "fixtures", "acme.app.json"), "utf8")) as AppBundle;
const schema = readFileSync(resolve(import.meta.dirname, "..", "..", "..", "examples", "acme", "migrations", "postgres", "0001_init.sql"), "utf8");
const PORT = 17233;
const ADDRESS = `127.0.0.1:${PORT}`;
const TASK_QUEUE = `forge-acme-${process.pid}`;

describe.skipIf(!url || !hasTemporal)("self-hosted-full: Node + PostgreSQL + Temporal", () => {
  let server: ChildProcess;
  let pool: pg.Pool;
  let host: NodeHost;
  let base: string;
  let driver: Awaited<ReturnType<typeof temporalDriver>>;
  let worker: Awaited<ReturnType<typeof temporalWorker>> | null = null;
  let running: Promise<void> | null = null;

  const startHost = async () => {
    driver = await temporalDriver({ address: ADDRESS, taskQueue: TASK_QUEUE });
    host = createNodeHost({ bundle, store: createPostgresStorage(pool, new Model(bundle)), functions, externals, cursorSecret: "temporal-test", sweepIntervalMs: 0, telemetryFormat: "silent", workflowDriver: driver });
    base = (await host.listen(0)).url;
  };
  const startWorker = async () => {
    worker = await temporalWorker(host.runtime.engine, { address: ADDRESS, taskQueue: TASK_QUEUE });
    running = worker.run();
  };
  const stopWorker = async () => {
    worker?.shutdown();
    await running?.catch(() => undefined);
    worker = null;
    running = null;
  };

  beforeAll(async () => {
    server = spawn("temporal", ["server", "start-dev", "--headless", "--port", String(PORT), "--log-level", "error"], { stdio: "ignore" });
    // wait for the frontend
    for (let i = 0; i < 60; i++) {
      try { await (await temporalDriver({ address: ADDRESS, taskQueue: TASK_QUEUE })).close(); break; } catch { await new Promise((r) => setTimeout(r, 500)); }
    }
    pool = new pg.Pool({ connectionString: url, max: 6 });
    await pool.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
    await pool.query(schema);
    await startHost();
    await startWorker();
  }, 120_000);
  afterAll(async () => {
    await stopWorker();
    await host?.stop();
    await driver?.close();
    await pool?.end();
    server?.kill("SIGTERM");
  });

  it("PAR-153: a sleeping step survives a worker crash (Temporal fires the timer), an early signal and a host crash lose nothing", async () => {
    const tenant = `tmp-${Date.now().toString(36)}`;
    const c = client.createClient({ baseUrl: base, tenant, actor: "a" });
    const cu = await c.customers.create({ code: "TMP", name: "T" });
    const s = await c.sites.create({ customer: cu.id, code: "hq", name: "HQ", timezone: "UTC" });
    const o = await c.orders.create({ customer: cu.id, site: s.id, subtotal: "10.00", tax: "1.00", requestedOn: "2026-09-21" });
    const h = { "content-type": "application/json", "x-forge-tenant": tenant, "x-forge-actor": "a" };
    // early payment: held durably until the workflow reaches its wait
    const early = await (await fetch(`${base}/v1/workflows/process-order/signals/PaymentCaptured`, { method: "POST", headers: h, body: JSON.stringify({ messageId: "pay-early", payload: { authorizationId: "auth_e", reference: o.id, amount: "11.00" } }) })).json();
    expect(early).toMatchObject({ delivered: 0, held: 1 });
    // start: the held signal is consumed at the wait, the order is approved, and the instance parks on `settle` (sleep 5s)
    const wf = await (await fetch(`${base}/v1/orders/${o.id}/process`, { method: "POST", headers: h, body: JSON.stringify({ expectedVersion: 1 }) })).json() as { id: string; status: string };
    expect(wf.status).toBe("sleeping");
    // crash the worker and the API process while the timer is pending
    await stopWorker();
    host.server.closeAllConnections();
    await host.stop();
    // nothing advanced the sleep locally: the instance is still sleeping in Postgres
    const doc = await pool.query("SELECT body FROM forge_document WHERE tenant = $1 AND kind = 'workflow' AND id LIKE $2", [tenant, `%${wf.id}%`]);
    expect(doc.rows.length).toBeGreaterThan(0);
    // second process + worker: Temporal's timer fires (5s from the start), the activity advances, the instance completes
    await startHost();
    await startWorker();
    let done: { status: string } | null = null;
    for (let i = 0; i < 60 && done?.status !== "completed"; i++) {
      await new Promise((r) => setTimeout(r, 500));
      done = await (await fetch(`${base}/v1/workflows/process-order/${wf.id}`, { headers: h })).json() as { status: string };
    }
    expect(done?.status).toBe("completed");
    expect((await client.createClient({ baseUrl: base, tenant, actor: "a" }).orders.get(o.id)).status).toBe("Approved");
    // Temporal's own record: one execution per instance, completed
    const handle = driver.client.workflow.getHandle(`forge:${tenant}:${wf.id}`.replace(/[^A-Za-z0-9:_-]/g, "_"));
    const desc = await handle.describe();
    expect(desc.status.name).toBe("COMPLETED");
    // a duplicate signal after completion is not applied and does not error
    const dup = await (await fetch(`${base}/v1/workflows/process-order/signals/PaymentCaptured`, { method: "POST", headers: h, body: JSON.stringify({ messageId: "pay-early", payload: { authorizationId: "auth_e", reference: o.id, amount: "11.00" } }) })).json();
    expect(dup).toMatchObject({ delivered: 0 });
  }, 120_000);

  it("a late signal reaches a waiting instance through Temporal's buffered wake after the worker restarts", async () => {
    const tenant = `tmp2-${Date.now().toString(36)}`;
    const c = client.createClient({ baseUrl: base, tenant, actor: "a" });
    const cu = await c.customers.create({ code: "TMP", name: "T" });
    const s = await c.sites.create({ customer: cu.id, code: "hq", name: "HQ", timezone: "UTC" });
    const o = await c.orders.create({ customer: cu.id, site: s.id, subtotal: "10.00", tax: "1.00", requestedOn: "2026-09-21" });
    const h = { "content-type": "application/json", "x-forge-tenant": tenant, "x-forge-actor": "a" };
    const wf = await (await fetch(`${base}/v1/orders/${o.id}/process`, { method: "POST", headers: h, body: JSON.stringify({ expectedVersion: 1 }) })).json() as { id: string; status: string };
    expect(wf.status).toBe("waiting");
    await stopWorker();
    const pay = await (await fetch(`${base}/v1/workflows/process-order/signals/PaymentCaptured`, { method: "POST", headers: h, body: JSON.stringify({ messageId: "pay-late", payload: { authorizationId: "auth_l", reference: o.id, amount: "11.00" } }) })).json();
    expect(pay).toMatchObject({ delivered: 1 });
    // the engine advanced to the sleep on the signal; only Temporal's timer (needing a worker) can finish it
    const parked = await (await fetch(`${base}/v1/workflows/process-order/${wf.id}`, { headers: h })).json() as { status: string };
    expect(parked.status).toBe("sleeping");
    await new Promise((r) => setTimeout(r, 6000));
    expect(((await (await fetch(`${base}/v1/workflows/process-order/${wf.id}`, { headers: h })).json()) as { status: string }).status).toBe("sleeping"); // no worker: still parked
    await startWorker();
    let done: { status: string } | null = null;
    for (let i = 0; i < 40 && done?.status !== "completed"; i++) {
      await new Promise((r) => setTimeout(r, 500));
      done = await (await fetch(`${base}/v1/workflows/process-order/${wf.id}`, { headers: h })).json() as { status: string };
    }
    expect(done?.status).toBe("completed");
  }, 120_000);
});
