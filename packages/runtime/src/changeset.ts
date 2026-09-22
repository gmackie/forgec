/**
 * Changesets (plan §9, §12): propose -> preview -> approve -> commit. The
 * changeset is a document; every operation inside it goes through the same
 * planFor() pipeline as a single call. Approval binds the preview's content
 * hash; commit re-plans against current state (a preview is not a lock).
 */
import { Cause, Effect } from "effect";
import type { Wire } from "./decode.js";
import type { CallContext, Engine } from "./engine.js";
import { stableJson } from "./engine.js";
import { err, ForgeError } from "./errors.js";
import { IdGen, Storage, type CommitPlan, type RuntimeServices } from "./services.js";

export const ATOMIC_LOGICAL_LIMIT = 10;
const KIND = "changeset";

interface ProposedOp {
  op: string;
  input: Wire;
}
interface ItemResult {
  index: number;
  op: string;
  status: "ok" | "error" | "committed" | "skipped";
  diff?: { path: string; before: unknown; after: unknown }[] | undefined;
  result?: Wire | undefined;
  error?: Record<string, unknown> | undefined;
}
interface Doc extends Record<string, unknown> {
  id: string;
  status: "proposed" | "previewed" | "approved" | "committing" | "committed" | "partially-committed" | "failed" | "rejected";
  mode: "atomic" | "resumable";
  operations: ProposedOp[];
  actor: string;
  contentHash?: string;
  approvedHash?: string;
  preview?: { items: ItemResult[]; budget: Budget };
  results?: ItemResult[];
  _version?: number;
}
interface Budget {
  mode: string;
  logicalOperations: number;
  logicalLimit: number;
  physicalActions: number;
  physicalLimit: number;
  atomicAllowed: boolean;
}

