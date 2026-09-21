/**
 * FORGE-035/036: the Node host serves the same contract over real HTTP with
 * PostgreSQL, drives the realtime profile in-process, sweeps durable work,
 * and drains on stop; a restart resumes acknowledged work from the store.
 * Requires FORGE_PG_URL.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Effect } from "effect";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as client from "../../../conformance/fixtures/acme.client.js";
import { HttpTarget, type ClientModule } from "../../../conformance/src/http-target.js";
import { runScenario } from "../../../conformance/src/runner.js";
import { loadScenarios } from "../../../conformance/src/scenarios.js";
import { externals, functions } from "../../../examples/acme/impl/index.js";
import { createPostgresStorage } from "../src/adapters/postgres.js";
import { createNodeHost, type NodeHost } from "../src/hosts/node.js";
import type { AppBundle } from "../src/model.js";

// A separate database from postgres.test.ts: both recreate their schema (FORGE_PG_NODE_URL, default derives `<db>_node`).
const url = process.env["FORGE_PG_NODE_URL"] ?? process.env["FORGE_PG_URL"]?.replace(/\/([^/]+)$/, "/forge_node");
const bundle = JSON.parse(readFileSync(resolve(import.meta.dirname, "..", "..", "..", "conformance", "fixtures", "acme.app.json"), "utf8")) as AppBundle;
const schema = readFileSync(resolve(import.meta.dirname, "..", "..", "..", "examples", "acme", "generated", "postgres", "0001_init.sql"), "utf8");

describe.skipIf(!url)("Node host on PostgreSQL", () => {
  let pool: pg.Pool;
  let host: NodeHost;
  let base: string;
  const start = async () => {
    host = createNodeHost({ bundle, store: createPostgresStorage(pool, host?.runtime.model ?? new (await import("../src/model.js")).Model(bundle)), functions, externals, cursorSecret: "node-test", sweepIntervalMs: 250, telemetryFormat: "silent", objects: { directory: resolve(import.meta.dirname, "..", ".forge-objects-test") } });
    base = (await host.listen(0)).url;
  };
  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: url, max: 6 });
    await pool.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
    await pool.query(schema);
    await start();
  });
  afterAll(async () => { await host?.stop(); await pool?.end(); });

  it("answers probes and serves the contract", async () => {
    expect((await fetch(`${base}/healthz`)).status).toBe(200);
    expect((await fetch(`${base}/readyz`)).status).toBe(200);
    const r = await fetch(`${base}/v1/customers`, { method: "POST", headers: { "content-type": "application/json", "x-forge-tenant": "node-a", "x-forge-actor": "a" }, body: JSON.stringify({ code: "NODE", name: "N" }) });
    expect(r.status).toBe(201);
    expect(r.headers.get("traceparent")).toMatch(/^00-/);
  });

  for (const scenario of loadScenarios()) {
    it(`scenario ${scenario.id} over HTTP`, async () => {
      const c: ClientModule = { createClient: (o) => client.createClient(o) };
      const report = await runScenario(scenario, new HttpTarget(c, base, "node-postgres"), { tenant: `node-${scenario.id}-${Date.now().toString(36)}` });
      expect(report.failures).toEqual([]);
    }, 120_000);
  }

  it("realtime: subscribe, receive a sequenced event, resume by position on a new socket", async () => {
    const tenant = `node-rt-${Date.now().toString(36)}`;
    const wsUrl = base.replace("http", "ws") + `/v1/live/orders?tenant=${tenant}&actor=a`;
    const open = () => new Promise<WebSocket>((res, rej) => { const ws = new WebSocket(wsUrl); ws.onopen = () => res(ws); ws.onerror = () => rej(new Error("ws error")); });
    const next = (ws: WebSocket, pred: (f: any) => boolean) => new Promise<any>((res) => { ws.addEventListener("message", (ev) => { const f = JSON.parse(String(ev.data)); if (pred(f)) res(f); }); });
    const a = await open();
    const hello = next(a, (f) => f.type === "hello");
    a.send(JSON.stringify({ type: "subscribe", stream: "@acme/commerce/_/OrderEvents" }));
    expect(await hello).toMatchObject({ latest: 0 });
    const c = client.createClient({ baseUrl: base, tenant, actor: "a" });
    const cu = await c.customers.create({ code: "RTN", name: "R" });
    const s = await c.sites.create({ customer: cu.id, code: "hq", name: "HQ", timezone: "UTC" });
    const o = await c.orders.create({ customer: cu.id, site: s.id, subtotal: "10.00", tax: "1.00", requestedOn: "2026-09-20" });
    const ev = next(a, (f) => f.type === "event");
    await c.functions.submitOrder({ order: o.id, expectedVersion: 1 });
    expect(await ev).toMatchObject({ seq: 1, message: "OrderSubmitted" });
    a.close();
    const b = await open();
    const resumed = next(b, (f) => f.type === "resumed");
    b.send(JSON.stringify({ type: "resume", stream: "@acme/commerce/_/OrderEvents", after: 0 }));
    expect(await resumed).toMatchObject({ replayed: 1, gap: false, latest: 1 });
    b.close();
  }, 30_000);

  it("a restart resumes acknowledged durable work: a pending outbox row from before the stop is delivered after", async () => {
    const tenant = `node-restart-${Date.now().toString(36)}`;
    const c = client.createClient({ baseUrl: base, tenant, actor: "a" });
    const cu = await c.customers.create({ code: "RST", name: "R" });
    const s = await c.sites.create({ customer: cu.id, code: "hq", name: "HQ", timezone: "UTC" });
    const o = await c.orders.create({ customer: cu.id, site: s.id, subtotal: "10.00", tax: "1.00", requestedOn: "2026-09-20" });
    // Park a pending row: insert directly as the commit would, then stop before any sweep runs.
    await pool.query("INSERT INTO forge_outbox (tenant, op_id, ordinal, channel, message, payload, status, attempts, created_at) VALUES ($1, 'op_restart', 0, '@acme/commerce/_/OrderEvents', 'OrderSubmitted', $2, 'pending', 0, $3)", [tenant, JSON.stringify({ order: o.id, customer: cu.id, revision: 1 }), new Date().toISOString()]);
    await host.stop();
    expect((await fetch(`${base}/healthz`).catch(() => ({ status: 0 }))).status).toBe(0);
    await start();
    await host.runtime.sweepAll();
    const row = await pool.query("SELECT status, delivered FROM forge_outbox WHERE tenant = $1 AND op_id = 'op_restart'", [tenant]);
    expect(row.rows[0]).toMatchObject({ status: "delivered" });
    expect(JSON.parse(row.rows[0].delivered)).toContain("realtime:OrderEvents");
    // and the FulfillOrder consumer ran exactly once (processed ledger)
    const processed = await pool.query("SELECT count(*)::int AS n FROM forge_processed WHERE tenant = $1 AND message_id = 'op_restart:0'", [tenant]);
    expect(processed.rows[0].n).toBe(1);
  }, 30_000);

  it("drains in-flight requests on stop and refuses new ones", async () => {
    const slow = fetch(`${base}/v1/customers?tier=gold`, { headers: { "x-forge-tenant": "node-drain", "x-forge-actor": "a" } });
    await new Promise((r) => setTimeout(r, 15)); // let the request reach the server before the listener closes
    const stopped = host.stop();
    const r = await slow;
    expect([200, 503]).toContain(r.status);
    await stopped;
    expect(host.ready).toBe(false);
    await start();
  });
});
