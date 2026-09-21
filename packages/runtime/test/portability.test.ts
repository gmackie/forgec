/**
 * Provider switching (§22): canonical export of authoritative resources (ids,
 * revisions, stored records, blob manifests), import onto another store
 * behind a write fence with identities and revisions preserved, and a
 * verification report (counts, canonical hashes, references, revisions)
 * that must agree before traffic moves.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Effect } from "effect";
import { beforeEach, describe, expect, it } from "vitest";
import { Model, type AppBundle } from "../src/model.js";
import { Engine, type CallContext } from "../src/engine.js";
import { MemoryStorage } from "../src/adapters/memory.js";
import { testLayer } from "../src/testing.js";
import { externals, functions } from "../../../examples/acme/impl/index.js";

const bundle = JSON.parse(readFileSync(resolve(import.meta.dirname, "..", "..", "..", "conformance", "fixtures", "acme.app.json"), "utf8")) as AppBundle;
const model = new Model(bundle);
const ctx: CallContext = { tenant: "acme", actor: "operator", requestId: "req" };
const run = <A>(e: Effect.Effect<A, unknown, never>) => Effect.runPromise(e as Effect.Effect<A, never, never>);
const P = "@acme/commerce/_/admin";

let source: Engine;
let target: Engine;
beforeEach(async () => {
  source = new Engine(model, testLayer(new MemoryStorage(), { runId: "a" }), { functions, externals });
  target = new Engine(model, testLayer(new MemoryStorage(), { runId: "b", start: "2027-01-01T00:00:00.000Z" }), { functions, externals });
  const c = await run(source.call("@acme/commerce/_/Customer.create", { code: "ACME", name: "A" }, ctx));
  const s = await run(source.call("@acme/commerce/_/Site.create", { customer: c.id, code: "hq", name: "HQ", timezone: "UTC" }, ctx));
  const o = await run(source.call("@acme/commerce/_/Order.create", { customer: c.id, site: s.id, subtotal: "10.00", tax: "1.00", requestedOn: "2026-09-20" }, ctx));
  await run(source.call("@acme/commerce/_/Order.update", { id: o.id, expectedVersion: 1, patch: { subtotal: "12.00" } }, ctx));
  const gone = await run(source.call("@acme/commerce/_/Customer.create", { code: "OLD", name: "Old" }, ctx));
  await run(source.call("@acme/commerce/_/Customer.delete", { id: gone.id, expectedVersion: 1 }, ctx));
});

describe("canonical export", () => {
  it("exports every authoritative record with id, version and soft-delete state, plus a canonical hash per resource and a manifest", async () => {
    const snap = await run(source.call(`${P}.export`, {}, ctx));
    expect(snap).toMatchObject({ version: "export/1", package: "@acme/commerce", tenant: "acme" });
    expect(Object.keys(snap.resources).sort()).toContain("@acme/commerce/_/Customer");
    const customers = snap.resources["@acme/commerce/_/Customer"];
    expect(customers.count).toBe(2); // soft-deleted rows are authoritative state too
    expect(customers.records.map((r: any) => [r.code, r.version, r.deletedAt !== null])).toEqual([["ACME", 1, false], ["OLD", 2, true]]);
    expect(customers.hash).toMatch(/^[0-9a-f]{64}$/);
    // stored (authoritative) shape: derived fields such as `total` are recomputed on read, never exported
    expect(snap.resources["@acme/commerce/_/Order"].records[0]).toMatchObject({ version: 2, subtotal: "12.00" });
    expect(snap.resources["@acme/commerce/_/Order"].records[0].total).toBeUndefined();
    expect(snap.manifest).toMatchObject({ contractsVersion: bundle.contracts.version, buildHash: bundle.buildHash });
  });
});

describe("import behind a fence", () => {
  it("imports preserving ids and revisions, refuses writes while fenced, and verifies counts and hashes on both sides", async () => {
    const snap = await run(source.call(`${P}.export`, {}, ctx));
    const fence = await run(target.call(`${P}.fence`, { on: true }, ctx));
    expect(fence).toEqual({ fenced: true });
    const blocked = await Effect.runPromiseExit(target.call("@acme/commerce/_/Customer.create", { code: "NEW", name: "N" }, ctx));
    expect(blocked._tag).toBe("Failure");
    const report = await run(target.call(`${P}.import`, { snapshot: snap }, ctx));
    expect(report).toMatchObject({ imported: { "@acme/commerce/_/Customer": 2, "@acme/commerce/_/Site": 1, "@acme/commerce/_/Order": 1 } });
    const verify = await run(target.call(`${P}.verify`, { snapshot: snap }, ctx));
    expect(verify.ok).toBe(true);
    expect(verify.resources["@acme/commerce/_/Order"]).toMatchObject({ expectedCount: 1, actualCount: 1, hashMatch: true, references: { checked: 2, missing: 0 } });
    await run(target.call(`${P}.fence`, { on: false }, ctx));
    // identities and revisions carried over: the same optimistic update works on the new provider
    const order = snap.resources["@acme/commerce/_/Order"].records[0];
    const updated = await run(target.call("@acme/commerce/_/Order.update", { id: order.id, expectedVersion: 2, patch: { tax: "2.00" } }, ctx));
    expect(updated).toMatchObject({ id: order.id, version: 3, total: "14.00" });
    // unique claims were rebuilt: the migrated code is taken
    const dup = await Effect.runPromiseExit(target.call("@acme/commerce/_/Customer.create", { code: "ACME", name: "Again" }, ctx));
    expect(dup._tag).toBe("Failure");
    // a re-run of the same import is idempotent
    expect(await run(target.call(`${P}.import`, { snapshot: snap }, ctx))).toMatchObject({ imported: { "@acme/commerce/_/Customer": 0 }, skipped: { "@acme/commerce/_/Customer": 2 } });
  });

  it("verification reports a divergence when the target was modified after the export", async () => {
    const snap = await run(source.call(`${P}.export`, {}, ctx));
    await run(target.call(`${P}.import`, { snapshot: snap }, ctx));
    const c = snap.resources["@acme/commerce/_/Customer"].records[0];
    await run(target.call("@acme/commerce/_/Customer.update", { id: c.id, expectedVersion: 1, patch: { name: "Changed" } }, ctx));
    const verify = await run(target.call(`${P}.verify`, { snapshot: snap }, ctx));
    expect(verify.ok).toBe(false);
    expect(verify.resources["@acme/commerce/_/Customer"]).toMatchObject({ hashMatch: false, revisionMismatches: [{ id: c.id, expected: 1, actual: 2 }] });
  });

  it("refuses a snapshot from a different package or contracts version", async () => {
    const snap = await run(source.call(`${P}.export`, {}, ctx));
    const exit = await Effect.runPromiseExit(target.call(`${P}.import`, { snapshot: { ...snap, manifest: { ...snap.manifest, contractsVersion: "contracts/0" } } }, ctx));
    expect(exit._tag).toBe("Failure");
  });
});
