/**
 * One mutation engine for every interface (plan §9). Operations are resolved
 * by stable id, inputs decoded through the common pipeline, and every write
 * becomes a CommitPlan executed atomically by the storage adapter.
 */
import { Cause, Effect, Layer } from "effect";
import { encodeIdentity, sortKey } from "./codecs.js";
import { decodeCursor, encodeCursor } from "./cursor.js";
import { canonicalize, decodeObject, evalExpr, type Wire } from "./decode.js";
import { err, ForgeError } from "./errors.js";
import { fieldOf, scaleOf, type List, type Model, type Operation, type Resource, type Transition, type Unique } from "./model.js";
import { Clock, CursorSecret, IdGen, Storage, type ClaimChange, type CommitPlan, type Receipt, type ReferenceGuard, type RuntimeServices, type StorageAdapter, type StoredRecord } from "./services.js";
import { Changesets } from "./changeset.js";
import { Blobs } from "./blobs.js";
import { Imports } from "./imports.js";
import { Functions, type ExternalBinding, type FunctionImpl } from "./functions.js";
import { Temporal } from "./temporal.js";
import { ReadModels } from "./readmodels.js";
import { Workflows } from "./workflows.js";
import { Schedules } from "./schedules.js";
import { Realtime } from "./realtime.js";
import { Telemetry, type TraceContext } from "./telemetry.js";
import { Portability } from "./portability.js";
import { Governance } from "./governance.js";
import { Scope } from "./scope.js";
import { Gatekeeper } from "./gatekeeper.js";
import { Suppression } from "./suppression.js";
import { testClocks } from "./testing.js";
import type { Transport } from "./dispatch.js";
import type { Envelope } from "./dispatch.js";

export interface CallContext {
  tenant: string;
  actor: string;
  requestId: string;
  idempotencyKey?: string;
  /** W3C trace context for this logical operation (its own span; the request's span is the parent). */
  trace?: TraceContext;
  /** Edition 2027: the purpose surface this invocation runs under (one purpose; never a union). */
  purpose?: string;
  /** Retry number of this logical request as seen by the caller (telemetry denominators, PAR-166). */
  attempt?: number;
  /** Privileged maintenance context (seeding, migration): bypasses purpose scoping; audited by actor. */
  maintenance?: boolean;
}

export const PAGE_DEFAULT = 50;
export const PAGE_MAX = 100;

