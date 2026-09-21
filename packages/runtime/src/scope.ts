/**
 * Purpose scoping at runtime (plan §8.4–8.5, M12). The compiled
 * `capabilities/1` plan is the static ceiling: a call under a purpose on a
 * `@purposeScoped` resource is checked *before* execution (filter/order
 * params, patch fields, named actions) and its result is rebuilt as a new
 * object holding only the surface's read fields (a cast never removes keys).
 * Runtime restrictions only intersect this ceiling (D09); several purposes in
 * one invocation are refused rather than unioned (PAR-102). Each (resource,
 * purpose) reader is a distinct Effect service key (PAR-103).
 */
import { Context, Effect } from "effect";
import type { Wire } from "./decode.js";
import type { CallContext, Engine } from "./engine.js";
import { err, type ForgeError } from "./errors.js";
import type { Resource } from "./model.js";

export interface SurfaceAtom { verb: string; name: string; origin: string[] }
export interface Surface { resource: string; purpose: string; capabilities: string[]; allowAtoms: SurfaceAtom[]; deny: SurfaceAtom[]; digest: string }
export interface CapabilitiesPlan { version: string; surfaces: Surface[] }

const VISIBLE_ALWAYS = new Set<string>(); // nothing is implicit: even `id` must be granted

export class Scope {
  constructor(private readonly engine: Engine) {}

  private plan(): CapabilitiesPlan | null {
    return (this.engine.model.bundle as { capabilities?: CapabilitiesPlan }).capabilities ?? null;
  }
  private strict(): boolean {
    return this.engine.model.bundle.ir.package.edition === "2027";
  }
  private scoped(r: Resource): boolean {
    return Boolean(r.decorators.purposeScoped);
  }

  /** Surface for (resource, purpose): `null` when the purpose has no binding on the resource. */
  surface(resourceId: string, purpose: string): Surface | null {
    return this.plan()?.surfaces.find((s) => s.resource === resourceId && s.purpose === purpose) ?? null;
  }
  permits(s: Surface, verb: string, name: string): boolean {
    return s.allowAtoms.some((a) => a.verb === verb && a.name === name) || VISIBLE_ALWAYS.has(name);
  }

  /**
   * Resolve the surface a call runs under, or `null` when scoping does not apply
   * (resource not purpose-scoped, or a privileged maintenance context). Fails when
   * a scoped resource is used without a usable purpose.
   */
  resolve(r: Resource, ctx: CallContext): Effect.Effect<Surface | null, ForgeError> {
    if (!this.scoped(r)) return Effect.succeed(null);
    if (ctx.maintenance) return Effect.succeed(null); // explicitly privileged; audited as such by the actor
    if (!ctx.purpose) {
      if (!this.strict()) return Effect.succeed(null);
      return Effect.fail(err("NotPermitted", `${r.name} is purpose-scoped; an interface must select a purpose surface`));
    }
    if (ctx.purpose.includes(",")) return Effect.fail(err("ValidationFailed", "one purpose per invocation: purposes are not unioned at runtime; declare a composite purpose with its own surface", { fields: [{ path: "purpose", code: "MultiplePurposes", message: ctx.purpose }] }));
    const s = this.surface(r.id, ctx.purpose);
    if (!s) return Effect.fail(err("NotPermitted", `purpose ${ctx.purpose} has no surface on ${r.name} (taxonomy relationships grant nothing)`));
    return Effect.succeed(s);
  }

  /** Query authority is separate from read authority: every partition and order key must be granted. */
  checkQuery(s: Surface, r: Resource, params: Record<string, unknown>, order: string[]): Effect.Effect<void, ForgeError> {
    for (const f of Object.keys(params)) {
      if (!this.permits(s, "filter", f)) return Effect.fail(err("NotPermitted", `surface ${s.purpose} on ${r.name} grants no filter on \`${f}\` (a hidden field must not become a query oracle)`));
    }
    for (const f of order) {
      if (f === "id") continue; // the planner's deterministic tie-breaker: structural, reveals no content
      if (!this.permits(s, "order", f) && !this.permits(s, "filter", f)) return Effect.fail(err("NotPermitted", `surface ${s.purpose} on ${r.name} grants no ordering by \`${f}\``));
    }
    return Effect.void;
  }

  checkPatch(s: Surface, r: Resource, patch: Record<string, unknown>): Effect.Effect<void, ForgeError> {
    for (const f of Object.keys(patch)) {
      if (!this.permits(s, "update", f)) return Effect.fail(err("NotPermitted", `surface ${s.purpose} on ${r.name} grants no update of \`${f}\``));
    }
    return Effect.void;
  }

  checkCreate(s: Surface, r: Resource, input: Record<string, unknown>): Effect.Effect<void, ForgeError> {
    for (const f of Object.keys(input)) {
      if (!this.permits(s, "create", f)) return Effect.fail(err("NotPermitted", `surface ${s.purpose} on ${r.name} grants no create of \`${f}\``));
    }
    return Effect.void;
  }

  checkAction(s: Surface, r: Resource, action: string): Effect.Effect<void, ForgeError> {
    if (!this.permits(s, "actions", `status.${action}`)) return Effect.fail(err("NotPermitted", `surface ${s.purpose} on ${r.name} grants no action \`${action}\``));
    return Effect.void;
  }

  /** A new object with only the granted read fields — never the stored object narrowed by a cast. */
  project(s: Surface, record: Wire): Wire {
    const out: Wire = {};
    for (const a of s.allowAtoms) if (a.verb === "read" && a.name in record) out[a.name] = record[a.name];
    return out;
  }
  projectPage(s: Surface, page: Wire): Wire {
    return { ...page, items: (page["items"] as Wire[]).map((i) => this.project(s, i)) };
  }
}

// ------------------------------------------------------------ nominal readers
export interface ScopedReaderShape {
  get(id: string, ctx: CallContext): Effect.Effect<Wire, ForgeError>;
  list(query: string, params: Wire, ctx: CallContext, page?: { cursor?: string; limit?: number }): Effect.Effect<Wire, ForgeError>;
}
export interface ScopedReader {
  key: string;
  surface: Surface;
  /** A distinct Effect service per (resource, purpose): providing another reader's service does not satisfy it. */
  service: Context.Service<ScopedReaderShape, ScopedReaderShape>;
  reader: ScopedReaderShape;
}

const keys = new Map<string, Context.Service<ScopedReaderShape, ScopedReaderShape>>();

export function scopedReader(engine: Engine, resourceId: string, purpose: string): ScopedReader {
  const surface = engine.scope.surface(resourceId, purpose);
  if (!surface) throw new Error(`purpose ${purpose} has no surface on ${resourceId}`);
  const key = `forge/scoped/${resourceId}/${purpose}/${surface.digest}`;
  let service = keys.get(key);
  if (!service) {
    service = Context.Service<ScopedReaderShape, ScopedReaderShape>()(key) as unknown as Context.Service<ScopedReaderShape, ScopedReaderShape>;
    keys.set(key, service);
  }
  const reader: ScopedReaderShape = {
    get: (id, ctx) => engine.call(`${resourceId}.get`, { id }, { ...ctx, purpose }),
    list: (query, params, ctx, page) => engine.call(`${resourceId}.list.${query}`, { params, ...(page ?? {}) }, { ...ctx, purpose }),
  };
  return { key, surface, service, reader };
}
