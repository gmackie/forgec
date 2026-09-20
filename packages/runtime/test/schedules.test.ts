/**
 * Schedules (§19): a canonical recurrence IR (never a raw cron string forwarded
 * to a provider), occurrence identity = schedule + intended instant, missed-run
 * catch-up bounded, overlap policy, and the same occurrence set from both
 * provider tick shapes. UTC first; local-time schedules with DST fixtures.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Effect } from "effect";
import { beforeEach, describe, expect, it } from "vitest";
import { Model, type AppBundle } from "../src/model.js";
import { Engine, type CallContext } from "../src/engine.js";
import { MemoryStorage } from "../src/adapters/memory.js";
import { testLayer } from "../src/testing.js";
import { defineFunction } from "../src/functions.js";
import { nextOccurrence, occurrencesBetween, parseRecurrence } from "../src/schedules.js";

const bundle = JSON.parse(readFileSync(resolve(import.meta.dirname, "..", "..", "..", "conformance", "fixtures", "acme.app.json"), "utf8")) as AppBundle;
const model = new Model(bundle);
const S = "@acme/commerce/_/NightlyReconciliation";

describe("recurrence IR", () => {
  it("parses five-field cron into explicit sets with documented weekday numbering (0 and 7 = Sunday)", () => {
    const r = parseRecurrence("0 3 * * *", "UTC");
    expect(r).toMatchObject({ kind: "cron", minutes: [0], hours: [3], daysOfMonth: "any", months: "any", daysOfWeek: "any", timezone: "UTC" });
    expect(parseRecurrence("*/15 9-17 * * 1-5", "UTC")).toMatchObject({ minutes: [0, 15, 30, 45], hours: [9, 10, 11, 12, 13, 14, 15, 16, 17], daysOfWeek: [1, 2, 3, 4, 5] });
    expect(parseRecurrence("0 0 1 * 7", "UTC").daysOfWeek).toEqual([0]);
    expect(() => parseRecurrence("0 3 * *", "UTC")).toThrow(/five fields/);
    expect(() => parseRecurrence("0 25 * * *", "UTC")).toThrow(/hour/);
  });

  it("day-of-month and day-of-week both restricted means OR (POSIX/Vixie), stated explicitly in the IR", () => {
    const r = parseRecurrence("0 0 15 * 1", "UTC");
    expect(r.dayCombination).toBe("or");
    // 2026-06-15 is a Monday: matches by both; 2026-06-16 (Tue) does not; 2026-06-22 (Mon) matches by weekday.
    expect(nextOccurrence(r, "2026-06-14T00:00:00Z")).toBe("2026-06-15T00:00:00.000Z");
    expect(nextOccurrence(r, "2026-06-15T00:00:00Z")).toBe("2026-06-22T00:00:00.000Z");
  });

  it("computes the next occurrence strictly after an instant, in UTC", () => {
    const r = parseRecurrence("0 3 * * *", "UTC");
    expect(nextOccurrence(r, "2026-09-20T02:59:59Z")).toBe("2026-09-20T03:00:00.000Z");
    expect(nextOccurrence(r, "2026-09-20T03:00:00Z")).toBe("2026-09-21T03:00:00.000Z");
    expect(occurrencesBetween(r, "2026-09-20T00:00:00Z", "2026-09-23T00:00:00Z")).toEqual(["2026-09-20T03:00:00.000Z", "2026-09-21T03:00:00.000Z", "2026-09-22T03:00:00.000Z"]);
  });

  it("local-time schedules: DST spring-forward skips the nonexistent local time once; fall-back does not repeat", () => {
    const r = parseRecurrence("30 2 * * *", "America/New_York");
    // 2026-03-08: 02:30 local does not exist (clocks jump 02:00 -> 03:00). The occurrence is skipped, not shifted.
    expect(occurrencesBetween(r, "2026-03-07T00:00:00Z", "2026-03-10T00:00:00Z")).toEqual(["2026-03-07T07:30:00.000Z", "2026-03-09T06:30:00.000Z"]);
    // 2026-11-01: 01:30 local happens twice; a 01:30 schedule fires once (first occurrence, EDT).
    const r2 = parseRecurrence("30 1 * * *", "America/New_York");
    expect(occurrencesBetween(r2, "2026-10-31T12:00:00Z", "2026-11-02T12:00:00Z")).toEqual(["2026-11-01T05:30:00.000Z", "2026-11-02T06:30:00.000Z"]);
  });
});

