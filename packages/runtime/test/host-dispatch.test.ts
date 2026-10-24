/**
 * FORG-29: the Cloudflare host options a packed (sliced) Worker relies on. A Worker that runs a
 * slice of the app must not sweep the outbox itself (its subscription table is partial, and the
 * dispatcher marks a row done after the subscriptions it knows), so `postCommit` replaces the
 * in-process nudge and `dispatch()` runs it on a Worker that holds the whole table; `sweeps` limits
 * what a cron invocation does.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createClient } from "@libsql/client";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { createWorker } from "../src/hosts/cloudflare.js";
import { libsqlExecutor } from "../src/adapters/libsql-executor.js";
import { defineFunction } from "../src/functions.js";
import { devHeaderAuth } from "../src/http.js";
import { nextOccurrence, parseRecurrence } from "../src/schedules.js";
import type { AppBundle } from "../src/model.js";
import type { D1Like } from "../src/adapters/d1.js";

const bundle = JSON.parse(readFileSync(resolve(import.meta.dirname, "..", "..", "..", "conformance", "fixtures", "acme.app.json"), "utf8")) as AppBundle;
const migration = readFileSync(resolve(import.meta.dirname, "d1-harness", "migrations", "0001_all.sql"), "utf8");

async function d1() {
  const client = createClient({ url: "file::memory:" });
  await client.executeMultiple(migration);
  return { env: { DB: libsqlExecutor(client) as unknown as D1Like, CURSOR_SECRET: "test" }, client };
}
const pendingRows = async (client: Awaited<ReturnType<typeof d1>>["client"]) => Number((await client.execute("SELECT COUNT(*) AS n FROM forge_outbox WHERE status = 'pending'")).rows[0]!["n"]);
const create = (tenant: string) => new Request("https://forge.test/v1/customers", { method: "POST", headers: { "content-type": "application/json", "x-forge-tenant": tenant, "x-forge-actor": "a" }, body: JSON.stringify({ code: "C-1", name: "One" }) });

describe("Cloudflare host: dispatch hand-off (FORG-29)", () => {
  it("postCommit replaces the in-process outbox sweep; dispatch() on a whole-app Worker delivers", async () => {
    const { env, client } = await d1();
    const calls: string[] = [];
    const sliced = createWorker(bundle, { auth: devHeaderAuth(), postCommit: async (_env, tenant) => void calls.push(tenant) });
    const pending: Promise<unknown>[] = [];
    expect((await sliced.fetch(create("t1"), env as never, { waitUntil: (p) => void pending.push(p) })).status).toBe(201);
    await Promise.all(pending);
    expect(calls).toEqual(["t1"]);
    // The audited create staged Customer.changes; nobody swept it.
    expect(await pendingRows(client)).toBeGreaterThan(0);

    const owner = createWorker(bundle, { auth: devHeaderAuth() });
    await owner.dispatch(env as never, "t1", { sweep: true });
    expect(await pendingRows(client)).toBe(0);
  });

  it("why: a Worker whose model lacks a subscriber marks the row done without delivering to it", async () => {
    const { env, client } = await d1();
    const whole = createWorker(bundle, { auth: devHeaderAuth(), postCommit: async () => undefined });
    const call = async (worker: ReturnType<typeof createWorker>, path: string, body: unknown) => {
      const pending: Promise<unknown>[] = [];
      const res = await worker.fetch(new Request(`https://forge.test${path}`, { method: "POST", headers: { "content-type": "application/json", "x-forge-tenant": "t4", "x-forge-actor": "a" }, body: JSON.stringify(body) }), env as never, { waitUntil: (p) => void pending.push(p) });
      await Promise.all(pending);
      return (await res.json()) as { id: string };
    };
    const customer = await call(whole, "/v1/customers", { code: "C-4", name: "Four" });
    const site = await call(whole, "/v1/sites", { customer: customer.id, code: "hq", name: "HQ", timezone: "UTC" });
    // The same app without the projection that consumes Order.changes, sweeping in-process.
    const slice = structuredClone(bundle);
    for (const m of slice.ir.modules) m.projections = [];
    const sliced = createWorker(slice, { auth: devHeaderAuth() });
    await call(sliced, "/v1/orders", { customer: customer.id, site: site.id, subtotal: "10.00", tax: "1.00", requestedOn: "2026-09-20" });
    const rows = await client.execute("SELECT status, delivered FROM forge_outbox WHERE channel = '@acme/commerce/_/Order.changes'");
    expect(rows.rows.map((r) => [r["status"], r["delivered"]])).toEqual([["delivered", "[]"]]); // CustomerOrderSummary never sees the order
  });

  it("without postCommit the Worker still sweeps in-process, as before", async () => {
    const { env, client } = await d1();
    const worker = createWorker(bundle, { auth: devHeaderAuth() });
    const pending: Promise<unknown>[] = [];
    expect((await worker.fetch(create("t2"), env as never, { waitUntil: (p) => void pending.push(p) })).status).toBe(201);
    await Promise.all(pending);
    expect(await pendingRows(client)).toBe(0);
  });

  it("sweeps limits a cron invocation to the parts the Worker owns", async () => {
    const runs: string[] = [];
    const runner = defineFunction("@acme/commerce/_/RebuildOrderSummary", (d) => Effect.sync(() => (runs.push(d.ctx.tenant), { ok: true })));
    const at = Date.parse(nextOccurrence(parseRecurrence("0 3 * * *", "UTC"), new Date().toISOString())!);
    const fire = async (worker: ReturnType<typeof createWorker>, env: Record<string, unknown>) => {
      const pending: Promise<unknown>[] = [];
      await worker.scheduled({ cron: "0 3 * * *", scheduledTime: at }, env as never, { waitUntil: (p) => void pending.push(p) });
      await Promise.all(pending);
    };
    const seed = async () => {
      const { env, client } = await d1();
      const seen = createWorker(bundle, { auth: devHeaderAuth(), postCommit: async () => undefined });
      const owner = createWorker(bundle, { auth: devHeaderAuth() });
      await seen.fetch(create("t3"), env as never, { waitUntil: () => undefined });
      await owner.dispatch(env as never, "t3", { sweep: false }); // records the tenant in the schedule index only
      return { env, client };
    };

    const a = await seed();
    // A schedule-only Worker (the cron of one schedule) runs the schedule and leaves the outbox alone.
    await fire(createWorker(bundle, { auth: devHeaderAuth(), functions: [runner], sweeps: { outbox: false, workflows: false } }), a.env);
    expect(runs).toEqual(["t3"]);
    expect(await pendingRows(a.client)).toBeGreaterThan(0);

    // An outbox-only invocation delivers and runs no schedule.
    runs.length = 0;
    const b = await seed();
    await fire(createWorker(bundle, { auth: devHeaderAuth(), functions: [runner], sweeps: { schedules: false, workflows: false } }), b.env);
    expect(runs).toEqual([]);
    expect(await pendingRows(b.client)).toBe(0);
  });
});
