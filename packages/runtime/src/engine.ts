/**
 * One mutation engine for every interface (plan §9). Operations are resolved
 * by stable id, inputs decoded through the common pipeline, and every write
 * becomes a CommitPlan executed atomically by the storage adapter.
 */
import { Effect, Layer } from "effect";
import { encodeIdentity, sortKey } from "./codecs.js";
import { decodeCursor, encodeCursor } from "./cursor.js";
import { canonicalize, decodeObject, evalExpr, type Wire } from "./decode.js";
import { err, ForgeError } from "./errors.js";
import { fieldOf, scaleOf, type List, type Model, type Resource, type Transition, type Unique } from "./model.js";
import { Clock, CursorSecret, IdGen, Storage, type ClaimChange, type CommitPlan, type Receipt, type ReferenceGuard, type RuntimeServices, type StoredRecord } from "./services.js";

export interface CallContext {
  tenant: string;
  actor: string;
  requestId: string;
  idempotencyKey?: string;
}

export const PAGE_DEFAULT = 50;
export const PAGE_MAX = 100;

async function sha256(text: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Stable JSON for request hashing (sorted keys). */
export function stableJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stableJson).join(",")}]`;
  if (v && typeof v === "object") return `{${Object.keys(v as object).sort().map((k) => `${JSON.stringify(k)}:${stableJson((v as Wire)[k])}`).join(",")}}`;
  return JSON.stringify(v);
}

export class Engine {
  constructor(readonly model: Model, private readonly layer: Layer.Layer<RuntimeServices>) {}

  call(opId: string, input: unknown, ctx: CallContext): Effect.Effect<any, ForgeError> {
    const self = this;
    return self.program(opId, input, ctx).pipe(Effect.provide(self.layer));
  }

  private program(opId: string, input: unknown, ctx: CallContext): Effect.Effect<any, ForgeError, RuntimeServices> {
    const self = this;
    const ref = self.model.operation(opId);
    if (!ref) return Effect.fail(err("MethodNotAllowed", `unknown operation ${opId}`));
    const { op, resource } = ref;
    const body = (input ?? {}) as Wire;
    switch (op.kind) {
      case "create":
        return self.withIdempotency(op.id, body, ctx, self.create(resource, body, ctx));
      case "get":
        return self.get(resource, String(body["id"]), ctx);
      case "update":
        return self.withIdempotency(op.id, body, ctx, self.update(resource, body, ctx));
      case "delete":
        return self.withIdempotency(op.id, body, ctx, self.deleteOrRestore(resource, body, ctx, "delete"));
      case "restore":
        return self.withIdempotency(op.id, body, ctx, self.deleteOrRestore(resource, body, ctx, "restore"));
      case "find":
        return self.find(resource, op.query!, body, ctx);
      case "list":
        return self.list(resource, op.id, op.query!, body, ctx);
      case "transition":
        return self.withIdempotency(op.id, body, ctx, self.transition(resource, op.action!, body, ctx));
      default:
        return Effect.fail(err("MethodNotAllowed", `operation kind ${op.kind} is not executable`));
    }
  }

  // ------------------------------------------------------------ helpers
  private claimKey(r: Resource, u: Unique, rec: Wire): string | null {
    const self = this;
    const fields = [...u.within, ...u.fields];
    const values = fields.map((f) => rec[f]);
    if (values.some((v) => v === null || v === undefined)) return null; // optional nulls reserve no claim
    return encodeIdentity([r.id, u.name, ...values.map(String)]);
  }

  private claimChanges(r: Resource, before: Wire | null, after: Wire): ClaimChange[] {
    const self = this;
    return r.uniques.map((unique) => ({ unique, before: before ? self.claimKey(r, unique, before) : null, after: self.claimKey(r, unique, after) }));
  }

  private referenceGuards(r: Resource, after: Wire, changed: Set<string> | null): ReferenceGuard[] {
    const self = this;
    const out: ReferenceGuard[] = [];
    for (const f of r.fields) {
      if (f.type.base.kind !== "reference" || f.synthesized) continue;
      if (changed && !changed.has(f.name)) continue;
      const id = after[f.name];
      if (typeof id === "string") out.push({ field: f.name, resource: self.model.resource(f.type.base.resource), id });
    }
    return out;
  }

  /** Load referenced records (for rules) and verify they exist in this tenant and are live. */
  private loadReferences(r: Resource, after: Wire, ctx: CallContext, guards: ReferenceGuard[]): Effect.Effect<Record<string, Wire | null>, ForgeError, RuntimeServices> {
    const self = this;
    return Effect.gen(function* () {
      const storage = yield* Storage;
      const refs: Record<string, Wire | null> = {};
      const missing: string[] = [];
      for (const g of guards) {
        const rec = yield* storage.get(ctx.tenant, g.resource, g.id);
        if (!rec || rec["deletedAt"]) missing.push(g.field);
        refs[g.field] = rec;
      }
      if (missing.length) {
        return yield* Effect.fail(err("ReferenceMissing", `referenced record not found: ${missing.join(", ")}`, { fields: missing.map((f) => ({ path: f, code: "ReferenceMissing", message: `${f} does not reference a live record in this tenant` })) }));
      }
      // Rules need every reference, not only changed ones.
      for (const f of r.fields) {
        if (f.type.base.kind === "reference" && !(f.name in refs) && typeof after[f.name] === "string") {
          refs[f.name] = yield* storage.get(ctx.tenant, self.model.resource(f.type.base.resource), after[f.name] as string);
        }
      }
      return refs;
    });
  }

  private checkRules(r: Resource, after: Wire, refs: Record<string, Wire | null>): Effect.Effect<void, ForgeError> {
    const self = this;
    const failures = r.rules.filter((rule) => !evalExpr(self.model, r, rule, after, undefined, refs));
    if (failures.length === 0) return Effect.void;
    return Effect.fail(err("ValidationFailed", "a row rule was violated", { fields: failures.map((rule) => ({ path: "", code: "RuleViolation", message: describeRule(rule) })) }));
  }

  private commitAndReturn(plan: CommitPlan): Effect.Effect<Wire, ForgeError, RuntimeServices> {
    const self = this;
    return Effect.gen(function* () {
      const storage = yield* Storage;
      yield* storage.commit(plan);
      return canonicalize(self.model, plan.resource, plan.after);
    });
  }

  private expectedVersion(r: Resource, body: Wire): Effect.Effect<number | null, ForgeError> {
    const self = this;
    if (!r.decorators.versioned) return Effect.succeed(null);
    const v = body["expectedVersion"];
    if (typeof v !== "number" || !Number.isInteger(v) || v < 1) return Effect.fail(err("PreconditionRequired", "expectedVersion (If-Match) is required for this operation"));
    return Effect.succeed(v);
  }

  private loadCurrent(r: Resource, id: string, ctx: CallContext, expected: number | null): Effect.Effect<StoredRecord, ForgeError, RuntimeServices> {
    const self = this;
    return Effect.gen(function* () {
      const storage = yield* Storage;
      const rec = yield* storage.get(ctx.tenant, r, id);
      if (!rec) return yield* Effect.fail(err("NotFound", `${r.name} ${id} not found`));
      if (expected !== null && rec["version"] !== expected) {
        return yield* Effect.fail(err("VersionConflict", `expected version ${expected}, current is ${rec["version"]}`));
      }
      return rec;
    });
  }

  private audit(kind: string, r: Resource, id: string, after: Wire, ctx: CallContext, opId: string, at: string) {
    const self = this;
    return { tenant: ctx.tenant, opId, resource: r.id, recordId: id, kind, newVersion: typeof after["version"] === "number" ? (after["version"] as number) : null, actor: ctx.actor, at };
  }

  // ------------------------------------------------------------ create
  private create(r: Resource, body: Wire, ctx: CallContext): Effect.Effect<Wire, ForgeError, RuntimeServices> {
    const self = this;
    return Effect.gen(function* () {
      const { value, errors } = decodeObject(self.model, body, { mode: "create", fields: r.fields });
      if (errors) return yield* Effect.fail(errors);
      const clock = yield* Clock;
      const ids = yield* IdGen;
      const now = clock.now();
      const id = ids.next(r);
      const after: Wire = { ...value, id };
      if (r.decorators.versioned) after["version"] = 1;
      if (r.decorators.timestamps) {
        after["createdAt"] = now;
        after["updatedAt"] = now;
      }
      if (r.decorators.softDelete) after["deletedAt"] = null;
      if (r.lifecycle) after[r.lifecycle.field] = r.lifecycle.initial;
      const guards = self.referenceGuards(r, after, null);
      const refs = yield* self.loadReferences(r, after, ctx, guards);
      yield* self.checkRules(r, after, refs);
      const opId = ids.opId();
      const plan: CommitPlan = {
        tenant: ctx.tenant, opId, actor: ctx.actor, at: now, resource: r, kind: "create", id, expectedVersion: null, before: null, after,
        claims: self.claimChanges(r, null, after), references: guards,
        audit: self.audit("create", r, id, after, ctx, opId, now), outbox: [],
      };
      return yield* self.commitAndReturn(plan);
    });
  }

  // ------------------------------------------------------------ get/find/list
  private get(r: Resource, id: string, ctx: CallContext): Effect.Effect<Wire, ForgeError, RuntimeServices> {
    const self = this;
    return Effect.gen(function* () {
      const storage = yield* Storage;
      const rec = yield* storage.get(ctx.tenant, r, id);
      if (!rec || rec["deletedAt"]) return yield* Effect.fail(err("NotFound", `${r.name} ${id} not found`));
      return canonicalize(self.model, r, rec);
    });
  }

  private queryValues(r: Resource, fields: string[], params: unknown): Effect.Effect<Wire, ForgeError> {
    const self = this;
    const p = (params ?? {}) as Wire;
    const subset = r.fields.filter((f) => fields.includes(f.name)).map((f) => ({ ...f, immutable: false, serverOwned: false, synthesized: false }));
    const { value, errors } = decodeObject(self.model, Object.fromEntries(fields.map((f) => [f, p[f]])), { mode: "input", fields: subset });
    return errors ? Effect.fail(errors) : Effect.succeed(value);
  }

  private find(r: Resource, query: string, body: Wire, ctx: CallContext): Effect.Effect<Wire, ForgeError, RuntimeServices> {
    const self = this;
    return Effect.gen(function* () {
      const f = r.finds.find((x) => x.name === query)!;
      const unique = r.uniques.find((u) => u.name === f.coveredBy)!;
      const values = yield* self.queryValues(r, f.fields, body["params"]);
      const key = self.claimKey(r, unique, values);
      const storage = yield* Storage;
      const rec = key ? yield* storage.findUnique(ctx.tenant, r, unique, key) : null;
      if (!rec || rec["deletedAt"]) return yield* Effect.fail(err("NotFound", `${r.name} not found`));
      return canonicalize(self.model, r, rec);
    });
  }

  sortKeys(r: Resource, l: List): (rec: StoredRecord) => string[] {
    const self = this;
    return (rec) => l.order.map((o) => {
      const f = fieldOf(r, o.field)!;
      const type = f.type.base.kind === "scalar" ? f.type.base.name : f.type.base.kind;
      const k = sortKey(rec[o.field], type, { scale: scaleOf(f.type) });
      return k;
    });
  }

  private list(r: Resource, opId: string, query: string, body: Wire, ctx: CallContext): Effect.Effect<Wire, ForgeError, RuntimeServices> {
    const self = this;
    return Effect.gen(function* () {
      const l = r.lists.find((x) => x.name === query)!;
      const values = yield* self.queryValues(r, l.fields, body["params"]);
      const rawLimit = body["limit"];
      const limit = typeof rawLimit === "number" && rawLimit > 0 ? Math.min(Math.floor(rawLimit), PAGE_MAX) : PAGE_DEFAULT;
      const secret = (yield* CursorSecret).key;
      let after: { keys: string[]; id: string } | null = null;
      if (typeof body["cursor"] === "string" && body["cursor"]) {
        const state = yield* decodeCursor(secret, body["cursor"], { q: opId, t: ctx.tenant });
        after = { keys: state.k, id: state.id };
      }
      const storage = yield* Storage;
      const keys = self.sortKeys(r, l);
      const page = yield* storage.list(ctx.tenant, r, { list: l, values, after, limit }, keys);
      const items = page.records.map((rec) => canonicalize(self.model, r, rec));
      let next: string | null = null;
      if (page.hasMore && page.records.length) {
        const last = page.records[page.records.length - 1]!;
        next = yield* encodeCursor(secret, { q: opId, v: 1, t: ctx.tenant, k: keys(last), id: String(last["id"]) });
      }
      return { items, next, limit };
    });
  }

  // ------------------------------------------------------------ update
  private update(r: Resource, body: Wire, ctx: CallContext): Effect.Effect<Wire, ForgeError, RuntimeServices> {
    const self = this;
    return Effect.gen(function* () {
      const id = String(body["id"]);
      const expected = yield* self.expectedVersion(r, body);
      const { value: patch, errors } = decodeObject(self.model, body["patch"] ?? {}, { mode: "patch", fields: r.fields });
      if (errors) return yield* Effect.fail(errors);
      const before = yield* self.loadCurrent(r, id, ctx, expected);
      if (before["deletedAt"]) return yield* Effect.fail(err("NotFound", `${r.name} ${id} not found`));
      const clock = yield* Clock;
      const ids = yield* IdGen;
      const now = clock.now();
      const after: Wire = { ...before, ...patch };
      if (r.decorators.versioned) after["version"] = (before["version"] as number) + 1;
      if (r.decorators.timestamps) after["updatedAt"] = now;
      const guards = self.referenceGuards(r, after, new Set(Object.keys(patch)));
      const refs = yield* self.loadReferences(r, after, ctx, guards);
      yield* self.checkRules(r, after, refs);
      const opId = ids.opId();
      const plan: CommitPlan = {
        tenant: ctx.tenant, opId, actor: ctx.actor, at: now, resource: r, kind: "update", id, expectedVersion: expected, before, after,
        claims: self.claimChanges(r, before, after), references: guards,
        audit: self.audit("update", r, id, after, ctx, opId, now), outbox: [],
      };
      return yield* self.commitAndReturn(plan);
    });
  }

  // ------------------------------------------------------------ delete/restore
  private deleteOrRestore(r: Resource, body: Wire, ctx: CallContext, kind: "delete" | "restore"): Effect.Effect<Wire, ForgeError, RuntimeServices> {
    const self = this;
    return Effect.gen(function* () {
      const id = String(body["id"]);
      const expected = yield* self.expectedVersion(r, body);
      const before = yield* self.loadCurrent(r, id, ctx, expected);
      const clock = yield* Clock;
      const ids = yield* IdGen;
      const now = clock.now();
      if (!r.decorators.softDelete && kind === "restore") return yield* Effect.fail(err("MethodNotAllowed", `${r.name} is not soft-deletable`));
      if (kind === "delete" && before["deletedAt"]) return yield* Effect.fail(err("AlreadyDeleted", `${r.name} ${id} is already deleted`));
      if (kind === "restore" && !before["deletedAt"]) return yield* Effect.fail(err("NotDeleted", `${r.name} ${id} is not deleted`));
      const after: Wire = { ...before };
      if (r.decorators.softDelete) after["deletedAt"] = kind === "delete" ? now : null;
      if (r.decorators.versioned) after["version"] = (before["version"] as number) + 1;
      if (r.decorators.timestamps) after["updatedAt"] = now;
      const opId = ids.opId();
      const plan: CommitPlan = {
        tenant: ctx.tenant, opId, actor: ctx.actor, at: now, resource: r, kind, id, expectedVersion: expected, before, after,
        claims: [], references: [],
        audit: self.audit(kind, r, id, after, ctx, opId, now), outbox: [],
      };
      return yield* self.commitAndReturn(plan);
    });
  }

  // ------------------------------------------------------------ transition
  private transition(r: Resource, action: string, body: Wire, ctx: CallContext): Effect.Effect<Wire, ForgeError, RuntimeServices> {
    const self = this;
    return Effect.gen(function* () {
      const lc = r.lifecycle!;
      const t: Transition = lc.transitions.find((x) => x.action === action)!;
      const id = String(body["id"]);
      const expected = yield* self.expectedVersion(r, body);
      const { value: input, errors } = decodeObject(self.model, body["input"] ?? {}, { mode: "input", fields: t.input });
      if (errors) return yield* Effect.fail(errors);
      const before = yield* self.loadCurrent(r, id, ctx, expected);
      if (before["deletedAt"]) return yield* Effect.fail(err("NotFound", `${r.name} ${id} not found`));
      const current = String(before[lc.field]);
      if (!t.from.includes(current)) return yield* Effect.fail(err("InvalidTransition", `${action} is not allowed from ${current}`));
      const clock = yield* Clock;
      const ids = yield* IdGen;
      const now = clock.now();
      const after: Wire = { ...before, [lc.field]: t.to };
      if (r.decorators.versioned) after["version"] = (before["version"] as number) + 1;
      if (r.decorators.timestamps) after["updatedAt"] = now;
      const opId = ids.opId();
      const plan: CommitPlan = {
        tenant: ctx.tenant, opId, actor: ctx.actor, at: now, resource: r, kind: "transition", id, expectedVersion: expected, before, after,
        claims: [], references: [],
        audit: { ...self.audit(`status.${action}`, r, id, after, ctx, opId, now), payload: input }, outbox: [],
      };
      return yield* self.commitAndReturn(plan);
    });
  }

  // ------------------------------------------------------------ idempotency
  private withIdempotency(operation: string, body: Wire, ctx: CallContext, run: Effect.Effect<Wire, ForgeError, RuntimeServices>): Effect.Effect<Wire, ForgeError, RuntimeServices> {
    const self = this;
    const key = ctx.idempotencyKey;
    if (!key) return run;
    return Effect.gen(function* () {
      const storage = yield* Storage;
      const requestHash = yield* Effect.promise(() => sha256(stableJson(body)));
      const existing = yield* storage.getReceipt(ctx.tenant, operation, key);
      if (existing) {
        if (existing.requestHash !== requestHash) return yield* Effect.fail(err("IdempotencyMismatch", "idempotency key reused with a different request"));
        return existing.response as Wire;
      }
      const clock = yield* Clock;
      const receipt: Receipt = { tenant: ctx.tenant, operation, key, requestHash, status: 200, response: null, createdAt: clock.now() };
      return yield* runWithReceipt(run, receipt);
    });

    function runWithReceipt(inner: Effect.Effect<Wire, ForgeError, RuntimeServices>, receipt: Receipt) {
      // The receipt is attached to the plan by intercepting Storage.commit: we wrap the storage service.
      return Effect.gen(function* () {
        const storage = yield* Storage;
        const wrapped = {
          ...storage,
          commit: (plan: CommitPlan) => {
            const canonicalAfter = plan.after;
            return storage.commit({ ...plan, receipt: { ...receipt, response: canonicalAfter } });
          },
        };
        return yield* inner.pipe(Effect.provideService(Storage, wrapped));
      });
    }
  }
}

function describeRule(e: import("./model.js").Expr): string {
  switch (e.kind) {
    case "binary":
      return `${describeRule(e.lhs)} ${e.op} ${describeRule(e.rhs)}`;
    case "unary":
      return `${e.op}${describeRule(e.operand)}`;
    case "name":
      return e.path.join(".");
    case "literal":
      return "literal" in e ? JSON.stringify((e.literal as { value?: unknown }).value ?? null) : "";
    case "call":
      return `${e.callee.join(".")}(...)`;
  }
}
