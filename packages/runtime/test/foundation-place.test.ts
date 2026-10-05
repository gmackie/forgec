import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { D1Storage } from "../src/adapters/d1.js";
import type { SqlExecutor, SqlStatement } from "../src/adapters/sql-executor.js";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Effect } from "effect";
import { expect, it } from "vitest";
import { Engine } from "../src/engine.js";
import { Model, type AppBundle } from "../src/model.js";
import { MemoryStorage } from "../src/adapters/memory.js";
import { testLayer } from "../src/testing.js";
const fixture = process.env["FORGE_FOUNDATION_CONSUMER"] ?? resolve(import.meta.dirname, "../../../conformance/fixtures/place-consumer");
const bundle = JSON.parse(readFileSync(resolve(fixture, "app.json"), "utf8")) as AppBundle;
const prefix = "@forgegraph/foundation/place/_/", identifiers = "@forgegraph/foundation/identifiers/_/";
const consumer = "@foundation-probe/place-consumers/_/";
const ctx = { tenant: "acme", actor: "user", requestId: "place" };
for (const adapter of ["memory", "sqlite"]) it(`${adapter}: place moves, pinned extensions and typed consumers`, async () => {
  const model = new Model(bundle), memory = new MemoryStorage(), db = new DatabaseSync(":memory:");
  db.exec(readFileSync(resolve(fixture, "d1/0001_init.sql"), "utf8"));
  const execute = (s: SqlStatement) => ({ changes: Number(db.prepare(s.sql).run(...s.params as SQLInputValue[]).changes) });
  const executor: SqlExecutor = {
    facade: "sqlite-test",
    first: async <T>(s: SqlStatement) => (db.prepare(s.sql).get(...s.params as SQLInputValue[]) ?? null) as T | null,
    all: async <T>(s: SqlStatement) => db.prepare(s.sql).all(...s.params as SQLInputValue[]) as T[],
    run: async s => execute(s),
    batch: async statements => { db.exec("BEGIN"); try { const results = statements.map(execute); db.exec("COMMIT"); return results; } catch (error) { db.exec("ROLLBACK"); throw error; } },
  };
  try {
    const engine = new Engine(model, testLayer(adapter === "memory" ? memory : new D1Storage(executor, model)));
    const call = (op: string, input: Record<string, unknown>, context = ctx) => Effect.runPromise(engine.call(op, input, context));
    const createPlace = async (name: string, parent: unknown = null) => {
      const set = await call(identifiers + "IdentifierSet.create", { label: name });
      return call(prefix + "Place.create", { identifiers: set.id, name, parent });
    };
    const facility = await createPlace("Facility"), room = await createPlace("Room", facility.id), site = await createPlace("Customer site"), warehouse = await createPlace("Warehouse");
    const f = await call(consumer + "Facility.create", { location: facility.id });
    await call(consumer + "Room.create", { facility: f.id, location: room.id });
    await expect(call(consumer + "Room.create", { facility: f.id, location: warehouse.id })).rejects.toThrow();
    await call(consumer + "WarehouseLocation.create", { location: warehouse.id, aisle: "A1" });
    const oldAddress = await call(prefix + "PlaceAddressRevision.create", { place: site.id, revision: 1, previous: null, line1: "10 Main St", locality: "Detroit", countryCode: "us" });
    await call(consumer + "CustomerSite.create", { location: site.id, address: oldAddress.id });
    const newAddress = { place: site.id, revision: 2, previous: oldAddress.id, line1: "20 Main St", locality: "Detroit", countryCode: "US" };
    const addressRace = await Promise.allSettled([call(prefix + "PlaceAddressRevision.create", newAddress), call(prefix + "PlaceAddressRevision.create", newAddress)]);
    expect(addressRace.filter(r => r.status === "fulfilled")).toHaveLength(1);
    expect((await call(prefix + "PlaceAddressRevision.get", { id: oldAddress.id })).line1).toBe("10 Main St");
    await expect(call(prefix + "PlaceAddressRevision.create", { ...newAddress, place: warehouse.id })).rejects.toThrow();
    await expect(call(prefix + "PlaceAddressRevision.delete", { id: oldAddress.id })).rejects.toThrow();
    const zone = await call(prefix + "PlaceTimezoneRevision.create", { place: site.id, revision: 1, zone: "America/Detroit" });
    await expect(call(prefix + "Place.create", { name: "Foreign", identifiers: site.identifiers }, { ...ctx, tenant: "other" })).rejects.toThrow();
    await expect(call(prefix + "Place.get", { id: site.id }, { ...ctx, tenant: "other" })).rejects.toThrow();
    await expect(call(prefix + "Place.move", { id: facility.id, expectedVersion: 1, parent: room.id })).rejects.toThrow();
    const moved = await call(prefix + "Place.move", { id: room.id, expectedVersion: 1, parent: warehouse.id });
    expect(moved).toMatchObject({ id: room.id, parent: warehouse.id, version: 2 });
    expect((await call(prefix + "Place.ancestors", { id: room.id })).items.map((v: any) => v.id)).toEqual([warehouse.id]);
    await expect(call(prefix + "Place.delete", { id: warehouse.id, expectedVersion: 1 })).rejects.toThrow();
    const a = await createPlace("A"), b = await createPlace("B");
    const moves = await Promise.allSettled([call(prefix + "Place.move", { id: a.id, expectedVersion: 1, parent: b.id }), call(prefix + "Place.move", { id: b.id, expectedVersion: 1, parent: a.id })]);
    expect(moves.filter(r => r.status === "fulfilled")).toHaveLength(1);
    const rows = await Promise.all([call(prefix + "Place.get", { id: a.id }), call(prefix + "Place.get", { id: b.id })]);
    expect(rows[0].parent === b.id && rows[1].parent === a.id).toBe(false);
    const audits = adapter === "memory" ? (await memory.dump(ctx.tenant)).audit! : db.prepare("SELECT * FROM forge_audit WHERE tenant = ? AND record_id = ?").all(ctx.tenant, room.id as string);
    expect(audits.filter((a: any) => (a.recordId ?? a.record_id) === room.id)).toHaveLength(2);
    await expect(call(prefix + "PlaceTimezoneRevision.create", { place: site.id, revision: 2, previous: zone.id, zone: "Invalid/Zone" })).rejects.toThrow();
  } finally { db.close(); }
});