export async function sha256(text: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Stable JSON for request hashing (sorted keys). */
export function stableJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stableJson).join(",")}]`;
  if (v && typeof v === "object") return `{${Object.keys(v as object).sort().map((k) => `${JSON.stringify(k)}:${stableJson((v as Wire)[k])}`).join(",")}}`;
  return JSON.stringify(v);
}

export interface EngineOptions {
  secrets?: import("./credentials.js").SecretAdapter;
  functions?: FunctionImpl[];
  externals?: Record<string, ExternalBinding>;
}

export class Engine {
  readonly functions: Functions;
  private readonly secrets: import("./credentials.js").SecretAdapter | undefined;
  constructor(readonly model: Model, readonly layer: Layer.Layer<RuntimeServices>, options: EngineOptions = {}) {
    this.secrets = options.secrets;
    this.functions = new Functions(this, options.functions ?? [], options.externals ?? {});
  }

  call(opId: string, input: unknown, ctx: CallContext): Effect.Effect<any, ForgeError> {
    const self = this;
    // Every public logical operation — generated or handwritten — emits exactly one telemetry event.
    const started = performance.now();
    return self.program(opId, input, ctx).pipe(
      Effect.provide(self.layer),
      Effect.tap(() => Effect.sync(() => self.telemetry.emit(opId, ctx, started, self.successStatus(opId)))),
      Effect.tapError((e) => Effect.sync(() => self.telemetry.emit(opId, ctx, started, e.status, e.code))),
    );
  }
  private successStatus(opId: string): number {
    const k = this.telemetry.entry(opId).kind;
    return k === "create" || k === "changeset.propose" ? 201 : 200;
  }

  /** Same as call() but without providing the layer (for use inside function bodies that share it). */
  callInternal(opId: string, input: unknown, ctx: CallContext): Effect.Effect<any, ForgeError, RuntimeServices> {
    return this.program(opId, input, ctx);
  }

  consume(subscription: string, env: Envelope) {
    return this.functions.consume(subscription, env);
  }

  private program(opId: string, input: unknown, ctx: CallContext): Effect.Effect<any, ForgeError, RuntimeServices> {
    const self = this;
    if (/\/changesets\.(propose|preview|approve|commit|get)$/.test(opId)) {
      return self.changesets.handle(opId.slice(opId.lastIndexOf(".") + 1), (input ?? {}) as Wire, ctx);
    }
    if (/\/imports\.(inspect|stage)$/.test(opId)) {
      return self.imports.handle(opId.slice(opId.lastIndexOf(".") + 1), (input ?? {}) as Wire, ctx);
    }
    if (/\/admin\.(export|import|verify|fence)$/.test(opId)) {
      return self.portability.handle(opId.slice(opId.lastIndexOf(".") + 1), (input ?? {}) as Wire, ctx);
    }
    if (/\/admin\.(subjects\.locate|inspect)$/.test(opId)) {
      return self.governance.handle(opId.slice(opId.indexOf("admin.") + 6), (input ?? {}) as Wire, ctx);
    }
    const ref = self.model.operation(opId);
    if (!ref) {
      const fn = self.model.function(opId);
      if (fn) return self.withIdempotency(opId, (input ?? {}) as Wire, ctx, self.functions.invoke(fn, input, ctx));
      const rm = self.readModel(opId, (input ?? {}) as Wire, ctx);
      if (rm) return rm;
      return Effect.fail(err("MethodNotAllowed", `unknown operation ${opId}`));
    }
    const { op, resource } = ref;
    const body = (input ?? {}) as Wire;
    return self.scope.resolve(resource, ctx).pipe(Effect.flatMap((surface) => (surface ? self.scopedOperation(surface, op, resource, body, ctx) : self.operation(opId, op, resource, body, ctx))));
  }

  /** A resource operation under a purpose surface: authority checked first, result projected last (plan §8.4–8.5). */
  private scopedOperation(surface: import("./scope.js").Surface, op: Operation, resource: Resource, body: Wire, ctx: CallContext): Effect.Effect<any, ForgeError, RuntimeServices> {
    const self = this;
    const project = (e: Effect.Effect<Wire, ForgeError, RuntimeServices>) => e.pipe(Effect.map((v) => self.scope.project(surface, v)));
    const projectPage = (e: Effect.Effect<Wire, ForgeError, RuntimeServices>) => e.pipe(Effect.map((v) => self.scope.projectPage(surface, v)));
    const run = (check: Effect.Effect<void, ForgeError>, then: Effect.Effect<Wire, ForgeError, RuntimeServices>) => check.pipe(Effect.flatMap(() => then));
    switch (op.kind) {
      case "get":
        return project(self.get(resource, String(body["id"]), ctx));
      case "find": {
        const f = resource.finds.find((x) => x.name === op.query)!;
        return run(self.scope.checkQuery(surface, resource, Object.fromEntries(f.fields.map((k) => [k, true])), []), project(self.find(resource, op.query!, body, ctx)));
      }
      case "list": {
        const l = resource.lists.find((x) => x.name === op.query)!;
        return run(self.scope.checkQuery(surface, resource, Object.fromEntries(l.fields.map((k) => [k, true])), l.order.map((o) => o.field)), projectPage(self.list(resource, op.id, op.query!, body, ctx)));
      }
      case "create":
        return run(self.scope.checkCreate(surface, resource, body), project(self.withIdempotency(op.id, body, ctx, self.mutate(op.id, body, ctx))));
      case "update":
        return run(self.scope.checkPatch(surface, resource, (body["patch"] ?? {}) as Wire), project(self.withIdempotency(op.id, body, ctx, self.mutate(op.id, body, ctx))));
      case "transition":
        return run(self.scope.checkAction(surface, resource, op.action!), project(self.withIdempotency(op.id, body, ctx, self.mutate(op.id, body, ctx))));
      case "delete":
      case "restore":
        return run(self.scope.checkAction(surface, resource, op.kind), project(self.withIdempotency(op.id, body, ctx, self.mutate(op.id, body, ctx))));
      default:
        // Temporal, hierarchy and blob operations expose record shapes too: project what they return.
        return project(self.operation(op.id, op, resource, body, ctx));
    }
  }

  private operation(opId: string, op: Operation, resource: Resource, body: Wire, ctx: CallContext): Effect.Effect<any, ForgeError, RuntimeServices> {
    const self = this;
    switch (op.kind) {
      case "get":
        return self.get(resource, String(body["id"]), ctx);
      case "find":
        return self.find(resource, op.query!, body, ctx);
      case "list":
        return self.list(resource, op.id, op.query!, body, ctx);
      case "create":
      case "update":
      case "delete":
      case "restore":
      case "transition":
        return self.withIdempotency(op.id, body, ctx, self.mutate(opId, body, ctx));
      case "effective":
        return self.temporal.effective(resource, op.query!, body, ctx);
      case "move":
        return self.withIdempotency(op.id, body, ctx, Effect.gen(function* () {
          const plan = yield* self.temporal.move(resource, body, ctx);
          yield* (yield* Storage).commit(plan);
          return self.resultOf(plan);
        }));
      case "children":
        return self.temporal.children(resource, body, ctx);
      case "ancestors":
        return self.temporal.ancestors(resource, body, ctx);
      case "beginUpload":
        return self.blobs.beginUpload(resource, body, ctx);
      case "finalizeUpload":
        return self.blobs.finalizeUpload(resource, body, ctx);
      case "download":
        return self.blobs.download(resource, body, ctx);
      default:
        return Effect.fail(err("MethodNotAllowed", `operation kind ${op.kind} is not executable`));
    }
  }

  /** Views (`.query`), projections (`.get|.status|.rebuild`) and caches (`.read`). */
  private readModel(opId: string, body: Wire, ctx: CallContext): Effect.Effect<any, ForgeError, RuntimeServices> | null {
    const dot = opId.lastIndexOf(".");
    const [base, action] = [opId.slice(0, dot), opId.slice(dot + 1)];
    const view = this.model.views.find((v) => v.id === base);
    if (view && action === "query") return this.readModels.view(view, body, ctx);
    const proj = this.model.projections.find((p) => p.id === base);
    if (proj && action === "get") return this.readModels.get(proj, body, ctx);
    if (proj && action === "status") return this.readModels.status(proj, ctx);
    if (proj && action === "rebuild") return this.readModels.rebuild(proj, ctx);
    const cache = this.model.caches.find((c) => c.id === base);
    if (cache && action === "read") {
      // PAR-143: a cached value is stored as loaded, but disclosed only through the caller's *current* surface
      // on the value's resource: a purpose narrowed since the load never sees what the broader load stored.
      const loader = cache.loader as { kind: string; callee?: string[] };
      const valueResource = loader.kind === "call" && loader.callee ? this.model.resources.find((r) => r.name === loader.callee![0]) : undefined;
      if (!valueResource) return this.readModels.read(cache, body, ctx);
      const self = this;
      return self.scope.resolve(valueResource, ctx).pipe(Effect.flatMap((surface) => self.readModels.read(cache, body, ctx).pipe(Effect.map((out) => (surface && out && typeof out["value"] === "object" && out["value"] !== null ? { ...out, value: self.scope.project(surface, out["value"] as Wire) } : out)))));
    }
    const src = this.model.sources.find((s) => s.id === base);
    if (src && action === "tick") return Effect.promise(() => Effect.runPromise(this.schedules.tick(ctx.tenant, String(body["now"] ?? new Date().toISOString())))).pipe(Effect.map((results) => ({ results })));
    if (src && action === "status") return Effect.promise(() => Effect.runPromise(this.schedules.status(ctx.tenant))).pipe(Effect.map((all) => all.find((x) => x.source === src.id) ?? { source: src.id, lastOccurrence: null, next: null, skipped: [] }));
    const wf = this.model.workflows.find((w) => w.id === base);
    if (wf && action === "start") return this.workflows.start(wf, body, ctx);
    if (wf && action === "get") return this.workflows.get(wf, String(body["id"]), ctx);
    if (wf && action === "cancel") return this.workflows.cancel(wf, String(body["id"]), ctx);
    if (wf && action === "signal") return this.workflows.signal(wf, String(body["message"]), String(body["messageId"] ?? crypto.randomUUID()), (body["payload"] ?? {}) as Wire, ctx);
    return null;
  }

  /** Build the commit plan for a mutation without persisting it (used by single calls and changeset preview). */
  planFor(opId: string, body: Wire, ctx: CallContext, preview = false): Effect.Effect<CommitPlan, ForgeError, RuntimeServices> {
    const self = this;
    const ref = self.model.operation(opId);
    if (!ref) return Effect.fail(err("MethodNotAllowed", `unknown operation ${opId}`));
    const { op, resource } = ref;
    if (preview && resource.fields.some(f=>f.secret) && ["create","update"].includes(op.kind)) return Effect.fail(err("ValidationFailed","credential writes cannot be previewed"));
    switch (op.kind) {
      case "create":
        if (preview && resource.fields.some(f=>f.sequence)) return Effect.fail(err("SequencePreviewUnsupported","sequence allocation requires a committed create; changeset previews cannot reserve numbers"));
        return self.create(resource, body, ctx);
      case "update":
        return self.update(resource, body, ctx);
      case "delete":
        return self.deleteOrRestore(resource, body, ctx, "delete");
      case "restore":
        return self.deleteOrRestore(resource, body, ctx, "restore");
      case "transition":
        return self.transition(resource, op.action!, body, ctx);
      default:
        return Effect.fail(err("MethodNotAllowed", `${opId} is not a mutation`));
    }
  }

  /** Canonical public result of a committed plan. */
  resultOf(plan: CommitPlan): Wire {
    return canonicalize(this.model, plan.resource, plan.hardDelete ? plan.before! : plan.after);
  }

  private mutate(opId: string, body: Wire, ctx: CallContext): Effect.Effect<Wire, ForgeError, RuntimeServices> {
    const self = this;
    return Effect.gen(function* () {
      if (yield* self.portability.isFenced(ctx.tenant)) return yield* Effect.fail(err("WriteFenced", "writes are fenced for a data migration; retry after cutover"));
      // A suppressed subject's data is never recreated or revived, whatever queued the write (PAR-158):
      // creates are checked on the request body before any reference lookup can answer for the ledger.
      const ref = self.model.operation(opId);
      if (ref?.op.kind === "create") yield* self.suppression.guard(ref.resource, "create", body as StoredRecord, ctx);
      const plan = yield* self.planFor(opId, body, ctx);
      // Authorize current AND candidate state (PAR-110): a permitted update cannot move the record out of scope.
      yield* self.gatekeeper.requireWrite(opId, plan.resource, ctx, plan.before ? canonicalize(self.model, plan.resource, plan.before) : null, canonicalize(self.model, plan.resource, plan.after));
      yield* self.suppression.guard(plan.resource, plan.kind, plan.after, ctx);
      yield* (yield* Storage).commit(plan);
      return self.resultOf(plan);
    });
  }

  readonly changesets = new Changesets(this);
  readonly blobs = new Blobs(this);
  readonly temporal = new Temporal(this);
  readonly imports = new Imports(this);
  readonly readModels = new ReadModels(this);
  readonly workflows = new Workflows(this);
  readonly schedules = new Schedules(this);
  readonly realtime = new Realtime(this);
  readonly telemetry = new Telemetry(this);
  readonly portability = new Portability(this);
  readonly governance = new Governance(this);
  readonly scope = new Scope(this);
  readonly gatekeeper = new Gatekeeper(this);
  readonly suppression = new Suppression(this);

  /** Test hook: advance the deterministic test clock (no effect with production clocks). */
  testClockJump(ms: number): void {
    testClocks.at(-1)?.jump(ms);
  }

  /** Every projection is one durable logical subscription on its source's change channel. */
  projectionSubscriptions(base: Record<string, string[]> = {}): Record<string, string[]> {
    const out: Record<string, string[]> = Object.fromEntries(Object.entries(base).map(([k, v]) => [k, [...v]]));
    for (const p of this.model.projections) (out[`${p.source}.changes`] ??= []).push(`projection:${p.name}`);
    return out;
  }

  /** In-process transport that applies change events to projections (the cloud hosts route queue batches here). */
  projectionTransport(): Transport {
    const self = this;
    return {
      name: "projections",
      send: (d) => {
        const p = self.model.projections.find((x) => `projection:${x.name}` === d.subscription);
        if (!p) return Effect.fail(new Error(`unknown projection subscription ${d.subscription}`));
        return self.readModels.applyEvent(p, d.envelope).pipe(Effect.provide(self.layer), Effect.asVoid, Effect.mapError((e) => new Error(e.message)));
      },
    };
  }

  applyProjectionEvent(projectionId: string, env: Envelope): Promise<"applied" | "stale" | "ignored"> {
    const p = this.model.projections.find((x) => x.id === projectionId);
    if (!p) return Promise.reject(new Error(`unknown projection ${projectionId}`));
    return Effect.runPromise(this.readModels.applyEvent(p, env).pipe(Effect.provide(this.layer)));
  }

  // ------------------------------------------------------------ helpers
  claimKey(r: Resource, u: Unique, rec: Wire): string | null {
    if (u.condition && !u.condition.values.includes(String(rec[u.condition.field]))) return null;
    const self = this;
    const fields = [...u.within, ...u.fields];
    const values = fields.map((f) => rec[f]);
    if (values.some((v) => v === null || v === undefined)) return null; // optional nulls reserve no claim
    return encodeIdentity([r.id, u.name, ...values.map(String)]);
  }

  /** Claims and guards for an imported record (plan §22): the same rules a create would apply. */
  claimChangesFor(r: Resource, rec: Wire): ClaimChange[] {
    return this.claimChanges(r, null, rec);
  }
  referenceGuardsFor(r: Resource, rec: Wire): ReferenceGuard[] {
    return this.referenceGuards(r, rec, null);
  }

  private claimChanges(r: Resource, before: Wire | null, after: Wire): ClaimChange[] {
    const self = this;
    return r.uniques.map((unique) => ({ unique, before: before ? self.claimKey(r, unique, before) : null, after: self.claimKey(r, unique, after) }));
  }

  private referenceGuards(r: Resource, after: Wire, changed: Set<string> | null): ReferenceGuard[] {
    const self = this;
    const out: ReferenceGuard[] = [];
    for (const f of r.fields) {
      if (f.type.base.kind !== "reference" || (f.synthesized && f.name !== "parent")) continue;
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
    if (self.model.bundle.ir.requires?.includes("collections/1") && new TextEncoder().encode(JSON.stringify(after)).length > 256 * 1024) {
      return Effect.fail(err("ValidationFailed", "record exceeds the 256 KiB collection profile limit"));
    }
    const failures = r.rules.filter((rule) => !evalExpr(self.model, r, rule, after, undefined, refs));
    if (failures.length === 0) return Effect.void;
    return Effect.fail(err("ValidationFailed", "a row rule was violated", { fields: failures.map((rule) => ({ path: "", code: "RuleViolation", message: describeRule(rule) })) }));
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
    return { tenant: ctx.tenant, opId, resource: r.id, recordId: id, kind, newVersion: typeof after["version"] === "number" ? (after["version"] as number) : null, actor: ctx.actor, at };
  }

  /** Audited resources stage one change event per commit on their implicit `<Resource>.changes` channel. */
  private changeEvent(r: Resource, kind: string, id: string, after: Wire, ctx: CallContext, opId: string, at: string) {
    if (!r.decorators.audited) return [];
    const message = ({ create: "Created", update: "Updated", delete: "Deleted", restore: "Restored" } as Record<string, string>)[kind] ?? "Transitioned";
    const extra = kind.startsWith("status.") && r.lifecycle ? { action: kind.slice(7), status: after[r.lifecycle.field] } : {};
    return [{ tenant: ctx.tenant, opId, ordinal: 0, channel: `${r.id}.changes`, message, payload: { id, version: after["version"] ?? null, ...extra }, createdAt: at, ...(ctx.trace ? { trace: ctx.trace } : {}) }];
  }

  private sealSecrets(r:Resource,record:Wire,changed:Wire,ctx:CallContext):Effect.Effect<void,ForgeError> {
    const self=this;
    return Effect.gen(function*(){
      for(const field of r.fields) {
        if(!field.secret || !Object.hasOwn(changed,field.name) || record[field.name]===null) continue;
        if(!self.secrets) return yield* Effect.fail(err("DependencyUnavailable","credential sealing adapter is not configured"));
        record[field.name]=yield* Effect.tryPromise({try:()=>self.secrets!.seal({tenant:ctx.tenant,resource:r.id,record:String(record["id"]),field:field.name},String(record[field.name])),catch:()=>err("DependencyUnavailable","credential sealing failed")});
      }
    });
  }

  // ------------------------------------------------------------ create
  private create(r: Resource, body: Wire, ctx: CallContext): Effect.Effect<CommitPlan, ForgeError, RuntimeServices> {
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
      if (r.kind === "blob") {
        after["uploadState"] = "intent";
        after["mediaType"] = null;
        after["byteCount"] = null;
        after["digest"] = null;
      }
      for (const field of r.fields) {
        if (!field.sequence) continue;
        const sequence = field.sequence;
        const partition = sequence.partition ? after[sequence.partition] : null;
        const key = JSON.stringify([r.id,field.name,partition]);
        const storage = yield* Storage;
        let allocated = false;
        for (let attempt=0; attempt<64; attempt++) {
          const current = yield* storage.getDocument(ctx.tenant,"sequence",key);
          const last = current?.["last"];
          const next = last === undefined ? sequence.start : Number(last)+1;
          if (!Number.isSafeInteger(next) || next < sequence.start || next > sequence.max) {
            return yield* Effect.fail(err("SequenceExhausted", `sequence ${r.name}.${field.name} is exhausted or requires migration`));
          }
          const reservation = yield* storage.putDocument(ctx.tenant,"sequence",key,{last:next},(current?.["_version"] as number | undefined) ?? null).pipe(Effect.exit);
          if (reservation._tag === "Success") {after[field.name]=next; allocated=true;break;}
          const error = Cause.squash(reservation.cause);
          if (!(error instanceof ForgeError) || error.code !== "VersionConflict") return yield* Effect.fail(error instanceof ForgeError ? error : err("Internal","sequence reservation failed"));
        }
        if (!allocated) return yield* Effect.fail(err("TransientConflict","sequence contention; retry the operation"));
      }
      yield* self.sealSecrets(r,after,value,ctx);
      const guards = self.referenceGuards(r, after, null);
      const refs = yield* self.loadReferences(r, after, ctx, guards);
      yield* self.checkRules(r, after, refs);
      const interval = yield* self.temporal.intervalGuard(r, after, id);
      yield* self.temporal.checkOverlap(r, interval, ctx);
      const tree = yield* self.temporal.treeGuard(r, id, typeof after["parent"] === "string" ? (after["parent"] as string) : null, ctx);
      const opId = ids.opId();
      const plan: CommitPlan = {
        tenant: ctx.tenant, opId, actor: ctx.actor, at: now, resource: r, kind: "create", id, expectedVersion: null, before: null, after,
        claims: self.claimChanges(r, null, after), references: guards, dependents: [], hardDelete: false,
        ...(interval ? { interval } : {}), ...(tree ? { tree } : {}),
        audit: self.audit("create", r, id, after, ctx, opId, now), outbox: self.changeEvent(r, "create", id, after, ctx, opId, now),
      };
      return plan;
    });
  }

  // ------------------------------------------------------------ get/find/list
  private get(r: Resource, id: string, ctx: CallContext): Effect.Effect<Wire, ForgeError, RuntimeServices> {
    const self = this;
    return Effect.gen(function* () {
      const storage = yield* Storage;
      const rec = yield* storage.get(ctx.tenant, r, id);
      if (!rec || rec["deletedAt"]) return yield* Effect.fail(err("NotFound", `${r.name} ${id} not found`));
      const canon = canonicalize(self.model, r, rec);
      yield* self.gatekeeper.requireRead(`${r.id}.get`, r, ctx, canon); // per record, every time (PAR-109)
      return canon;
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
      const rec = key ? yield* storage.findUnique(ctx.tenant, r, unique, key, values) : null;
      if (!rec || rec["deletedAt"]) return yield* Effect.fail(err("NotFound", `${r.name} not found`));
      const canon = canonicalize(self.model, r, rec);
      yield* self.gatekeeper.requireRead(`${r.id}.find.${query}`, r, ctx, canon);
      return canon;
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
      let after: { keys: string[]; values: unknown[]; id: string } | null = null;
      if (typeof body["cursor"] === "string" && body["cursor"]) {
        const state = yield* decodeCursor(secret, body["cursor"], { q: opId, t: ctx.tenant });
        after = { keys: state.k, values: state.r, id: state.id };
      }
      const storage = yield* Storage;
      const keys = self.sortKeys(r, l);
      const page = yield* storage.list(ctx.tenant, r, { list: l, values, after, limit }, keys);
      let items = page.records.map((rec) => canonicalize(self.model, r, rec));
      // Policy filtering (plan §9.2): exact when the predicate is on the query's own parameters, otherwise a
      // bounded residual check per row of this page; an unresolvable predicate is refused, never a hidden scan.
      const plan = self.gatekeeper.listPlan(opId, r, ctx, values);
      if (plan.kind === "unsupported") return yield* Effect.fail(err("NotPermitted", plan.reason ?? "policy filter cannot be planned"));
      if (plan.kind === "exact") {
        const denied = plan.filter.some((c) => (c.op === "in" && !c.values.includes(values[c.field])) || (c.op === "eq" && values[c.field] !== c.values[0]) || (c.op === "ne" && c.values.includes(values[c.field])));
        if (denied) items = [];
      } else if (plan.kind === "candidate") {
        const kept: Wire[] = [];
        for (const it of items) {
          const d = yield* self.gatekeeper.decide(opId, "read", r, ctx, it);
          if (d.effect === "allow") kept.push(it);
        }
        items = kept;
      }
      let next: string | null = null;
      if (page.hasMore && page.records.length) {
        const last = page.records[page.records.length - 1]!;
        next = yield* encodeCursor(secret, { q: opId, v: 1, t: ctx.tenant, k: keys(last), r: l.order.map((o) => last[o.field] ?? null), id: String(last["id"]) });
      }
      return { items, next, limit, ...(plan.kind !== "none" ? { plan: { kind: plan.kind, ...(plan.policy ? { policy: plan.policy } : {}) } } : {}) };
    });
  }

  // ------------------------------------------------------------ update
  private update(r: Resource, body: Wire, ctx: CallContext): Effect.Effect<CommitPlan, ForgeError, RuntimeServices> {
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
      yield* self.sealSecrets(r,after,patch,ctx);
      const guards = self.referenceGuards(r, after, new Set(Object.keys(patch)));
      const refs = yield* self.loadReferences(r, after, ctx, guards);
      yield* self.checkRules(r, after, refs);
      const intervalChanged = "effectiveFrom" in patch || "effectiveUntil" in patch || r.decorators.effectiveDated?.uniqueBy.some((f) => f in patch);
      const interval = intervalChanged ? yield* self.temporal.intervalGuard(r, after, id) : undefined;
      yield* self.temporal.checkOverlap(r, interval, ctx);
      const tree = "parent" in patch ? yield* self.temporal.treeGuard(r, id, typeof after["parent"] === "string" ? (after["parent"] as string) : null, ctx) : undefined;
      const opId = ids.opId();
      const plan: CommitPlan = {
        tenant: ctx.tenant, opId, actor: ctx.actor, at: now, resource: r, kind: "update", id, expectedVersion: expected, before, after,
        claims: self.claimChanges(r, before, after), references: guards, dependents: [], hardDelete: false,
        ...(interval ? { interval } : {}), ...(tree ? { tree } : {}),
        audit: self.audit("update", r, id, after, ctx, opId, now), outbox: self.changeEvent(r, "update", id, after, ctx, opId, now),
      };
      return plan;
    });
  }

  // ------------------------------------------------------------ delete/restore
  private deleteOrRestore(r: Resource, body: Wire, ctx: CallContext, kind: "delete" | "restore"): Effect.Effect<CommitPlan, ForgeError, RuntimeServices> {
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
      const hardDelete = kind === "delete" && !r.decorators.softDelete;
      const after: Wire = { ...before };
      if (r.decorators.softDelete) after["deletedAt"] = kind === "delete" ? now : null;
      if (r.decorators.versioned) after["version"] = (before["version"] as number) + 1;
      if (r.decorators.timestamps) after["updatedAt"] = now;
      // restrict-delete: pre-check for a good error, then the adapter re-checks at commit
      const dependents = kind === "delete" ? self.model.dependentsOf(r.id) : [];
      if (kind === "delete") {
        const storage = yield* Storage;
        for (const d of dependents) {
          const n = yield* storage.countDependents(ctx.tenant, d.resource, d.field, id);
          if (n > 0) return yield* Effect.fail(err("HasDependents", `${r.name} ${id} is referenced by ${n} live ${d.resource.name} record(s) through ${d.resource.name}.${d.field}`));
        }
      }
      const opId = ids.opId();
      const plan: CommitPlan = {
        tenant: ctx.tenant, opId, actor: ctx.actor, at: now, resource: r, kind, id, expectedVersion: expected, before, after,
        claims: hardDelete ? self.claimChanges(r, before, {}) : [], references: [], dependents, hardDelete,
        audit: self.audit(kind, r, id, after, ctx, opId, now), outbox: self.changeEvent(r, kind, id, after, ctx, opId, now),
      };
      return plan;
    });
  }

  // ------------------------------------------------------------ transition
  private transition(r: Resource, action: string, body: Wire, ctx: CallContext): Effect.Effect<CommitPlan, ForgeError, RuntimeServices> {
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
        claims: self.claimChanges(r, before, after), references: [], dependents: [], hardDelete: false,
        audit: { ...self.audit(`status.${action}`, r, id, after, ctx, opId, now), payload: input }, outbox: self.changeEvent(r, `status.${action}`, id, after, ctx, opId, now),
      };
      return plan;
    });
  }

  // ------------------------------------------------------------ idempotency
  /** Run a mutation under an idempotency receipt: replay on the same key + request, conflict on a different request. */
  withIdempotency(operation: string, body: Wire, ctx: CallContext, run: Effect.Effect<Wire, ForgeError, RuntimeServices>, explicitKey?: string): Effect.Effect<Wire, ForgeError, RuntimeServices> {
    const self = this;
    const key = explicitKey ?? ctx.idempotencyKey;
    if (!key) return run;
    return Effect.gen(function* () {
      const storage = yield* Storage;
      const requestHash = yield* Effect.promise(() => sha256(stableJson(body)));
      const existing = yield* storage.getReceipt(ctx.tenant, operation, key);
      if (existing) {
        if (existing.requestHash !== requestHash) return yield* Effect.fail(err("IdempotencyMismatch", "idempotency key reused with a different request"));
        // Reuse repeats no effect, but the stored response is disclosed only under current authority (PAR-112).
        const ref = self.model.operation(operation);
        const stored = existing.response as Wire;
        const d = yield* self.gatekeeper.decide(operation, "replay", ref?.resource ?? null, ctx, stored && typeof stored === "object" && "id" in stored ? stored : undefined);
        if (d.effect !== "allow") return yield* Effect.fail(err("NotPermitted", "the stored result of this request is no longer accessible under current authority"));
        return stored;
      }
      const clock = yield* Clock;
      const receipt: Receipt = { tenant: ctx.tenant, operation, key, requestHash, status: 200, response: null, createdAt: clock.now() };
      return yield* runWithReceipt(run, receipt);
    });

    function runWithReceipt(inner: Effect.Effect<Wire, ForgeError, RuntimeServices>, receipt: Receipt) {
      // The receipt is attached to the plan by intercepting Storage.commit: we wrap the storage service.
      return Effect.gen(function* () {
        const storage = yield* Storage;
        // Explicit delegation: spreading a class instance would drop prototype methods.
        const wrapped: StorageAdapter = {
          name: storage.name,
          get: (...a) => storage.get(...a),
          findUnique: (...a) => storage.findUnique(...a),
          list: (...a) => storage.list(...a),
          countDependents: (...a) => storage.countDependents(...a),
          getReceipt: (...a) => storage.getReceipt(...a),
          commitAll: (...a) => storage.commitAll(...a),
          budget: (...a) => storage.budget(...a),
          getDocument: (...a) => storage.getDocument(...a),
          exportPage: (...a) => storage.exportPage(...a),
          putDocument: (...a) => storage.putDocument(...a),
          putDocuments: (...a) => storage.putDocuments(...a),
          outboxSweep: (...a) => storage.outboxSweep(...a),
          outboxTenants: () => storage.outboxTenants(),
          outboxClaim: (...a) => storage.outboxClaim(...a),
          outboxProgress: (...a) => storage.outboxProgress(...a),
          outboxDead: (...a) => storage.outboxDead(...a),
          outboxRedrive: (...a) => storage.outboxRedrive(...a),
          markProcessed: (...a) => storage.markProcessed(...a),
          overlapping: (...a) => storage.overlapping(...a),
          effectiveAt: (...a) => storage.effectiveAt(...a),
          children: (...a) => storage.children(...a),
          commit: (plan: CommitPlan) => storage.commit({ ...plan, receipt: { ...receipt, response: self.resultOf(plan) } }),
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
