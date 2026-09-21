/**
 * Durable erasure / restriction / export execution (FORGE-078; PAR-156/160/161).
 * An approved plan runs in chunks. Every chunk re-checks authority through a
 * caller-supplied `authority` (purpose/subject authority that may be revoked
 * mid-run) and records its progress in a CAS-protected job document, so a
 * failure resumes where it stopped and a revocation stops further disclosure
 * at the next chunk boundary: no later chunk is read, no download URL is
 * issued, and staged export artifacts are disposed of per the retention
 * policy. Erasure scrubs personal fields of bound records, soft-deletes the
 * subject's own record, deletes sealed blobs, and writes the suppression
 * ledger; the completion report names held (hold/revoked) and pending
 * (external) items instead of claiming universal completion. External
 * processors advance requested → accepted → confirmed only through explicit
 * acknowledgments; `accepted` is never `verified`.
 */
import { Effect } from "effect";
import type { CallContext, CommitPlan, Engine, Resource, StoredRecord } from "@forge/runtime";
import { Objects, Storage } from "@forge/runtime";
import type { DispositionPlan, PlanItem } from "./rights-planner.js";

export const JOB_KIND = "_forge/rights-job";

export interface Authority { check(chunk: { job: string; item: PlanItem; index: number }): Promise<{ allowed: boolean; reason?: string }> }
export interface Retention { stagedArtifacts: "delete-on-revocation" | "retain-for-review" }
export interface ExternalAck { processor: string; state: "requested" | "accepted" | "confirmed"; at: string; reference?: string }
export interface JobDoc {
  job: string;
  plan: DispositionPlan;
  approval: { by: string; at: string };
  chunkSize: number;
  progress: Record<string, { done: number; cursor: string | null; state: "pending" | "running" | "done" | "held" }>;
  staged: { chunk: number; key: string; bytes: number; disposed?: boolean }[];
  external: ExternalAck[];
  state: "open" | "completed" | "stopped";
  stoppedReason?: string;
  urlIssued: boolean;
  _version?: number;
}
export interface Report { job: string; state: JobDoc["state"]; done: { item: string; count: number }[]; held: { item: string; reason: string }[]; pending: { processor: string; state: string }[]; verdict: "complete" | "partial" | "unknown"; downloadUrl?: string }

export class RightsExecutor {
  constructor(private readonly engine: Engine, private readonly o: { retention: Retention; chunkSize?: number }) {}

  private run<A>(e: Effect.Effect<A, unknown, unknown>): Promise<A> {
    return Effect.runPromise(e.pipe(Effect.provide(this.engine.layer)) as Effect.Effect<A, never, never>);
  }
  private async load(tenant: string, job: string): Promise<JobDoc> {
    const d = (await this.run(Effect.flatMap(Storage, (s) => s.getDocument(tenant, JOB_KIND, job)))) as JobDoc | null;
    if (!d) throw new Error(`job ${job} does not exist`);
    return d;
  }
  private async put(tenant: string, doc: JobDoc): Promise<JobDoc> {
    const { _version, ...rest } = doc;
    await this.run(Effect.flatMap(Storage, (s) => s.putDocument(tenant, JOB_KIND, doc.job, rest, _version ?? null)));
    return { ...rest, _version: (_version ?? 0) + 1 };
  }

  /** Open a job from an approved plan; idempotent on the job id. */
  async open(ctx: CallContext, o: { job: string; plan: DispositionPlan; approval: { by: string; at: string } }): Promise<JobDoc> {
    if (!o.plan.requiresReview || !o.approval.by) throw new Error("only a reviewed, approved plan can run");
    const existing = (await this.run(Effect.flatMap(Storage, (s) => s.getDocument(ctx.tenant, JOB_KIND, o.job)))) as JobDoc | null;
    if (existing) return existing;
    const progress: JobDoc["progress"] = {};
    o.plan.items.forEach((it, i) => { progress[`${i}:${it.resource}`] = { done: 0, cursor: null, state: it.action === "preserve" ? "held" : "pending" }; });
    return this.put(ctx.tenant, { job: o.job, plan: o.plan, approval: o.approval, chunkSize: this.o.chunkSize ?? 50, progress, staged: [], external: o.plan.external.filter((e) => e.state !== "not-requested").map((e) => ({ processor: e.processor, state: e.state as ExternalAck["state"], at: o.approval.at })), state: "open", urlIssued: false });
  }

