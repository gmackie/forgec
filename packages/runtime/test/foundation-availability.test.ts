import { foundation, foundationAdapters } from "./helpers/foundation.js";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { D1Storage } from "../src/adapters/d1.js";
import type { SqlExecutor, SqlStatement } from "../src/adapters/sql-executor.js";
import { Engine } from "../src/engine.js";
import { Model, type AppBundle } from "../src/model.js";
import { MemoryStorage } from "../src/adapters/memory.js";
import { testLayer } from "../src/testing.js";
import { Availability } from "../src/foundation/availability.js";
const fixture = process.env["FORGE_FOUNDATION_CONSUMER"] ?? resolve(import.meta.dirname, "../../../conformance/fixtures/availability-consumer");
const bundle = JSON.parse(readFileSync(resolve(fixture, "app.json"), "utf8")) as AppBundle;
const prefix = "@forgegraph/foundation/availability/_/";
const ctx = { tenant: "acme", actor: "user", requestId: "availability" };
const run = <A>(effect: Effect.Effect<A, unknown>) => Effect.runPromise(effect);
async function setup(adapter: string) {
  const f = await foundation("availability", adapter, true), engine = f.engine;
  const api = new Availability(engine);
  const call = (op: string, body: Record<string, unknown>) => run(engine.call(prefix + op, body, ctx));
  const query = async (id: unknown, from: string, until: string) => (await run(api.effectiveWindows(String(id), from, until, ctx))).windows;
  return { engine, api, call, query, close: f.close };
}
for (const adapter of foundationAdapters) describe(adapter, () => {
  it("F55-01/02/04: weekly overnight, date replacement, leap day and override precedence are half-open", async () => {
    const t = await setup(adapter);
    try {
      const calendar = String((await run(t.api.createCalendar("machine", ctx))).id);
      const overnight = await run(t.api.createRevision({ calendar, timezone: "UTC", weekly: [{ weekday: 1, startMinute: 1320, endMinute: 120 }] }, ctx));
      expect(await t.query(overnight.id, "2024-02-26T21:00:00Z", "2024-02-27T03:00:00Z")).toEqual([{ from: "2024-02-26T22:00:00.000Z", until: "2024-02-27T02:00:00.000Z" }]);
      const closed = await run(t.api.createRevision({ calendar, timezone: "UTC", weekly: [{ weekday: 1, startMinute: 1320, endMinute: 120 }], exceptions: [{ date: "2024-02-27", windows: [] }] }, ctx));
      expect(await t.query(closed.id, "2024-02-26T21:00:00Z", "2024-02-27T03:00:00Z")).toEqual([{ from: "2024-02-26T22:00:00.000Z", until: "2024-02-27T00:00:00.000Z" }]);
      const leap = await run(t.api.createRevision({ calendar, timezone: "UTC", weekly: [{ weekday: 4, startMinute: 540, endMinute: 1020 }], exceptions: [{ date: "2024-02-29", windows: [{ startMinute: 600, endMinute: 720 }] }], overrides: [{ from: "2024-02-29T10:30:00Z", until: "2024-02-29T11:00:00Z", available: false, priority: 1 }, { from: "2024-02-29T10:45:00Z", until: "2024-02-29T11:15:00Z", available: true, priority: 2 }] }, ctx));
      expect(await t.query(leap.id, "2024-02-29T09:00:00Z", "2024-02-29T17:00:00Z")).toEqual([{ from: "2024-02-29T10:00:00.000Z", until: "2024-02-29T10:30:00.000Z" }, { from: "2024-02-29T10:45:00.000Z", until: "2024-02-29T12:00:00.000Z" }]);
      expect(await t.query(overnight.id, "2024-02-27T02:00:00Z", "2024-02-27T03:00:00Z")).toEqual([]);
    } finally { await t.close(); }
  });
  it("F55-03: DST gaps contribute no instants; both fold occurrences retain wall-minute membership", async () => {
    const t = await setup(adapter);
    try {
      const calendar = String((await run(t.api.createCalendar("worker", ctx))).id);
      const spring = await run(t.api.createRevision({ calendar, timezone: "America/New_York", weekly: [{ weekday: 0, startMinute: 90, endMinute: 210 }] }, ctx));
      expect(await t.query(spring.id, "2024-03-10T05:00:00Z", "2024-03-10T09:00:00Z")).toEqual([{ from: "2024-03-10T06:30:00.000Z", until: "2024-03-10T07:30:00.000Z" }]);
      const fall = await run(t.api.createRevision({ calendar, timezone: "America/New_York", weekly: [{ weekday: 0, startMinute: 90, endMinute: 150 }] }, ctx));
      expect(await t.query(fall.id, "2024-11-03T04:00:00Z", "2024-11-03T09:00:00Z")).toEqual([{ from: "2024-11-03T05:30:00.000Z", until: "2024-11-03T06:00:00.000Z" }, { from: "2024-11-03T06:30:00.000Z", until: "2024-11-03T07:30:00.000Z" }]);
      await expect(run(new Availability(t.engine, { timezoneDataVersion: "different-tzdb" }).effectiveWindows(String(fall.id), "2024-11-03T04:00:00Z", "2024-11-03T09:00:00Z", ctx))).rejects.toMatchObject({ detail: expect.stringContaining("different timezone database") });
    } finally { await t.close(); }
  });
  it("F55-04/06: pinned revisions survive later rules, hostile seals fail closed, typed attachments stay tenant-owned", async () => {
    const t = await setup(adapter);
    try {
      const calendar = String((await run(t.api.createCalendar("facility", ctx))).id);
      const repository = await run(t.engine.call("@forgegraph/foundation/specification/_/Repository.create", { key: "calendar-source", provider: "git", locator: "https://example.test/calendars" }, ctx));
      const origin = await run(t.engine.call("@forgegraph/foundation/specification/_/SpecificationPin.create", { repository: repository.id, anchor: "@example/work/_/Hours", revision: "a".repeat(40) }, ctx));
      const input = { calendar, timezone: "UTC", weekly: [{ weekday: 1, startMinute: 600, endMinute: 660 }], origin: String(origin.id) };
      const pin = await run(t.api.createRevision(input, { ...ctx, idempotencyKey: "revision-one" }));
      expect(pin.origin).toBe(origin.id);
      expect((await run(t.api.createRevision(input, { ...ctx, idempotencyKey: "revision-one" }))).id).toBe(pin.id);
      await expect(t.call("AvailabilityRule.create", { ruleSet: pin.ruleSet, ordinal: 0, kind: "Weekly", weekday: 1, localDate: null, startMinute: 0, endMinute: 1440, available: true, from: null, until: null, priority: null })).rejects.toThrow();
      const firstRule = await t.call("AvailabilityRule.find.byRuleSetOrdinal", { params: { ruleSet: pin.ruleSet, ordinal: 0 } });
      for (const operation of ["update", "delete"]) await expect(t.call(`AvailabilityRule.${operation}`, { id: firstRule.id, patch: { endMinute: 1440 } })).rejects.toThrow();
      const before = await t.query(pin.id, "2024-02-26T00:00:00Z", "2024-02-27T00:00:00Z");
      await run(t.api.createRevision({ ...input, weekly: [] }, ctx));
      await t.call("AvailabilityRule.create", { ruleSet: pin.ruleSet, ordinal: 1, kind: "Weekly", weekday: 1, localDate: null, startMinute: 0, endMinute: 1440, available: true, from: null, until: null, priority: null });
      expect(await t.query(pin.id, "2024-02-26T00:00:00Z", "2024-02-27T00:00:00Z")).toEqual(before);
      for (const operation of ["update", "delete"]) await expect(t.call(`AvailabilityCalendarRevision.${operation}`, { id: pin.id, patch: { timezone: "UTC" } })).rejects.toThrow();
      const bad = await t.call("AvailabilityCalendarRevision.create", { calendar, ruleSet: pin.ruleSet, ruleCount: 2, rulesDigest: "0".repeat(64), timezone: "UTC", timezoneDataVersion: pin.timezoneDataVersion, origin: null });
      await expect(t.query(bad.id, "2024-02-26T00:00:00Z", "2024-02-27T00:00:00Z")).rejects.toMatchObject({ detail: expect.stringContaining("digest mismatch") });
      const missing = await t.call("AvailabilityCalendarRevision.create", { calendar, ruleSet: pin.ruleSet, ruleCount: 3, rulesDigest: "0".repeat(64), timezone: "UTC", timezoneDataVersion: pin.timezoneDataVersion, origin: null });
      await expect(t.query(missing.id, "2024-02-26T00:00:00Z", "2024-02-27T00:00:00Z")).rejects.toThrow();
      for (const [name, key] of [["WorkerAvailability", "workerKey"], ["MachineAvailability", "machineKey"], ["FacilityAvailability", "facilityKey"]]) {
        const record = await run(t.engine.call(`@example/availability/_/${name}.create`, { [key!]: name, calendar, revision: pin.id }, ctx));
        expect(record.revision).toBe(pin.id);
      }
      await expect(run(t.api.effectiveWindows(String(pin.id), "2024-02-26T00:00:00Z", "2024-02-27T00:00:00Z", { ...ctx, tenant: "other" }))).rejects.toThrow();
    } finally { await t.close(); }
  });
  it("rejects unsupported recurrence, invalid dates/zones, ambiguous overrides and excessive queries", async () => {
    const t = await setup(adapter);
    try {
      const calendar = String((await run(t.api.createCalendar("bounded", ctx))).id);
      const base = { calendar, timezone: "UTC", weekly: [] };
      for (const input of [{ ...base, recurrence: "monthly" }, { ...base, timezone: "Mars/Olympus" }, { ...base, exceptions: [{ date: "2023-02-29", windows: [] }] }, { ...base, weekly: [{ weekday: 1, startMinute: 600, endMinute: 600 }] }, { ...base, weekly: Array.from({ length: 129 }, () => ({ weekday: 1, startMinute: 1, endMinute: 2 })) }, { ...base, overrides: [{ from: "2024-01-01T00:00:00Z", until: "2024-01-01T01:00:00Z", available: true, priority: 1 }, { from: "2024-01-01T00:30:00Z", until: "2024-01-01T01:30:00Z", available: false, priority: 1 }] }]) await expect(run(t.api.createRevision(input, ctx))).rejects.toThrow();
      await expect(run(t.api.createRevision({ ...base, origin: "missing-pin", weekly: [{ weekday: 1, startMinute: 0, endMinute: 60 }] }, ctx))).rejects.toThrow();
      const revisions = await t.call("AvailabilityCalendarRevision.list.byCalendar", { params: { calendar } });
      expect(revisions.items).toEqual([]);
      const pin = await run(t.api.createRevision(base, ctx));
      await expect(t.query(pin.id, "2024-01-01T00:00:00Z", "2024-02-02T00:00:00Z")).rejects.toMatchObject({ detail: expect.stringContaining("31 days") });
      await expect(t.query(pin.id, "2024-01-01T00:00:01Z", "2024-01-01T01:00:00Z")).rejects.toMatchObject({ detail: expect.stringContaining("whole minutes") });
    } finally { await t.close(); }
  });
});
