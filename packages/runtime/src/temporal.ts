/**
 * Effective dating and hierarchy (plan §18), as engine extensions. The engine
 * computes the guards during planning; every adapter re-checks them at commit
 * (D1: predicate in the assertion batch; DynamoDB: per-group revision guard).
 */
import { Effect } from "effect";
import type { Wire } from "./decode.js";
import { canonicalize } from "./decode.js";
import type { CallContext, Engine } from "./engine.js";
import { err, type ForgeError } from "./errors.js";
import type { Resource } from "./model.js";
import { Storage, type CommitPlan, type IntervalGuard, type RuntimeServices, type StoredRecord, type TreeGuard } from "./services.js";

export const MAX_DEPTH = 32;
export const TRAVERSAL_LIMIT = 100;

export class Temporal {
  constructor(private readonly engine: Engine) {}

  /** Validate the interval of a candidate record and produce its overlap guard. */
  intervalGuard(r: Resource, after: Wire, id: string): Effect.Effect<IntervalGuard | undefined, ForgeError> {
    const ed = r.decorators.effectiveDated;
    if (!ed) return Effect.succeed(undefined);
    const from = after["effectiveFrom"];
    const until = (after["effectiveUntil"] ?? null) as string | null;
    if (typeof from !== "string") return Effect.fail(err("ValidationFailed", "effectiveFrom is required", { fields: [{ path: "effectiveFrom", code: "Required", message: "effective-dated records need a start instant" }] }));
    if (until !== null && until <= from) return Effect.fail(err("ValidationFailed", "effectiveUntil must be after effectiveFrom", { fields: [{ path: "effectiveUntil", code: "EmptyInterval", message: `[${from}, ${until}) is empty` }] }));
    return Effect.succeed({ groupFields: ed.uniqueBy, groupValues: ed.uniqueBy.map((f) => after[f]), from, until, excludeId: id });
  }

  /** Pre-check for a precise error; the adapter re-checks atomically. */
  checkOverlap(r: Resource, guard: IntervalGuard | undefined, ctx: CallContext): Effect.Effect<void, ForgeError, RuntimeServices> {
    if (!guard) return Effect.void;
    return Effect.gen(function* () {
      const others = yield* (yield* Storage).overlapping(ctx.tenant, r, guard);
      if (others.length) {
        return yield* Effect.fail(err("ValidationFailed", `interval overlaps ${others.length} existing record(s) in the same ${guard.groupFields.join("+")} group`, { fields: [{ path: "effectiveFrom", code: "IntervalOverlap", message: `overlaps ${others.map((o) => o["id"]).join(", ")}` }], constraint: `${r.id}.effective.${guard.groupFields.join("_")}` }));
      }
    });
  }

  /** `effective(group, at)` → zero-or-one. */
  effective(r: Resource, query: string, body: Wire, ctx: CallContext): Effect.Effect<Wire, ForgeError, RuntimeServices> {
    const self = this;
    return Effect.gen(function* () {
      const ed = r.decorators.effectiveDated!;
      const params = (body["params"] ?? {}) as Wire;
      const at = params["at"];
      if (typeof at !== "string") return yield* Effect.fail(err("ValidationFailed", "`at` is required", { fields: [{ path: "at", code: "Required", message: "instant to evaluate" }] }));
      const values = ed.uniqueBy.map((f) => params[f]);
      if (values.some((v) => v === undefined)) return yield* Effect.fail(err("ValidationFailed", `parameters ${ed.uniqueBy.join(", ")} are required`));
      void query;
      const rec = yield* (yield* Storage).effectiveAt(ctx.tenant, r, ed.uniqueBy, values, new Date(at).toISOString());
      if (!rec) return yield* Effect.fail(err("NotFound", `no ${r.name} effective at ${at}`));
      return canonicalize(self.engine.model, r, rec);
    });
  }