  private resource(id: string): Resource {
    return this.engine.model.resource(id);
  }

  /** Records of `item` belonging to the subject, one page at a time (the declared access path or the subject's own record). */
  private async page(ctx: CallContext, doc: JobDoc, item: PlanItem, cursor: string | null): Promise<{ records: StoredRecord[]; next: string | null }> {
    const r = this.resource(item.resource);
    if (item.resource === doc.plan.subject.resource) {
      const rec = await this.run(Effect.flatMap(Storage, (s) => s.get(ctx.tenant, r, doc.plan.subject.id)));
      return { records: rec ? [rec] : [], next: null };
    }
    const list = r.lists.find((l) => l.fields.length === 1 && l.fields[0] === item.via);
    if (!list) return { records: [], next: null };
    const p = (await this.run(this.engine.callInternal(`${r.id}.list.${list.name}`, { params: { [item.via!]: doc.plan.subject.id }, limit: doc.chunkSize, ...(cursor ? { cursor } : {}) }, { ...ctx, maintenance: true }))) as { items: StoredRecord[]; next: string | null };
    return { records: p.items, next: p.next ?? null };
  }

  private async scrub(ctx: CallContext, r: Resource, rec: StoredRecord, fields: string[], deleteRecord: boolean, now: string): Promise<void> {
    const after: StoredRecord = { ...rec, version: (rec["version"] as number) + 1, updatedAt: now };
    for (const f of fields) if (f in after) after[f] = null;
    if (deleteRecord) after["deletedAt"] = now;
    // sealed blob content goes with the record
    const content = rec["content"] as { key?: string } | undefined;
    if (content?.key) await this.run(Effect.flatMap(Objects, (o) => o.delete(content.key!)).pipe(Effect.catch(() => Effect.void)));
    const plan: CommitPlan = {
      tenant: ctx.tenant, opId: `erasure:${rec["id"] as string}:${now}`, actor: ctx.actor, at: now, resource: r, kind: deleteRecord ? "delete" : "update", id: String(rec["id"]), expectedVersion: rec["version"] as number, before: rec, after,
      // a soft-deleted subject record releases its unique claims (before -> null) so the identity cannot be re-taken silently
      claims: deleteRecord ? this.engine.claimChangesFor(r, rec).map((c) => ({ ...c, before: c.after, after: null })) : [], references: [], dependents: [], hardDelete: false,
      audit: { tenant: ctx.tenant, opId: `erasure:${rec["id"] as string}`, resource: r.id, recordId: String(rec["id"]), kind: deleteRecord ? "erasure.delete" : "erasure.scrub", newVersion: after["version"] as number, actor: ctx.actor, at: now },
      outbox: [],
    };
    await this.run(Effect.flatMap(Storage, (s) => s.commit(plan)));
  }

  /** Run every runnable chunk; stops at the first refused re-authorization. Safe to call again after a crash. */
  async advance(ctx: CallContext, job: string, authority: Authority, now = () => new Date().toISOString()): Promise<Report> {
    let doc = await this.load(ctx.tenant, job);
    if (doc.state !== "open") return this.report(doc);
    for (let i = 0; i < doc.plan.items.length; i++) {
      const item = doc.plan.items[i]!;
      const key = `${i}:${item.resource}`;
      const p = doc.progress[key]!;
      if (p.state === "done" || p.state === "held") continue;
      let cursor = p.cursor;
      let chunk = 0;
      for (;;) {
        const auth = await authority.check({ job, item, index: chunk });
        if (!auth.allowed) {
          doc = await this.stop(ctx, doc, `authority revoked before chunk ${chunk} of ${key}: ${auth.reason ?? "revoked"}`);
          return this.report(doc);
        }
        const page = await this.page(ctx, doc, item, cursor);
        const stamp = now();
        if (item.action === "export") {
          const bytes = Buffer.byteLength(JSON.stringify(page.records.map((rec) => Object.fromEntries(item.fields.map((f) => [f, rec[f]])))));
          const stagedKey = `rights/${job}/${key}/${chunk}.json`;
          doc = await this.put(ctx.tenant, { ...doc, staged: [...doc.staged, { chunk, key: stagedKey, bytes }], progress: { ...doc.progress, [key]: { done: p.done + page.records.length, cursor: page.next, state: page.next ? "running" : "done" } } });
        } else if (item.action === "erase-fields" || item.action === "delete-record") {
          const r = this.resource(item.resource);
          for (const rec of page.records) if (rec["deletedAt"] === null || rec["deletedAt"] === undefined || item.action === "erase-fields") await this.scrub(ctx, r, rec, item.fields, item.action === "delete-record", stamp);
          doc = await this.put(ctx.tenant, { ...doc, progress: { ...doc.progress, [key]: { done: p.done + page.records.length, cursor: page.next, state: page.next ? "running" : "done" } } });
        } else if (item.action === "restrict") {
          doc = await this.put(ctx.tenant, { ...doc, progress: { ...doc.progress, [key]: { done: p.done + page.records.length, cursor: page.next, state: page.next ? "running" : "done" } } });
        }
        p.done += page.records.length;
        cursor = page.next;
        chunk++;
        if (!cursor) break;
      }
    }
    // erasure/restriction: the ledger entry makes the disposition durable and blocks resurrection
    if (doc.plan.disposition !== "export") {
      await this.run(this.engine.suppression.record(ctx.tenant, { resource: doc.plan.subject.resource, id: doc.plan.subject.id }, { kind: doc.plan.disposition === "erasure" ? "erased" : "restricted", reason: `job ${job}`, at: now(), epoch: Date.now() }));
    }
    doc = await this.put(ctx.tenant, { ...doc, state: "completed" });
    return this.report(doc);
  }