describe("occurrence ledger", () => {
  let storage: MemoryStorage;
  let engine: Engine;
  let runs: string[];
  const ctx: CallContext = { tenant: "acme", actor: "scheduler", requestId: "tick" };
  beforeEach(() => {
    storage = new MemoryStorage();
    runs = [];
    engine = new Engine(model, testLayer(storage, { start: "2026-09-20T02:00:00.000Z" }), {
      functions: [defineFunction("@acme/commerce/_/RebuildOrderSummary", (d) => Effect.sync(() => { runs.push(String((d.input as { occurrence: string }).occurrence)); return { ok: true }; }))],
    });
  });
  const tick = (now: string) => Effect.runPromise(engine.schedules.tick("acme", now));

  it("a tick runs each due occurrence once, identified by schedule + intended instant, not delivery time", async () => {
    const r1 = await tick("2026-09-20T03:00:04Z"); // provider delivered 4s late
    expect(r1).toEqual([{ source: S, occurrence: "2026-09-20T03:00:00.000Z", outcome: "ran" }]);
    expect(runs).toEqual(["2026-09-20T03:00:00.000Z"]);
    const r2 = await tick("2026-09-20T03:00:30Z"); // duplicate tick (retry) for the same occurrence
    expect(r2).toEqual([{ source: S, occurrence: "2026-09-20T03:00:00.000Z", outcome: "duplicate" }]);
    expect(runs).toHaveLength(1);
  });

  it("missed occurrences are caught up in order, bounded by the catch-up window", async () => {
    await tick("2026-09-20T03:00:00Z");
    // the platform was down for three days; catch-up runs the missed ones (bounded to 3 by policy), oldest first
    const r = await tick("2026-09-24T03:00:00Z");
    expect(r.map((x) => x.occurrence)).toEqual(["2026-09-22T03:00:00.000Z", "2026-09-23T03:00:00.000Z", "2026-09-24T03:00:00.000Z"]);
    expect(r.every((x) => x.outcome === "ran")).toBe(true);
    const status = await Effect.runPromise(engine.schedules.status("acme"));
    expect(status).toEqual([{ source: S, lastOccurrence: "2026-09-24T03:00:00.000Z", next: "2026-09-25T03:00:00.000Z", skipped: ["2026-09-21T03:00:00.000Z"] }]);
  });

  it("overlap policy `skip`: an occurrence whose predecessor is still running is recorded as skipped, never queued", async () => {
    let release!: () => void;
    const gate = new Promise<void>((res) => (release = res));
    engine = new Engine(model, testLayer(storage, { start: "2026-09-20T02:00:00.000Z" }), {
      functions: [defineFunction("@acme/commerce/_/RebuildOrderSummary", () => Effect.promise(async () => { await gate; return { ok: true }; }))],
    });
    const first = tick("2026-09-20T03:00:00Z");
    await new Promise((r) => setTimeout(r, 10));
    const second = await tick("2026-09-21T03:00:00Z");
    expect(second).toEqual([{ source: S, occurrence: "2026-09-21T03:00:00.000Z", outcome: "skipped-overlap" }]);
    release();
    expect((await first)[0]!.outcome).toBe("ran");
  });

  it("a failed occurrence is recorded as failed with its error; a retry of the same tick re-runs it", async () => {
    let fail = true;
    engine = new Engine(model, testLayer(storage, { start: "2026-09-20T02:00:00.000Z" }), {
      functions: [defineFunction("@acme/commerce/_/RebuildOrderSummary", (d) => (fail ? d.fail("Boom") : Effect.succeed({ ok: true })))],
    });
    const r1 = await tick("2026-09-20T03:00:00Z");
    expect(r1[0]).toMatchObject({ outcome: "failed" });
    fail = false;
    const r2 = await tick("2026-09-20T03:00:10Z");
    expect(r2[0]).toMatchObject({ outcome: "ran" });
  });
});
