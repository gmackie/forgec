/**
 * M11 runtime (PAR-093/094/097): subject location through declared bindings
 * only (no cascade proposals), and blob inspection verdicts that never
 * declassify: a failed or absent inspection keeps content restricted.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Cause, Effect } from "effect";
import { beforeEach, describe, expect, it } from "vitest";
import { Model, type AppBundle } from "../src/model.js";
import { Engine, type CallContext } from "../src/engine.js";
import { ForgeError } from "../src/errors.js";
import { MemoryStorage } from "../src/adapters/memory.js";
import { MemoryObjectStore } from "../src/adapters/memory-objects.js";
import { testLayer } from "../src/testing.js";
import { externals, functions } from "../../../examples/acme/impl/index.js";

const fixture = (name: string) => JSON.parse(readFileSync(resolve(import.meta.dirname, "..", "..", "..", "conformance", "fixtures", name), "utf8")) as AppBundle;
const ctx: CallContext = { tenant: "t", actor: "operator", requestId: "req" };
const run = <A>(e: Effect.Effect<A, unknown, never>) => Effect.runPromise(e as Effect.Effect<A, never, never>);
const fails = async (e: Effect.Effect<unknown, unknown, never>) => { const x = await Effect.runPromiseExit(e as Effect.Effect<unknown, never, never>); if (x._tag === "Success") throw new Error("expected failure"); const s = Cause.squash(x.cause); if (s instanceof ForgeError) return s; throw s; };

describe("subject location (education fixture)", () => {
  const E = "@fixtures/education/_";
  let engine: Engine;
  beforeEach(() => { engine = new Engine(new Model(fixture("education.app.json")), testLayer(new MemoryStorage())); });

  it("locates a student's records through declared bindings; the shared guardian is reported as linked, never cascaded", async () => {
    const g = await run(engine.call(`${E}/Guardian.create`, { name: "Pat", email: "pat@example.com" }, ctx));
    const s1 = await run(engine.call(`${E}/Student.create`, { name: "Ada", guardian: g.id }, ctx));
    const s2 = await run(engine.call(`${E}/Student.create`, { name: "Bo", guardian: g.id }, ctx));
    await run(engine.call(`${E}/AttendanceRecord.create`, { student: s1.id, date: "2026-09-01", status: "Present" }, ctx));
    await run(engine.call(`${E}/AttendanceRecord.create`, { student: s1.id, date: "2026-09-02", status: "Absent", healthNote: "flu" }, ctx));
    await run(engine.call(`${E}/AttendanceRecord.create`, { student: s2.id, date: "2026-09-01", status: "Present" }, ctx));
    const report = await run(engine.call(`${E}/admin.subjects.locate`, { kind: "person", resource: `${E}/Student`, id: s1.id }, ctx));
    expect(report.subject).toEqual({ kind: "person", resource: `${E}/Student`, id: s1.id });
    // the student's own record plus records bound `from: student`
    expect(report.records.map((r: any) => [r.resource.split("/").pop(), r.count])).toEqual([["Student", 1], ["AttendanceRecord", 2]]);
    // linked subjects are reported with the linking field, with no proposal to delete them
    expect(report.linked).toEqual([{ resource: `${E}/Guardian`, id: g.id, via: "guardian", kind: "person", sharedWith: 1 }]);
    expect(report.cascade).toEqual([]);
    // an organization is never a person subject: locating by a non-subject resource is refused
    expect((await fails(engine.call(`${E}/admin.subjects.locate`, { kind: "organization", resource: `${E}/Guardian`, id: g.id }, ctx))).code).toBe("ValidationFailed");
  });
});

describe("blob inspection verdicts (Acme)", () => {
  const A = "@acme/commerce/_";
  let engine: Engine;
  let objects: MemoryObjectStore;
  let ids: { customer: string; site: string; order: string };
  beforeEach(async () => {
    objects = new MemoryObjectStore();
    engine = new Engine(new Model(fixture("acme.app.json")), testLayer(new MemoryStorage(), { objects }), { functions, externals });
    const c = await run(engine.call(`${A}/Customer.create`, { code: "INS", name: "I" }, ctx));
    const s = await run(engine.call(`${A}/Site.create`, { customer: c.id, code: "hq", name: "HQ", timezone: "UTC" }, ctx));
    const o = await run(engine.call(`${A}/Order.create`, { customer: c.id, site: s.id, subtotal: "1.00", tax: "0.00", requestedOn: "2026-09-20" }, ctx));
    ids = { customer: c.id, site: s.id, order: o.id };
  });
  const upload = async () => {
    const d = await run(engine.call(`${A}/OrderDocument.create`, { order: ids.order, kind: "quote", label: "Q1" }, ctx));
    const begun = await run(engine.call(`${A}/OrderDocument.beginUpload`, { id: d.id, expectedVersion: 1, mediaType: "image/png", byteCount: 5 }, ctx));
    await objects.simulateUpload(begun.upload.url, new TextEncoder().encode("hello"), "image/png");
    const ready = await run(engine.call(`${A}/OrderDocument.finalizeUpload`, { id: d.id, expectedVersion: 2 }, ctx));
    return ready;
  };
  it("a sealed object is `pending` until inspected; a failed inspection is `review-required`; only `allowed` serves downloads", async () => {
    const doc = await upload();
    expect(doc.inspection).toEqual({ state: "pending", generation: 1 });
    // lenient profile (edition 2026): pending content is served; the strict profile (edition 2027) refuses it
    expect((await run(engine.call(`${A}/OrderDocument.download`, { id: doc.id }, ctx))).method).toBe("GET");
    engine.governance.strictInspection = true;
    expect((await fails(engine.call(`${A}/OrderDocument.download`, { id: doc.id }, ctx))).code).toBe("InspectionPending");
    // a detector failure never clears the file
    const failed = await run(engine.call(`${A}/admin.inspect`, { resource: `${A}/OrderDocument`, id: doc.id, digest: doc.digest, verdict: "failed", detector: "scanner@1", detail: "timeout" }, ctx));
    expect(failed.inspection).toMatchObject({ state: "review-required", detector: "scanner@1" });
    expect((await fails(engine.call(`${A}/OrderDocument.download`, { id: doc.id }, ctx))).code).toBe("InspectionPending");
    // a verdict must bind the sealed digest: a stale digest is rejected
    expect((await fails(engine.call(`${A}/admin.inspect`, { resource: `${A}/OrderDocument`, id: doc.id, digest: "sha256:0", verdict: "allowed", detector: "scanner@1" }, ctx))).code).toBe("ValidationFailed");
    const allowed = await run(engine.call(`${A}/admin.inspect`, { resource: `${A}/OrderDocument`, id: doc.id, digest: doc.digest, verdict: "allowed", detector: "scanner@1" }, ctx));
    expect(allowed.inspection.state).toBe("allowed");
    expect((await run(engine.call(`${A}/OrderDocument.download`, { id: doc.id }, ctx))).method).toBe("GET");
    // quarantine is terminal for that generation
    const q = await run(engine.call(`${A}/admin.inspect`, { resource: `${A}/OrderDocument`, id: doc.id, digest: doc.digest, verdict: "quarantined", detector: "scanner@1", detail: "malware" }, ctx));
    expect(q.inspection.state).toBe("quarantined");
    expect((await fails(engine.call(`${A}/OrderDocument.download`, { id: doc.id }, ctx))).code).toBe("InspectionBlocked");
  });
});