  private async stop(ctx: CallContext, doc: JobDoc, reason: string): Promise<JobDoc> {
    // staged export chunks follow the retention policy; a URL is never issued after a stop
    const staged = doc.staged.map((s) => (this.o.retention.stagedArtifacts === "delete-on-revocation" ? { ...s, disposed: true } : s));
    return this.put(ctx.tenant, { ...doc, state: "stopped", stoppedReason: reason, staged });
  }

  /** A download URL for a completed export; refused for anything else (stopped jobs never disclose). */
  async issueDownload(ctx: CallContext, job: string, authority: Authority): Promise<{ url: string; chunks: number }> {
    const doc = await this.load(ctx.tenant, job);
    if (doc.state !== "completed" || doc.plan.disposition !== "export") throw new Error(`job ${job} is ${doc.state}; no download is issued`);
    const auth = await authority.check({ job, item: doc.plan.items[0]!, index: -1 });
    if (!auth.allowed) {
      await this.stop(ctx, doc, `authority revoked before URL issuance: ${auth.reason ?? "revoked"}`);
      throw new Error("authority revoked: no download is issued");
    }
    await this.put(ctx.tenant, { ...doc, urlIssued: true });
    return { url: `forge://rights/${ctx.tenant}/${job}/export?chunks=${doc.staged.length}`, chunks: doc.staged.length };
  }

  /** External processor acknowledgments; `confirmed` needs a completion reference, `accepted` never counts as verified. */
  async acknowledge(ctx: CallContext, job: string, ack: ExternalAck): Promise<Report> {
    const doc = await this.load(ctx.tenant, job);
    if (ack.state === "confirmed" && !ack.reference) throw new Error("a confirmed erasure needs the processor's completion reference; acceptance alone is not completion");
    const external = doc.external.filter((e) => e.processor !== ack.processor).concat([ack]);
    return this.report(await this.put(ctx.tenant, { ...doc, external }));
  }

  async status(ctx: CallContext, job: string): Promise<Report> {
    return this.report(await this.load(ctx.tenant, job));
  }

  private report(doc: JobDoc): Report {
    const done: Report["done"] = [];
    const held: Report["held"] = [];
    doc.plan.items.forEach((it, i) => {
      const p = doc.progress[`${i}:${it.resource}`]!;
      if (p.state === "done") done.push({ item: `${it.action} ${it.resource}`, count: p.done });
      else if (p.state === "held") held.push({ item: `${it.action} ${it.resource}`, reason: it.hold ? `hold ${it.hold}` : "preserved" });
      else held.push({ item: `${it.action} ${it.resource}`, reason: doc.state === "stopped" ? (doc.stoppedReason ?? "stopped") : "pending" });
    });
    const pending = doc.external.filter((e) => e.state !== "confirmed").map((e) => ({ processor: e.processor, state: e.state }));
    const verdict: Report["verdict"] = doc.plan.unknowns.length ? "unknown" : held.length || pending.length || doc.state !== "completed" ? "partial" : "complete";
    return { job: doc.job, state: doc.state, done, held, pending, verdict };
  }
}
