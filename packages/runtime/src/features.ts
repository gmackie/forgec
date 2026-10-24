/**
 * Runtime features (FORG-37). The engine's optional parts, each a value a host links into
 * `EngineCore` (`options.features`), so a Worker bundles only the features its model uses. Nothing here
 * runs on import: a bundler keeps exactly the features a host names and drops the rest.
 *
 *   import { EngineCore } from "@forgegraph/runtime";
 *   import { workflows, schedules } from "@forgegraph/runtime/features";
 *   const engine = new EngineCore(model, layer, { features: [workflows, schedules] });
 *
 * `Engine` (and every host's `createWorker`) links `allFeatures`. `requiredFeatures(model)` is what a
 * model needs; `EngineCore` refuses a model that uses a feature it was not given, so a slice linked
 * with too few features fails when it is built (at link time for the packed linker), not on a request.
 */
import { Blobs } from "./blobs.js";
import { Changesets } from "./changeset.js";
import { Dispatcher, type DispatcherOptions, type Transport } from "./dispatch.js";
import type { EngineCore } from "./engine.js";
import { Governance } from "./governance.js";
import { Imports } from "./imports.js";
import type { Model } from "./model.js";
import { Portability } from "./portability.js";
import { internalSubscriptions, ReadModels, withProjections } from "./readmodels.js";
import { Realtime } from "./realtime.js";
import { Schedules } from "./schedules.js";
import type { StorageAdapter } from "./services.js";
import { Workflows } from "./workflows.js";

/** Local outbox delivery: a dispatcher over every subscription this engine's model knows. */
export interface OutboxDelivery {
  /**
   * In-process consumers (projections, workflow waits, realtime streams) are delivered here; every other
   * subscription goes to `transport` (the host's queues).
   */
  dispatcher(storage: StorageAdapter, transport: Transport, options?: Omit<DispatcherOptions, "subscriptions">): Dispatcher;
}

export interface FeatureMap {
  changesets: Changesets;
  imports: Imports;
  portability: Portability;
  governance: Governance;
  blobs: Blobs;
  readModels: ReadModels;
  workflows: Workflows;
  schedules: Schedules;
  realtime: Realtime;
  dispatch: OutboxDelivery;
}
export type FeatureName = keyof FeatureMap;

export interface Feature<N extends FeatureName = FeatureName> {
  readonly name: N;
  create(engine: EngineCore): FeatureMap[N];
}

/** Changeset propose/preview/approve/commit (`/changesets`). */
export const changesets: Feature<"changesets"> = { name: "changesets", create: (e) => new Changesets(e) };
/** CSV inspect/stage (`/imports`); stages through changesets. */
export const imports: Feature<"imports"> = { name: "imports", create: (e) => new Imports(e) };
/** Tenant export/import/verify and the write fence switch (`admin.*`). Every writer honours a fence without it. */
export const portability: Feature<"portability"> = { name: "portability", create: (e) => new Portability(e) };
/** Subject location, inspection, legal holds and content readability. */
export const governance: Feature<"governance"> = { name: "governance", create: (e) => new Governance(e) };
/** Blob resources: upload, finalize, download. */
export const blobs: Feature<"blobs"> = { name: "blobs", create: (e) => new Blobs(e) };
/** Views, projections and caches. */
export const readModels: Feature<"readModels"> = { name: "readModels", create: (e) => new ReadModels(e) };
/** Durable workflows: start, signal, cancel, advance, sweep. */
export const workflows: Feature<"workflows"> = { name: "workflows", create: (e) => new Workflows(e) };
/** Cron and tick schedules. */
export const schedules: Feature<"schedules"> = { name: "schedules", create: (e) => new Schedules(e) };
/** Realtime streams (WebSocket channels). */
export const realtime: Feature<"realtime"> = { name: "realtime", create: (e) => new Realtime(e) };
/** Local outbox delivery (the in-process dispatcher). A Worker that forwards dispatch elsewhere omits it. */
export const dispatch: Feature<"dispatch"> = {
  name: "dispatch",
  create: (engine) => ({
    dispatcher(storage, transport, options = { leaseMs: 30_000, maxAttempts: 8 }) {
      const subscriptions: Record<string, string[]> = {};
      for (const s of engine.model.bundle.messaging?.subscriptions ?? []) (subscriptions[s.channel] ??= []).push(s.name);
      return new Dispatcher(engine.model, storage, withProjections(engine, transport), { ...options, subscriptions: internalSubscriptions(engine, subscriptions) });
    },
  }),
};

/** Every feature, in the order the whole engine has always built them. */
export const allFeatures: readonly Feature[] = [changesets, blobs, imports, readModels, workflows, schedules, realtime, portability, governance, dispatch];

/** Features another feature calls into. */
const DEPENDS: Partial<Record<FeatureName, readonly FeatureName[]>> = { imports: ["changesets"], blobs: ["governance"] };

/** The features a model uses: what an engine running it must link. Surfaces a host chooses to serve (changesets, imports, admin, local dispatch) are not implied by the model. */
export function requiredFeatures(model: Model): FeatureName[] {
  const out = new Set<FeatureName>();
  if (model.workflows.length) out.add("workflows");
  if (model.sources.length) out.add("schedules");
  if (model.views.length || model.projections.length || model.caches.length) out.add("readModels");
  if (model.channels.some((c) => c.websocket)) out.add("realtime");
  if (model.resources.some((r) => r.kind === "blob")) out.add("blobs");
  return closure(out);
}

/**
 * Features behind a runtime-served HTTP surface (the routes the HTTP handler answers itself), for a host
 * that serves only some routes: `POST /v1/changesets` needs `changesets`, `/v1/admin/export` needs
 * `portability`, and so on. Model-declared routes need nothing beyond `requiredFeatures`. Blob bytes
 * (`/_forge/objects/{token}`) need blob storage, not a feature: see the host's `objects` option.
 */
export function surfaceFeatures(path: string): FeatureName[] {
  if (/^\/v1\/changesets(\/|$)/.test(path)) return ["changesets"];
  if (/^\/v1\/imports\//.test(path)) return closure(["imports"]);
  if (/^\/v1\/admin\/(export|import|verify|fence)$/.test(path)) return ["portability"];
  if (/^\/v1\/admin\/(subjects\/locate|inspect)$/.test(path)) return ["governance"];
  return [];
}

function closure(names: Iterable<FeatureName>): FeatureName[] {
  const out = new Set<FeatureName>(names);
  for (const n of [...out]) for (const d of DEPENDS[n] ?? []) out.add(d);
  return [...out].sort();
}

/** Throws when `features` lacks one the model uses (or one a linked feature calls into). */
export function checkFeatures(model: Model, features: readonly Feature[]): void {
  const linked = new Set(features.map((f) => f.name));
  const missing = closure([...requiredFeatures(model), ...linked]).filter((n) => !linked.has(n));
  if (missing.length) throw new Error(`forge: ${model.bundle.ir.package.name} needs the ${missing.join(", ")} feature${missing.length > 1 ? "s" : ""}, which ${missing.length > 1 ? "are" : "is"} not linked (linked: ${[...linked].sort().join(", ") || "none"})`);
}

/** The features for a set of names, e.g. `requiredFeatures(model)` (unknown names throw). */
export function featuresNamed(names: Iterable<string>): Feature[] {
  const byName = new Map<string, Feature>(allFeatures.map((f) => [f.name, f]));
  return [...names].map((n) => {
    const f = byName.get(n);
    if (!f) throw new Error(`forge: unknown runtime feature ${n}`);
    return f;
  });
}
