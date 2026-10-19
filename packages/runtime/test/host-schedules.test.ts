/**
 * FORG-3 on the hosts: a trigger must fire schedules for an idle tenant (no pending outbox rows, no
 * workflows) and for a tenant-less package on a fresh deployment. Cloudflare: D1 is real SQLite (libSQL)
 * with the generated D1 migration and the Worker is the production `createWorker`. Node: the composed
 * runtime's periodic `sweepAll`. (The Lambda host shares `Schedules.sweep`; it needs DynamoDB to run.)
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createClient } from "@libsql/client";
import { Effect } from "effect";
import { beforeEach, describe, expect, it } from "vitest";
import { createWorker } from "../src/hosts/cloudflare.js";
import { composeRuntime } from "../src/hosts/compose.js";
import { MemoryStorage } from "../src/adapters/memory.js";
import { libsqlExecutor } from "../src/adapters/libsql-executor.js";
import { defineFunction } from "../src/functions.js";
import { devHeaderAuth } from "../src/http.js";
import { nextOccurrence, parseRecurrence } from "../src/schedules.js";
import type { AppBundle } from "../src/model.js";
import type { D1Like } from "../src/adapters/d1.js";

const bundle = JSON.parse(readFileSync(resolve(import.meta.dirname, "..", "..", "..", "conformance", "fixtures", "acme.app.json"), "utf8")) as AppBundle;
const migration = readFileSync(resolve(import.meta.dirname, "d1-harness", "migrations", "0001_all.sql"), "utf8");

let runs: { tenant: string; occurrence: string }[];
const runner = defineFunction("@acme/commerce/_/RebuildOrderSummary", (d) => Effect.sync(() => {
  runs.push({ tenant: d.ctx.tenant, occurrence: String((d.input as { occurrence: string }).occurrence) });
  return { ok: true };
}));

async function d1() {
  const client = createClient({ url: "file::memory:" });
  await client.executeMultiple(migration);
  return { DB: libsqlExecutor(client) as unknown as D1Like, CURSOR_SECRET: "test", client };
}
async function trigger(worker: ReturnType<typeof createWorker>, env: Record<string, unknown>, scheduledTime: number) {
  const pending: Promise<unknown>[] = [];
  await worker.scheduled({ cron: "*/5 * * * *", scheduledTime }, env as never, { waitUntil: (p) => void pending.push(p) });
  await Promise.all(pending);
}
// The next 03:00 UTC after the wall clock (the Worker's Clock is real), plus a late 5-minute sweep.
const next0300 = () => Date.parse(nextOccurrence(parseRecurrence("0 3 * * *", "UTC"), new Date().toISOString())!);

beforeEach(() => { runs = []; });

describe("Cloudflare scheduled() (FORG-3)", () => {
  it("fires a schedule for a tenant that has been seen but has no pending outbox rows", async () => {
    const env = await d1();
    const worker = createWorker(bundle, { auth: devHeaderAuth(), functions: [runner] });
    const pending: Promise<unknown>[] = [];
    const res = await worker.fetch(new Request("https://forge.test/v1/customers", { method: "POST", headers: { "content-type": "application/json", "x-forge-tenant": "idle", "x-forge-actor": "a" }, body: JSON.stringify({ code: "IDLE", name: "Idle" }) }), env as never, { waitUntil: (p) => void pending.push(p) });
    expect(res.status).toBe(201);
    await Promise.all(pending);
    const pendingOutbox = await env.client.execute("SELECT COUNT(*) AS n FROM forge_outbox WHERE status = 'pending'");
    expect(Number(pendingOutbox.rows[0]!["n"])).toBe(0);

    const at = next0300();
    await trigger(worker, env, at + 4 * 60_000);
    expect(runs).toEqual([{ tenant: "idle", occurrence: new Date(at).toISOString() }]);
    await trigger(worker, env, at + 9 * 60_000);
    expect(runs).toHaveLength(1);
  });

  it("fires a tenant-less package's schedule on a fresh deployment, once per occurrence", async () => {
    const global = structuredClone(bundle);
    for (const m of global.ir.modules) for (const r of m.resources) r.decorators.tenant = false;
    const env = await d1();
    const worker = createWorker(global, { auth: devHeaderAuth(), functions: [runner] });
    const at = next0300();
    await trigger(worker, env, at);
    await trigger(worker, env, at + 5 * 60_000);
    expect(runs).toEqual([{ tenant: "_forge", occurrence: new Date(at).toISOString() }]);
  });
});

describe("composed (Node) runtime sweepAll (FORG-3)", () => {
  it("fires a schedule for an observed tenant with no outbox rows or workflows", async () => {
    let clock = "2026-09-20T02:00:00.000Z";
    const rt = composeRuntime({ bundle, store: new MemoryStorage(), cursorSecret: "test", clock: () => clock, functions: [runner] });
    await rt.observeTenant("idle");
    clock = "2026-09-20T03:05:00.000Z";
    await rt.sweepAll(Date.parse(clock));
    expect(runs).toEqual([{ tenant: "idle", occurrence: "2026-09-20T03:00:00.000Z" }]);
    await rt.sweepAll(Date.parse("2026-09-20T03:10:00.000Z"));
    expect(runs).toHaveLength(1);
  });
});