  /** Walk parents from `startId`; fail on cycles or excessive depth. Returns the ancestor ids, nearest first. */
  ancestorsOf(r: Resource, startId: string, ctx: CallContext): Effect.Effect<StoredRecord[], ForgeError, RuntimeServices> {
    return Effect.gen(function* () {
      const storage = yield* Storage;
      const chain: StoredRecord[] = [];
      let cur = startId;
      const seen = new Set<string>([startId]);
      for (let depth = 0; depth < MAX_DEPTH; depth++) {
        const rec = yield* storage.get(ctx.tenant, r, cur);
        if (!rec) break;
        const p = rec["parent"];
        if (typeof p !== "string" || !p) break;
        if (seen.has(p)) return yield* Effect.fail(err("Internal", `cycle detected in ${r.name} hierarchy at ${p}`));
        seen.add(p);
        const parent = yield* storage.get(ctx.tenant, r, p);
        if (!parent) break;
        chain.push(parent);
        cur = p;
      }
      return chain;
    });
  }

  /** Produce the tree guard for a create/move that sets `parent`. */
  treeGuard(r: Resource, id: string, parentId: string | null, ctx: CallContext): Effect.Effect<TreeGuard | undefined, ForgeError, RuntimeServices> {
    const self = this;
    if (!r.decorators.hierarchical || !parentId) return Effect.succeed(undefined);
    return Effect.gen(function* () {
      if (parentId === id) return yield* Effect.fail(err("ValidationFailed", "a node cannot be its own parent", { fields: [{ path: "parent", code: "SelfParent", message: "parent must be a different node" }] }));
      const parent = yield* (yield* Storage).get(ctx.tenant, r, parentId);
      if (!parent || parent["deletedAt"]) return yield* Effect.fail(err("ReferenceMissing", "parent does not reference a live node in this tenant"));
      const chain = yield* self.ancestorsOf(r, parentId, ctx);
      const ancestors = [parentId, ...chain.map((a) => String(a["id"]))];
      if (ancestors.includes(id)) return yield* Effect.fail(err("ValidationFailed", "move would create a cycle", { fields: [{ path: "parent", code: "Cycle", message: `${parentId} is a descendant of ${id}` }] }));
      if (ancestors.length >= MAX_DEPTH) return yield* Effect.fail(err("ValidationFailed", `hierarchy deeper than ${MAX_DEPTH}`, { fields: [{ path: "parent", code: "TooDeep", message: "depth limit" }] }));
      return { parentField: "parent", parentId, ancestors };
    });
  }

  move(r: Resource, body: Wire, ctx: CallContext): Effect.Effect<CommitPlan, ForgeError, RuntimeServices> {
    const self = this;
    return Effect.gen(function* () {
      const id = String(body["id"]);
      const parent = body["parent"] === undefined ? null : (body["parent"] as string | null);
      const patchBody = { id, expectedVersion: body["expectedVersion"], patch: { parent } };
      const plan = yield* self.engine.planFor(`${r.id}.update`, patchBody, ctx);
      return plan;
    });
  }

  children(r: Resource, body: Wire, ctx: CallContext): Effect.Effect<Wire, ForgeError, RuntimeServices> {
    const self = this;
    return Effect.gen(function* () {
      const id = String(body["id"]);
      const rows = yield* (yield* Storage).children(ctx.tenant, r, "parent", id, TRAVERSAL_LIMIT);
      return { items: rows.map((x) => canonicalize(self.engine.model, r, x)), next: null, limit: TRAVERSAL_LIMIT };
    });
  }

  ancestors(r: Resource, body: Wire, ctx: CallContext): Effect.Effect<Wire, ForgeError, RuntimeServices> {
    const self = this;
    return Effect.gen(function* () {
      const id = String(body["id"]);
      const storage = yield* Storage;
      const rec = yield* storage.get(ctx.tenant, r, id);
      if (!rec || rec["deletedAt"]) return yield* Effect.fail(err("NotFound", `${r.name} ${id} not found`));
      const chain = yield* self.ancestorsOf(r, id, ctx);
      return { items: chain.map((x) => canonicalize(self.engine.model, r, x)), next: null, limit: MAX_DEPTH };
    });
  }
}