async function sha256(text: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Human-readable diff of business fields; server-owned bookkeeping (version, timestamps) is implied. */
function diffOf(plan: CommitPlan): { path: string; before: unknown; after: unknown }[] {
  const out: { path: string; before: unknown; after: unknown }[] = [];
  // `id` is shown for existing records (it names the row) but is noise on a create.
  const serverOwned = new Set(plan.resource.fields.filter((f) => f.serverOwned && (f.name !== "id" || plan.kind === "create") && !(plan.resource.lifecycle && f.name === plan.resource.lifecycle.field)).map((f) => f.name));
  const keys = new Set([...Object.keys(plan.before ?? {}), ...Object.keys(plan.after)].filter((k) => !serverOwned.has(k)));
  for (const k of [...keys].sort()) {
    const b = plan.before?.[k] ?? null;
    const a = plan.hardDelete ? null : (plan.after[k] ?? null);
    if (stableJson(a) !== stableJson(b)) out.push({ path: k, before: b, after: a });
  }
  return out;
}

export class Changesets {
  constructor(private readonly engine: Engine) {}

  handle(action: string, body: Wire, ctx: CallContext): Effect.Effect<any, ForgeError, RuntimeServices> {
    switch (action) {
      case "propose":
        return this.propose(body, ctx);
      case "get":
        return this.load(String(body["id"]), ctx).pipe(Effect.map((d) => this.view(d)));
      case "preview":
        return this.preview(String(body["id"]), ctx);
      case "approve":
        return this.approve(String(body["id"]), String(body["contentHash"] ?? ""), ctx);
      case "commit":
        return this.commit(String(body["id"]), ctx);
      default:
        return Effect.fail(err("MethodNotAllowed", `unknown changeset action ${action}`));
    }
  }

  private load(id: string, ctx: CallContext): Effect.Effect<Doc, ForgeError, RuntimeServices> {
    return Effect.gen(function* () {
      const doc = (yield* (yield* Storage).getDocument(ctx.tenant, KIND, id)) as Doc | null;
      if (!doc) return yield* Effect.fail(err("NotFound", `changeset ${id} not found`));
      return doc;
    });
  }

  private save(doc: Doc, ctx: CallContext): Effect.Effect<Doc, ForgeError, RuntimeServices> {
    return Effect.gen(function* () {
      const expected = doc._version ?? null;
      yield* (yield* Storage).putDocument(ctx.tenant, KIND, doc.id, doc, expected);
      return { ...doc, _version: (expected ?? 0) + 1 };
    });
  }

  private view(d: Doc): Wire {
    const { _version, preview, results, ...rest } = d;
    void _version;
    return { ...rest, operations: d.operations.length, ...(preview ? { items: preview.items, budget: preview.budget } : {}), ...(results ? { results } : {}) };
  }

  private propose(body: Wire, ctx: CallContext): Effect.Effect<Wire, ForgeError, RuntimeServices> {
    const self = this;
    return Effect.gen(function* () {
      const ops = body["operations"];
      if (!Array.isArray(ops) || ops.length === 0) return yield* Effect.fail(err("ValidationFailed", "operations must be a non-empty array"));
      const mode = body["mode"] === "atomic" ? "atomic" : "resumable";
      const operations: ProposedOp[] = ops.map((o: any, i: number) => {
        if (!o || typeof o.op !== "string" || !self.engine.model.operation(o.op)) throw new ForgeError({ code: "ValidationFailed", detail: `operations[${i}].op is not a known operation` });
        return { op: o.op, input: (o.input ?? {}) as Wire };
      });
      const id = (yield* IdGen).opId();
      const doc: Doc = { id, status: "proposed", mode, operations, actor: ctx.actor, ...(body["source"] ? { source: body["source"] } : {}) };
      const saved = yield* self.save(doc, ctx);
      return self.view(saved);
    }).pipe(Effect.catchDefect((d) => (d instanceof ForgeError ? Effect.fail(d) : Effect.die(d))));
  }

  /** Plan every operation against current state; errors are per item, never thrown. */
  private planAll(doc: Doc, ctx: CallContext): Effect.Effect<{ items: ItemResult[]; plans: (CommitPlan | null)[] }, ForgeError, RuntimeServices> {
    const self = this;
    return Effect.gen(function* () {
      const items: ItemResult[] = [];
      const plans: (CommitPlan | null)[] = [];
      for (const [index, o] of doc.operations.entries()) {
        const exit = yield* Effect.exit(self.engine.planFor(o.op, o.input, ctx, true));
        if (exit._tag === "Success") {
          items.push({ index, op: o.op, status: "ok", diff: diffOf(exit.value), result: self.engine.resultOf(exit.value) });
          plans.push(exit.value);
        } else {
          const e = Cause.squash(exit.cause);
          if (!(e instanceof ForgeError)) return yield* Effect.die(e);
          items.push({ index, op: o.op, status: "error", error: e.problem(ctx.requestId) });
          plans.push(null);
        }
      }
      return { items, plans };
    });
  }

  private budget(doc: Doc, plans: (CommitPlan | null)[], storage: { budget(p: CommitPlan[]): { actions: number; limit: number } }): Budget {
    const real = plans.filter((p): p is CommitPlan => p !== null);
    const { actions, limit } = storage.budget(real);
    const allOk = real.length === plans.length;
    return { mode: doc.mode, logicalOperations: doc.operations.length, logicalLimit: ATOMIC_LOGICAL_LIMIT, physicalActions: actions, physicalLimit: limit, atomicAllowed: allOk && doc.operations.length <= ATOMIC_LOGICAL_LIMIT && actions <= limit };
  }

  private preview(id: string, ctx: CallContext): Effect.Effect<Wire, ForgeError, RuntimeServices> {
    const self = this;
    return Effect.gen(function* () {
      const doc = yield* self.load(id, ctx);
      if (!["proposed", "previewed", "approved"].includes(doc.status)) return yield* Effect.fail(err("InvalidTransition", `changeset is ${doc.status}`));
      const { items, plans } = yield* self.planAll(doc, ctx);
      const budget = self.budget(doc, plans, yield* Storage);
      const contentHash = yield* Effect.promise(() => sha256(stableJson({ mode: doc.mode, operations: doc.operations, items: items.map((i) => ({ status: i.status, diff: i.diff ?? null })) })));
      const next: Doc = { ...doc, status: doc.status === "approved" && doc.approvedHash === contentHash ? "approved" : "previewed", contentHash, preview: { items, budget } };
      const saved = yield* self.save(next, ctx);
      return { ...self.view(saved), contentHash };
    });
  }

  private approve(id: string, contentHash: string, ctx: CallContext): Effect.Effect<Wire, ForgeError, RuntimeServices> {
    const self = this;
    return Effect.gen(function* () {
      const doc = yield* self.load(id, ctx);
      if (doc.status !== "previewed" && doc.status !== "approved") return yield* Effect.fail(err("InvalidTransition", `changeset is ${doc.status}; preview it first`));
      if (!doc.contentHash || contentHash !== doc.contentHash) return yield* Effect.fail(err("VersionConflict", "contentHash does not match the latest preview"));
      const saved = yield* self.save({ ...doc, status: "approved", approvedHash: contentHash }, ctx);
      return self.view(saved);
    });
  }

  private commit(id: string, ctx: CallContext): Effect.Effect<Wire, ForgeError, RuntimeServices> {
    const self = this;
    return Effect.gen(function* () {
      let doc = yield* self.load(id, ctx);
      if (doc.status === "committed") return self.view(doc);
      if (doc.status === "partially-committed") {
        // Re-entrant: retry only the rows that have not committed.
        return yield* self.commitResumable(doc, ctx);
      }
      if (doc.status !== "approved") return yield* Effect.fail(err("InvalidTransition", `changeset is ${doc.status}; approve it first`));
      // Re-verify: the approved hash must still describe what we would do now.
      const { items, plans } = yield* self.planAll(doc, ctx);
      const storage = yield* Storage;
      if (doc.mode === "atomic") {
        const budget = self.budget(doc, plans, storage);
        if (doc.operations.length > ATOMIC_LOGICAL_LIMIT || budget.physicalActions > budget.physicalLimit) {
          // The logical limit is contract; the physical count is provider-specific and travels as structured data.
          return yield* Effect.fail(err("BudgetExceeded", `atomic commit of ${doc.operations.length} operations exceeds the atomic budget (logical limit ${ATOMIC_LOGICAL_LIMIT})`, { budget: { physicalActions: budget.physicalActions, physicalLimit: budget.physicalLimit, operations: doc.operations.length, logicalLimit: ATOMIC_LOGICAL_LIMIT } }));
        }
        const firstError = items.findIndex((i) => i.status === "error");
        if (firstError >= 0) {
          const results = items.map((i, idx) => (idx === firstError ? { ...i, status: "error" as const } : { ...i, status: "skipped" as const, diff: undefined, result: undefined }));
          const saved = yield* self.save({ ...doc, status: "failed", results }, ctx);
          return self.view(saved);
        }
        const real = plans as CommitPlan[];
        const exit = yield* Effect.exit(storage.commitAll(real));
        if (exit._tag === "Failure") {
          const e = Cause.squash(exit.cause);
          if (!(e instanceof ForgeError)) return yield* Effect.die(e);
          const results = items.map((i, idx) => (idx === 0 ? { ...i, status: "error" as const, error: e.problem(ctx.requestId), diff: undefined, result: undefined } : { ...i, status: "skipped" as const, diff: undefined, result: undefined }));
          const saved = yield* self.save({ ...doc, status: "failed", results }, ctx);
          return self.view(saved);
        }
        const results = items.map((i, idx) => ({ ...i, status: "committed" as const, result: self.engine.resultOf(real[idx]!), diff: undefined }));
        const saved = yield* self.save({ ...doc, status: "committed", results }, ctx);
        return self.view(saved);
      }
      doc = yield* self.save({ ...doc, status: "committing", results: items.map((i) => ({ ...i, diff: undefined, result: undefined })) }, ctx);
      return yield* self.commitResumable(doc, ctx);
    });
  }

  /** Per-record commits with per-row results; safe to call again after a fault. */
  private commitResumable(doc: Doc, ctx: CallContext): Effect.Effect<Wire, ForgeError, RuntimeServices> {
    const self = this;
    return Effect.gen(function* () {
      const storage = yield* Storage;
      const results: ItemResult[] = doc.results ?? doc.operations.map((o, index) => ({ index, op: o.op, status: "ok" as const }));
      for (const [index, o] of doc.operations.entries()) {
        const prev = results[index]!;
        if (prev.status === "committed") continue;
        // Each row commits under its own receipt (changeset id + row index): a crash after a row's commit
        // is replayed on resume instead of re-executed.
        const rowKey = `cs:${doc.id}:${index}`;
        const rowCtx: CallContext = { ...ctx, idempotencyKey: rowKey };
        // Resolve Storage inside the effect so the receipt wrapper provided by withIdempotency is used.
        const exec = Effect.gen(function* () {
          const plan = yield* self.engine.planFor(o.op, o.input, rowCtx);
          yield* (yield* Storage).commit(plan);
          return self.engine.resultOf(plan);
        });
        const exit = yield* Effect.exit(self.engine.withIdempotency(o.op, o.input, rowCtx, exec, rowKey));
        if (exit._tag === "Success") {
          results[index] = { index, op: o.op, status: "committed", result: exit.value };
        } else {
          const e = Cause.squash(exit.cause);
          if (!(e instanceof ForgeError)) return yield* Effect.die(e);
          results[index] = { index, op: o.op, status: "error", error: e.problem(ctx.requestId) };
        }
        // Persist progress after every row so a crash never repeats a committed row.
        doc = yield* self.save({ ...doc, status: "committing", results: [...results] }, ctx);
      }
      const status = results.every((r) => r.status === "committed") ? "committed" : "partially-committed";
      const saved = yield* self.save({ ...doc, status, results }, ctx);
      return self.view(saved);
    });
  }
}
