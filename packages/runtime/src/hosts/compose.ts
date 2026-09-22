/**
 * Composable runtime (FORGE-032, plan §5.1). A deployment is a choice on each
 * axis — structured store, object store, channel transport, workflow driver,
 * realtime hub, clock/ids/secret — not a provider bundle. The Cloudflare and
 * AWS hosts are compositions of these; the Node host is another. Each axis is
 * a named capability interface; nothing here is a generic get/put client.
 */
import { Effect, Layer } from "effect";
import { MemoryObjectStore } from "../adapters/memory-objects.js";
import { Dispatcher, type Transport } from "../dispatch.js";
import { Engine, type EngineOptions } from "../engine.js";
import { Model, type AppBundle } from "../model.js";
import { internalSubscriptions, withProjections } from "../readmodels.js";
import type { RealtimeHub } from "../realtime.js";
import { Clock, CursorSecret, IdGen, Objects, Storage, type ObjectStoreAdapter, type StorageAdapter } from "../services.js";
import type { TelemetrySink } from "../telemetry.js";
import type { WorkflowDriver } from "../workflows.js";
import { productionIds } from "./ids.js";

/** Named capability axes (plan §5.1). Re-exported so callers depend on the interface, not the adapter. */
export type StructuredStore = StorageAdapter;
export type ObjectStore = ObjectStoreAdapter;
export type ChannelTransport = Transport;
export type { RealtimeHub, WorkflowDriver };

export interface RuntimeComposition extends EngineOptions {
  bundle: AppBundle;
  store: StructuredStore;
  objects?: ObjectStore;
  /** Where deliveries for subscriptions the process does not consume itself go (queues); default: in-process only. */
  transport?: ChannelTransport;
  workflowDriver?: WorkflowDriver;
  realtimeHub?: RealtimeHub;
  telemetry?: { sink: TelemetrySink; target: string };
  cursorSecret: string;
  clock?: () => string;
  /** Host subscriptions (queue-backed); internal consumers (projections, workflows, realtime) are merged in. */
  subscriptions?: Record<string, string[]>;
  leaseMs?: number;
  maxAttempts?: number;
}

export interface ComposedRuntime {
  model: Model;
  engine: Engine;
  store: StructuredStore;
  dispatcher: Dispatcher;
  /** One durable sweep: outbox deliveries, crashed workflow instances, due schedule occurrences. */
  sweep(tenant: string, now?: number): Promise<void>;
  sweepAll(now?: number): Promise<void>;
}

export function composeRuntime(c: RuntimeComposition): ComposedRuntime {
  const model = new Model(c.bundle);
  const layer = Layer.mergeAll(
    Layer.succeed(Clock)({ now: c.clock ?? (() => new Date().toISOString()) }),
    Layer.succeed(IdGen)(productionIds()),
    Layer.succeed(Storage)(c.store),
    Layer.succeed(CursorSecret)({ key: c.cursorSecret }),
    Layer.succeed(Objects)(c.objects ?? new MemoryObjectStore()),
  );
  const engine = new Engine(model, layer, { ...(c.secrets ? { secrets: c.secrets } : {}), ...(c.functions ? { functions: c.functions } : {}), ...(c.externals ? { externals: c.externals } : {}) });
  if (c.workflowDriver) engine.workflows.driver = c.workflowDriver;
  if (c.realtimeHub) engine.realtime.hub = c.realtimeHub;
  if (c.telemetry) {
    engine.telemetry.sink = c.telemetry.sink;
    engine.telemetry.target = c.telemetry.target;
  }
  const fallback: ChannelTransport = c.transport ?? {
    name: "in-process",
    // Without a queue transport the process consumes its own subscriptions inline (Node single-process profile).
    send: (d) => Effect.tryPromise({ try: () => engine.consume(d.subscription, d.envelope).then(() => undefined), catch: (e) => new Error(String(e)) }),
  };
  const dispatcher = new Dispatcher(model, c.store, withProjections(engine, fallback), { subscriptions: internalSubscriptions(engine, c.subscriptions ?? defaultSubscriptions(model)), leaseMs: c.leaseMs ?? 30_000, maxAttempts: c.maxAttempts ?? 8 });
  const sweep = async (tenant: string, now = Date.now()) => {
    await Effect.runPromise(dispatcher.sweep(tenant, { now }));
    await Effect.runPromise(engine.workflows.sweep(tenant));
    await Effect.runPromise(engine.schedules.tick(tenant, new Date(now).toISOString()));
  };
  const sweepAll = async (now = Date.now()) => {
    // Outbox tenants plus tenants with workflow instances (a sleeping instance has no outbox row).
    const tenants = new Set([...(await Effect.runPromise(c.store.outboxTenants())), ...(await Effect.runPromise(engine.workflows.tenants()))]);
    await Promise.all([...tenants].map((t) => sweep(t, now)));
  };
  return { model, engine, store: c.store, dispatcher, sweep, sweepAll };
}

/**
 * Assurance profiles (plan §10.4, PAR-114). A shared process can only offer `workload-bound`:
 * the callee trusts the workload's dispatcher to name the function, so a compromised workload can
 * impersonate a sibling. `isolated-callable` needs an attested execution boundary the deployment
 * actually provides; a request for it from a shared process is downgraded, never granted.
 */
export type AssuranceLevel = "workload-bound" | "isolated-callable";
export function assuranceProfile(deployment: { isolation: "shared-process" | "attested-boundary"; attestation?: string }, requested: AssuranceLevel): { requested: AssuranceLevel; granted: AssuranceLevel; reason?: string } {
  if (requested === "isolated-callable" && (deployment.isolation !== "attested-boundary" || !deployment.attestation)) {
    return { requested, granted: "workload-bound", reason: "a shared process cannot attest which function executed; a compromised workload could impersonate a sibling function" };
  }
  return { requested, granted: requested };
}

/** Every declared subscription, consumed in-process. */
function defaultSubscriptions(model: Model): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const s of model.bundle.messaging?.subscriptions ?? []) (out[s.channel] ??= []).push(s.name);
  return out;
}
