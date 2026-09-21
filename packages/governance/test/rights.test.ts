/**
 * M19 (PAR-156..162): subject rights over declared data flows. Plans preserve
 * other subjects and holds; unknown egress blocks a complete verdict; the
 * suppression ledger stops delayed events and restores from resurrecting
 * erased data; external acceptance is not verified completion; revocation
 * during an export stops disclosure; the ledger token stays classified.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Cause, Effect } from "effect";
import { beforeEach, describe, expect, it } from "vitest";
import { Engine, ForgeError, MemoryStorage, Model, SUPPRESSION_CLASS, testLayer, type AppBundle, type CallContext } from "@forge/runtime";
import { planDisposition } from "../src/rights-planner.js";
import { RightsExecutor } from "../src/rights-executor.js";

const bundle = JSON.parse(readFileSync(resolve(import.meta.dirname, "..", "..", "..", "conformance", "fixtures", "education.app.json"), "utf8")) as AppBundle;
const E = "@fixtures/education/_";
const ctx: CallContext = { tenant: "school", actor: "dpo", requestId: "r" };
const run = <A>(e: Effect.Effect<A, unknown, never>) => Effect.runPromise(e as Effect.Effect<A, never, never>);
const fails = async (e: Effect.Effect<unknown, unknown, never>) => { const x = await Effect.runPromiseExit(e as Effect.Effect<unknown, never, never>); if (x._tag === "Success") throw new Error("expected failure, got " + JSON.stringify(x.value)); const s = Cause.squash(x.cause); if (s instanceof ForgeError) return s; throw s; };
const allow = { check: async () => ({ allowed: true }) };

describe("subject rights", () => {
  let engine: Engine;
  let storage: MemoryStorage;
  let g: { id: string };
  let s1: { id: string };
  let s2: { id: string };
  beforeEach(async () => {
    storage = new MemoryStorage();
    engine = new Engine(new Model(bundle), testLayer(storage));
    g = await run(engine.call(`${E}/Guardian.create`, { name: "Pat", email: "pat@example.com" }, ctx));
    s1 = await run(engine.call(`${E}/Student.create`, { name: "Ada", guardian: g.id }, ctx));
    s2 = await run(engine.call(`${E}/Student.create`, { name: "Bo", guardian: g.id }, ctx));
    await run(engine.call(`${E}/AttendanceRecord.create`, { student: s1.id, date: "2026-09-01", status: "Present" }, ctx));
    await run(engine.call(`${E}/AttendanceRecord.create`, { student: s1.id, date: "2026-09-02", status: "Absent", healthNote: "flu" }, ctx));
    await run(engine.call(`${E}/AttendanceRecord.create`, { student: s2.id, date: "2026-09-01", status: "Present" }, ctx));
  });

  it("PAR-156: erasing one student removes only that student's data; the shared guardian and the other student survive; holds are honoured", async () => {
    const plan = await planDisposition(engine, { subject: { kind: "person", resource: `${E}/Student`, id: s1.id }, disposition: "erasure", ctx });
    expect(plan.items.map((i) => [i.resource.split("/").pop(), i.action, i.count])).toEqual([["Student", "delete-record", 1], ["AttendanceRecord", "erase-fields", 2]]);
    expect(plan.items[1]!.fields).toEqual(["healthNote"]); // structural fields (student, date, status) are kept
    expect(plan.preserved).toEqual([{ resource: `${E}/Guardian`, id: g.id, reason: expect.stringMatching(/another subject's data is never erased/) }]);
    expect(plan.verdict).toBe("complete");
    const exec = new RightsExecutor(engine, { retention: { stagedArtifacts: "delete-on-revocation" }, chunkSize: 1 });
    await exec.open(ctx, { job: "erase-ada", plan, approval: { by: "dpo", at: "2026-09-21T00:00:00Z" } });
    const report = await exec.advance(ctx, "erase-ada", allow);
    expect(report).toMatchObject({ state: "completed", verdict: "complete", held: [], pending: [] });
    // Ada's record is gone from ordinary reads; her attendance rows keep their structure but lost the health note
    expect((await fails(engine.call(`${E}/Student.get`, { id: s1.id }, ctx))).code).toBe("NotFound");
    const rows = await run(engine.call(`${E}/AttendanceRecord.list.byStudent`, { params: { student: s1.id } }, ctx));
    expect(rows.items).toHaveLength(2);
    expect(rows.items.every((r: { healthNote: unknown; status: string }) => r.healthNote === null && typeof r.status === "string")).toBe(true);
    // the guardian and Bo are untouched
    expect((await run(engine.call(`${E}/Guardian.get`, { id: g.id }, ctx))).email).toBe("pat@example.com");
    expect((await run(engine.call(`${E}/Student.get`, { id: s2.id }, ctx))).name).toBe("Bo");
    // a lawful hold on attendance records keeps them and the verdict is partial, never complete
    const held = await planDisposition(engine, { subject: { kind: "person", resource: `${E}/Student`, id: s2.id }, disposition: "erasure", holds: [{ id: "litigation-7", resource: `${E}/AttendanceRecord`, reason: "pending case" }], ctx });
    expect(held.items.find((i) => i.resource.endsWith("AttendanceRecord"))).toMatchObject({ action: "preserve", hold: "litigation-7" });
    expect(held.verdict).toBe("partial");
  });

  it("PAR-157: unmodeled egress or an external sink without an erasure adapter blocks a complete verdict", async () => {
    const lineage = engine.model.bundle.lineage as { operations: { operation: string; resource?: string; externalSinks: string[]; coverage: string }[] };
    const op = lineage.operations.find((o) => o.resource === `${E}/AttendanceRecord`)!;
    const original = { sinks: op.externalSinks, coverage: op.coverage };
    op.externalSinks = ["vendor:analytics"];
    op.coverage = "handwritten";
    try {
      const plan = await planDisposition(engine, { subject: { kind: "person", resource: `${E}/Student`, id: s1.id }, disposition: "erasure", ctx });
      expect(plan.verdict).toBe("unknown");
      expect(plan.unknowns.map((u) => u.kind)).toEqual(expect.arrayContaining(["unmodeled-egress", "external-sink-without-adapter"]));
      // with a registered processor that has an adapter, the sink becomes a tracked external obligation
      const tracked = await planDisposition(engine, { subject: { kind: "person", resource: `${E}/Student`, id: s1.id }, disposition: "erasure", processors: [{ id: "analytics-vendor", sinks: ["vendor:analytics"], erasureAdapter: true }], ctx });
      expect(tracked.external).toEqual([{ processor: "analytics-vendor", sinks: ["vendor:analytics"], state: "not-requested", erasureAdapter: true }]);
      expect(tracked.unknowns.map((u) => u.kind)).toEqual(["unmodeled-egress"]); // the handwritten coverage still needs review
    } finally {
      op.externalSinks = original.sinks;
      op.coverage = original.coverage;
    }
  });

  it("PAR-158: a delayed event from before the erasure cannot recreate the subject's data", async () => {
    const plan = await planDisposition(engine, { subject: { kind: "person", resource: `${E}/Student`, id: s1.id }, disposition: "erasure", ctx });
    const exec = new RightsExecutor(engine, { retention: { stagedArtifacts: "delete-on-revocation" } });
    await exec.open(ctx, { job: "erase-ada", plan, approval: { by: "dpo", at: "2026-09-21T00:00:00Z" } });
    await exec.advance(ctx, "erase-ada", allow);
    // a queued attendance create for Ada (produced before the erasure) is delivered now: refused, nothing recreated
    const late = await fails(engine.call(`${E}/AttendanceRecord.create`, { student: s1.id, date: "2026-08-30", status: "Present", healthNote: "old note" }, { ...ctx, actor: "queue-consumer" }));
    expect(late.code).toBe("Suppressed");
    expect(late.status).toBe(410);
    expect(JSON.stringify(late.problem("r"))).not.toContain(s1.id); // the problem carries the token, not the identity
    const rows = await run(engine.call(`${E}/AttendanceRecord.list.byStudent`, { params: { student: s1.id } }, ctx));
    expect(rows.items.every((r: { healthNote: unknown }) => r.healthNote === null)).toBe(true);
    // reviving the student record itself is refused by the same guard (whatever path tries it)
    const revived = await Effect.runPromiseExit(engine.suppression.guard(engine.model.resource(`${E}/Student`), "restore", { id: s1.id }, ctx).pipe(Effect.provide(engine.layer)));
    expect(revived._tag).toBe("Failure");
    expect((Cause.squash((revived as { cause: Cause.Cause<unknown> }).cause) as ForgeError).code).toBe("Suppressed");
    // Bo is unaffected
    expect((await run(engine.call(`${E}/AttendanceRecord.create`, { student: s2.id, date: "2026-09-03", status: "Present" }, ctx))).status).toBe("Present");
  });

  it("PAR-159: restoring an older backup replays the current suppression ledger before reads are enabled", async () => {
    const before = await run(engine.call(`${E}/admin.export`, {}, ctx)); // "backup" taken before the erasure
    const plan = await planDisposition(engine, { subject: { kind: "person", resource: `${E}/Student`, id: s1.id }, disposition: "erasure", ctx });
    const exec = new RightsExecutor(engine, { retention: { stagedArtifacts: "delete-on-revocation" } });
    await exec.open(ctx, { job: "erase-ada", plan, approval: { by: "dpo", at: "2026-09-21T00:00:00Z" } });
    await exec.advance(ctx, "erase-ada", allow);
    // the backup contains Ada; the target keeps its ledger (suppression is not part of the export)
    expect(JSON.stringify(before)).toContain("Ada");
    expect(JSON.stringify(before)).not.toContain("_forge/suppression");
    const target = new Engine(new Model(bundle), testLayer(new MemoryStorage(), { runId: "restore" }));
    await run(target.suppression.record(ctx.tenant, { resource: `${E}/Student`, id: s1.id }, { kind: "erased", reason: "job erase-ada", at: "2026-09-21T00:00:00Z", epoch: Date.now() }).pipe(Effect.provide(target.layer)));
    await run(target.call(`${E}/admin.fence`, { enabled: true }, ctx));
    const imported = await run(target.call(`${E}/admin.import`, { snapshot: before }, ctx));
    expect(imported.suppressed).toEqual({ [`${E}/Student`]: 1, [`${E}/AttendanceRecord`]: 2 });
    await run(target.call(`${E}/admin.fence`, { enabled: false }, ctx));
    expect((await fails(target.call(`${E}/Student.get`, { id: s1.id }, ctx))).code).toBe("NotFound");
    expect((await run(target.call(`${E}/Student.get`, { id: s2.id }, ctx))).name).toBe("Bo");
    expect((await run(target.call(`${E}/AttendanceRecord.list.byStudent`, { params: { student: s1.id } }, ctx))).items).toEqual([]);
    // verification tells the operator the restore was not a faithful copy: the ledger removed rows on purpose
    const verify = await run(target.call(`${E}/admin.verify`, { snapshot: before }, ctx));
    expect(verify.ok).toBe(false);
  });

  it("PAR-160: an external processor's acceptance is not verified completion", async () => {
    const lineage = engine.model.bundle.lineage as { operations: { resource?: string; externalSinks: string[] }[] };
    const op = lineage.operations.find((o) => o.resource === `${E}/AttendanceRecord`)!;
    op.externalSinks = ["vendor:analytics"];
    try {
      const plan = await planDisposition(engine, { subject: { kind: "person", resource: `${E}/Student`, id: s1.id }, disposition: "erasure", processors: [{ id: "analytics-vendor", sinks: ["vendor:analytics"], erasureAdapter: true }], ctx });
      const exec = new RightsExecutor(engine, { retention: { stagedArtifacts: "delete-on-revocation" } });
      await exec.open(ctx, { job: "erase-ada", plan, approval: { by: "dpo", at: "2026-09-21T00:00:00Z" } });
      let report = await exec.advance(ctx, "erase-ada", allow);
      expect(report.state).toBe("completed"); // local work is done
      report = await exec.acknowledge(ctx, "erase-ada", { processor: "analytics-vendor", state: "requested", at: "2026-09-21T01:00:00Z" });
      report = await exec.acknowledge(ctx, "erase-ada", { processor: "analytics-vendor", state: "accepted", at: "2026-09-21T02:00:00Z" });
      expect(report.pending).toEqual([{ processor: "analytics-vendor", state: "accepted" }]);
      expect(report.verdict).toBe("partial");
      await expect(exec.acknowledge(ctx, "erase-ada", { processor: "analytics-vendor", state: "confirmed", at: "2026-09-21T03:00:00Z" })).rejects.toThrow(/completion reference/);
      report = await exec.acknowledge(ctx, "erase-ada", { processor: "analytics-vendor", state: "confirmed", at: "2026-09-21T03:00:00Z", reference: "vendor-ticket-991" });
      expect(report.pending).toEqual([]);
      expect(report.verdict).toBe("complete");
    } finally {
      op.externalSinks = [];
    }
  });

  it("PAR-161: revoking authority during an export stops further chunks and URL issuance; staged artifacts follow retention", async () => {
    for (let i = 3; i < 8; i++) await run(engine.call(`${E}/AttendanceRecord.create`, { student: s1.id, date: `2026-09-0${i}`, status: "Present" }, ctx));
    const plan = await planDisposition(engine, { subject: { kind: "person", resource: `${E}/Student`, id: s1.id }, disposition: "export", ctx });
    const exec = new RightsExecutor(engine, { retention: { stagedArtifacts: "delete-on-revocation" }, chunkSize: 2 });
    await exec.open(ctx, { job: "export-ada", plan, approval: { by: "dpo", at: "2026-09-21T00:00:00Z" } });
    let checks = 0;
    const revoking = { check: async () => ({ allowed: ++checks <= 3, reason: "purpose withdrawn" }) };
    const report = await exec.advance(ctx, "export-ada", revoking);
    expect(report.state).toBe("stopped");
    expect(report.held.some((h) => /authority revoked/.test(h.reason))).toBe(true);
    await expect(exec.issueDownload(ctx, "export-ada", revoking)).rejects.toThrow(/no download/);
    const doc = (await Effect.runPromise(Effect.flatMap((await import("@forge/runtime")).Storage, (s) => s.getDocument(ctx.tenant, "_forge/rights-job", "export-ada")).pipe(Effect.provide(engine.layer)))) as { staged: { disposed?: boolean }[]; urlIssued: boolean };
    expect(doc.staged.length).toBeGreaterThan(0);
    expect(doc.staged.every((s) => s.disposed === true)).toBe(true);
    expect(doc.urlIssued).toBe(false);
    // a fresh job under standing authority completes and issues one URL
    await exec.open(ctx, { job: "export-ada-2", plan, approval: { by: "dpo", at: "2026-09-21T00:00:00Z" } });
    expect((await exec.advance(ctx, "export-ada-2", allow)).state).toBe("completed");
    expect((await exec.issueDownload(ctx, "export-ada-2", allow)).chunks).toBeGreaterThan(1);
  });

  it("PAR-162: the suppression token in the audit record stays classified as potentially personal and never reveals the id", async () => {
    const plan = await planDisposition(engine, { subject: { kind: "person", resource: `${E}/Student`, id: s1.id }, disposition: "erasure", ctx });
    const exec = new RightsExecutor(engine, { retention: { stagedArtifacts: "delete-on-revocation" } });
    await exec.open(ctx, { job: "erase-ada", plan, approval: { by: "dpo", at: "2026-09-21T00:00:00Z" } });
    await exec.advance(ctx, "erase-ada", allow);
    const audit = await run(engine.suppression.audit(ctx.tenant, `${E}/Student`, s1.id).pipe(Effect.provide(engine.layer)));
    expect(audit).toMatchObject({ kind: "erased", classification: SUPPRESSION_CLASS });
    expect(audit!.classification).toEqual({ class: "data.identity.pseudonymous", handling: "restricted", personal: "potentially", identifiability: "linkable-with-key" });
    expect(audit!.token).toHaveLength(32);
    expect(audit!.token).not.toContain(s1.id);
    expect(plan.subject.token).toBe(audit!.token);
    // the token is keyed: a different key produces a different token for the same identity
    const other = new (await import("@forge/runtime")).Suppression(engine, "another-key");
    expect(other.token(ctx.tenant, `${E}/Student`, s1.id)).not.toBe(audit!.token);
  });
});
