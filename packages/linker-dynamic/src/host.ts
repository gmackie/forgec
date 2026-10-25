// Linker B's host Worker. Per request it resolves the entry point from the current Closure
// Manifest, derives that closure's capability policy, and runs it in a child isolate from the
// Dynamic Worker Loader (`env.LOADER`). Children are cached by closure hash. A child gets only
// capability stubs (WorkerEntrypoint classes below, narrowed by props it cannot see or forge),
// never this Worker's env, and no network unless its entry point declares egress.
import { WorkerEntrypoint, WorkflowEntrypoint, type WorkflowStepLike } from "cloudflare:workers";
import { capabilityDenied, capabilityDeniedError } from "@forgegraph/runtime/errors";
import { childMain, childSource, COMPATIBILITY_DATE, type LinkerKit } from "./child.ts";
import { digest, LINK_DOMAIN } from "./hash.ts";
import { LinkError, matchRoute, resolveManifest, type ClosureManifest, type EntryPoint, type Resolved } from "./manifest.ts";
import { derivePolicy, objectRoutePolicy, privilegedPolicy, SWEEP_SERVICE, type Policy, type SqlSchema } from "./policy.ts";
import { sqlDenial, type GatePolicy } from "./sql-gate.ts";
import { R2BlobStore, verifiedBlob, type BlobStore, type R2BucketLike } from "./store.ts";
import { forgetCached, memoryUnits, missingBlobs, openUnitCache, UnitFetcher, unitFetchConfig, type FetchReport } from "./unit-fetch.ts";

interface D1StatementLike {
  bind(...values: unknown[]): D1StatementLike;
  first(): Promise<unknown>;
  all(): Promise<{ results: unknown[]; meta?: Record<string, unknown> }>;
  run(): Promise<{ meta: Record<string, unknown> }>;
}
interface R2ObjectLike {
  size: number;
  etag: string;
  httpMetadata?: { contentType?: string };
  body?: ReadableStream;
}

export interface HostEnv {
  LOADER: WorkerLoaderLike;
  /** The content-addressed unit store (blobs/<hex>, kit.json, pointer). */
  UNITS: R2BucketLike;
  DB: { prepare(sql: string): D1StatementLike; batch(s: D1StatementLike[]): Promise<Array<{ results?: unknown[]; meta?: Record<string, unknown> }>> };
  /** Enables /_linker/* administration (local runs only). */
  LINKER_ADMIN_TOKEN?: string;
  /** "fail" (default): a request no entry point claims is refused. "runtime": served by the whole-app child and reported. */
  LINKER_UNCOVERED?: string;
  /**
   * Set when this host is linker C's dynamic tier (FORG-43): the service binding to linker A's dispatch
   * owner. Post-commit dispatch goes there instead of to a dispatch child, and every child is probed
   * before use, so a child that cannot load is refused (a LinkError the router falls back on).
   */
  FORGE_DISPATCH?: { fetch(input: Request | string, init?: RequestInit): Promise<Response> };
  /** Unit fetch layers (src/unit-fetch.ts): unset is "memory,cache,parallel"; "off" reads every blob from the store, serially. */
  LINKER_UNIT_CACHE?: string;
  [binding: string]: unknown;
}

type GateProps = GatePolicy;
type BindingProps = { label: string; binding: string };
type EgressProps = { label: string; allow: string[] };

interface Linked {
  resolved: Resolved;
  kit: LinkerKit;
  schema: SqlSchema;
}

interface ClosureStats {
  closureHash: string;
  label: string;
  /** The child runs the whole app (the opt-in `uncovered` fallback, or a pre-FORG-33 sweep). */
  privileged: boolean;
  cold: number;
  warm: number;
  buildMs: number[];
  /** Where each build's blobs came from (the last few builds). */
  fetches: FetchReport[];
}

// ---------------------------------------------------------------------------------- host state
// One host isolate's view. The pointer is re-read from the store when this isolate has none; a
// PUT through /_linker/manifest swaps it here and in the store.
let linked: Linked | null = null;
const codeCache = new Map<string, WorkerLoaderCode>();
/** Bumped by POST /_linker/evict-host-cache: part of every child id, so the next request is a loader miss. */
let generation = 0;
const stats = { closures: new Map<string, ClosureStats>(), denials: [] as string[], fallbacks: [] as string[], refused: [] as string[] };

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
/** Set on every refusal made before a request reached unit code: what linker C's router falls back on. */
export const REFUSED_HEADER = "x-forge-linker-refused";
const problem = (e: LinkError) => json(e.problem(), e.status, { "content-type": "application/problem+json", [REFUSED_HEADER]: e.code });
const recordDenial = (msg: string) => {
  stats.denials.push(msg);
  console.warn(`linker: ${msg}`);
};

async function loadKit(store: R2BucketLike): Promise<LinkerKit | null> {
  const o = await store.get("kit.json");
  return o ? (JSON.parse(new TextDecoder().decode(await o.arrayBuffer())) as LinkerKit) : null;
}

/** Resolves a manifest and checks every blob it can reach exists, before it may serve. */
async function link(store: BlobStore, kit: LinkerKit, manifest: ClosureManifest, env: HostEnv): Promise<Linked> {
  const resolved = await resolveManifest(manifest);
  const app = kit.apps[manifest.buildHash];
  const config = unitFetchConfig(env.LINKER_UNIT_CACHE);
  const missing = await missingBlobs(
    store,
    [
      ...Object.entries(manifest.modules).map(([blob, m]) => [blob, `module ${blob} (${m.path}) is not in the unit store`] as [string, string]),
      ...(app ? [[app, `app bundle ${app} is not in the unit store`] as [string, string]] : []),
      ...Object.entries(kit.libraries).map(([lib, blob]) => [blob, `library ${lib} (${blob}) is not in the unit store`] as [string, string]),
    ],
    config.parallel,
  );
  if (!app) missing.unshift(`no app bundle for buildHash ${manifest.buildHash}`);
  if (missing.length) throw new LinkError("MissingModule", missing);
  // Through the unit fetcher, so the child builds that follow find app.json in memory.
  const appBundle = await new UnitFetcher(store, { config, cache: await openUnitCache() }).json<{ buildHash: string; sql: SqlSchema }>(app!, "app bundle");
  if (appBundle.buildHash !== manifest.buildHash) throw new LinkError("BuildMismatch", [`app bundle ${app} has buildHash ${appBundle.buildHash}, manifest has ${manifest.buildHash}`]);
  return { resolved, kit, schema: appBundle.sql };
}

async function current(env: HostEnv): Promise<Linked | null> {
  if (linked) return linked;
  const pointer = await env.UNITS.get("pointer/current");
  const kit = await loadKit(env.UNITS);
  if (!pointer || !kit) return null;
  const store = new R2BlobStore(env.UNITS);
  const digestText = new TextDecoder().decode(await pointer.arrayBuffer()).trim();
  const manifest = JSON.parse(new TextDecoder().decode(await verifiedBlob(store, digestText, "manifest"))) as ClosureManifest;
  linked = await link(store, kit, manifest, env);
  return linked;
}

/** Bindings a child may hold as plain values: the manifest's host secrets and vars. */
const childVars = (m: ClosureManifest) => m.hostBindings.filter((b) => b.type === "secret" || b.type === "var").map((b) => b.name).sort();

function capabilityEnv(ctx: { exports: Record<string, (o: { props: unknown }) => unknown> }, env: HostEnv, policy: Policy, vars: string[], schema: SqlSchema): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const v of vars) if (typeof env[v] === "string") out[v] = env[v];
  // The runtime host builds D1 storage for every request, so even a closure with no tables gets a
  // D1 handle; under an empty policy it refuses every statement.
  const resources = Object.fromEntries(schema.tables.map((t) => [t.name, t.resource]));
  out["DB"] = ctx.exports["D1Gate"]!({ props: { label: policy.label, tables: policy.tables, resources } satisfies GateProps });
  for (const b of policy.objects) if (env[b]) out[b] = ctx.exports["ObjectsGate"]!({ props: { label: policy.label, binding: b } satisfies BindingProps });
  for (const b of policy.queues) if (env[b]) out[b] = ctx.exports["QueueGate"]!({ props: { label: policy.label, binding: b } satisfies BindingProps });
  for (const b of policy.workflows) if (env[b]) out[b] = ctx.exports["WorkflowGate"]!({ props: { label: policy.label, binding: b } satisfies BindingProps });
  return out;
}

interface Child {
  stub: WorkerStubLike;
  id: string;
  closureHash: string;
  privileged: boolean;
  cold: () => boolean;
  buildMs: number;
  fetch: FetchReport | null;
}

type HostCtx = { exports: Record<string, (o: { props: unknown }) => unknown>; waitUntil?(p: Promise<unknown>): void };

/** The child isolate for a closure under a policy. Bytes are fetched and verified only on a host cache miss. */
async function childFor(env: HostEnv, ctx: HostCtx, l: Linked, closureHash: string, policy: Policy): Promise<Child> {
  const m = l.resolved.manifest;
  const source = childSource(m, policy, l.kit);
  const vars = childVars(m);
  // closureHash pins the implementations; the suffix covers what else goes into the code: the
  // libraries' and app bundle's bytes and the policy the stubs carry.
  const id = `${closureHash}~${(await digest(LINK_DOMAIN, { blobs: source.blobs, policy, vars, ...(generation ? { generation } : {}) })).slice(7, 23)}`;
  let code = codeCache.get(id);
  let buildMs = 0;
  let report: FetchReport | null = null;
  if (!code) {
    const t0 = performance.now();
    const fetcher = new UnitFetcher(new R2BlobStore(env.UNITS), { config: unitFetchConfig(env.LINKER_UNIT_CACHE), cache: await openUnitCache(), ...(ctx.waitUntil ? { waitUntil: (p: Promise<unknown>) => ctx.waitUntil!(p) } : {}) });
    const blobs = await fetcher.all(source.blobs, (name) => `${policy.label}: ${name}`);
    const modules: WorkerLoaderCode["modules"] = { "main.js": childMain(source, policy, vars) };
    for (const name of Object.keys(source.blobs)) modules[name] = name === "app.json" ? { json: blobs[name]!.json() } : { js: blobs[name]!.text };
    report = fetcher.report();
    code = {
      compatibilityDate: COMPATIBILITY_DATE,
      mainModule: "main.js",
      modules,
    };
    codeCache.set(id, code);
    buildMs = performance.now() - t0;
  }
  let cold = false;
  if (!env.LOADER) throw new LinkError("LoaderUnavailable", [`${policy.label}: no Worker Loader binding`]);
  // Stubs are minted in the request that creates the isolate, never cached across requests.
  let stub: WorkerStubLike;
  try {
    stub = env.LOADER.get(id, () => {
      cold = true;
      return {
        ...code!,
        env: capabilityEnv(ctx, env, policy, vars, l.schema),
        globalOutbound: policy.egress.length ? ctx.exports["Egress"]!({ props: { label: policy.label, allow: policy.egress } satisfies EgressProps }) : null,
      };
    });
  } catch (e) {
    throw new LinkError("LoaderUnavailable", [`${policy.label}: ${String(e)}`]);
  }
  if (env.FORGE_DISPATCH) {
    try {
      await stub.getEntrypoint("Forge")["ping"]!();
    } catch (e) {
      throw new LinkError("LoadFailed", [`${policy.label}: child ${id} did not start: ${String(e)}`]);
    }
  }
  return { stub, id, closureHash, privileged: policy.privileged, cold: () => cold, buildMs, fetch: report };
}

function record(child: Child, label: string, cold: boolean) {
  const s = stats.closures.get(child.id) ?? { closureHash: child.closureHash, label, privileged: child.privileged, cold: 0, warm: 0, buildMs: [], fetches: [] };
  if (cold) s.cold++;
  else s.warm++;
  if (child.buildMs) s.buildMs.push(child.buildMs);
  if (child.fetch) s.fetches = [...s.fetches, child.fetch].slice(-5);
  stats.closures.set(child.id, s);
}

const sweepEntry = (l: Linked) => l.resolved.manifest.entryPoints.find((e) => e.runtimeService === SWEEP_SERVICE);

/**
 * The child that runs the runtime's sweep, scheduled() and post-commit dispatch(). Since FORG-33 it
 * is narrowed to the sweep entry point's closure (the dispatch unit: every subscriber, workflow and
 * schedule). Only a manifest whose sweep has no root falls back to the whole app, reported.
 */
async function dispatchChild(env: HostEnv, ctx: HostCtx, l: Linked, label: string): Promise<Child> {
  const sweep = sweepEntry(l);
  if (sweep?.root) return childFor(env, ctx, l, sweep.closureHash, { ...derivePolicy(l.resolved.manifest, sweep, l.schema), label });
  return childFor(env, ctx, l, sweep?.closureHash ?? "runtime", privilegedPolicy(l.resolved.manifest, l.schema, label));
}

// ------------------------------------------------------------------------------ administration
async function admin(request: Request, env: HostEnv, url: URL): Promise<Response> {
  if (!env.LINKER_ADMIN_TOKEN || request.headers.get("x-linker-admin") !== env.LINKER_ADMIN_TOKEN) return json({ code: "Forbidden" }, 403);
  const store = new R2BlobStore(env.UNITS);
  const route = `${request.method} ${url.pathname}`;
  try {
    if (route === "PUT /_linker/blobs") return json({ digest: await store.put(new Uint8Array(await request.arrayBuffer())) });
    if (route === "PUT /_linker/kit") {
      await env.UNITS.put("kit.json", await request.text());
      return json({ ok: true });
    }
    if (route === "PUT /_linker/manifest") {
      const text = await request.text();
      const kit = await loadKit(env.UNITS);
      if (!kit) return json({ code: "NoKit" }, 409);
      const next = await link(store, kit, JSON.parse(text) as ClosureManifest, env);
      const blob = await store.put(new TextEncoder().encode(text));
      await env.UNITS.put("pointer/current", blob);
      const previous = linked?.resolved.manifest.manifestHash ?? null;
      linked = next;
      return json({ manifestHash: next.resolved.manifest.manifestHash, previous, blob, entryPoints: next.resolved.manifest.entryPoints.length });
    }
    if (route === "GET /_linker/stats") return json({ manifestHash: linked?.resolved.manifest.manifestHash ?? null, closures: [...stats.closures].map(([id, s]) => ({ id, ...s })), denials: stats.denials, fallbacks: stats.fallbacks, refused: stats.refused, hostCodeCache: codeCache.size, unitFetch: { config: env.LINKER_UNIT_CACHE ?? null, memory: memoryUnits.stats(), generation } });
    if (route === "POST /_linker/stats/reset") {
      stats.closures.clear();
      stats.denials.length = 0;
      stats.fallbacks.length = 0;
      stats.refused.length = 0;
      return json({ ok: true });
    }
    if (route === "POST /_linker/evict-host-cache") {
      // Default: every layer, so the next build re-reads the unit store. ?layers=code (or code,memory)
      // keeps the nearer copies. `cache` drops the linked blobs from this colo's Cache API only. Either
      // way the next child gets a new id, so it is a loader miss.
      const layers = new Set((url.searchParams.get("layers") ?? "code,memory,cache").split(","));
      if (layers.has("code")) codeCache.clear();
      if (layers.has("memory")) memoryUnits.clear();
      const k = linked?.kit;
      const cached = layers.has("cache") && linked && k ? await forgetCached([...Object.keys(linked.resolved.manifest.modules), ...Object.values(k.libraries), ...Object.values(k.apps)]) : 0;
      generation++;
      return json({ ok: true, layers: [...layers].sort(), generation, cacheDeleted: cached });
    }
  } catch (e) {
    if (e instanceof LinkError) {
      stats.refused.push(e.message);
      return problem(e);
    }
    throw e;
  }
  return json({ code: "NotFound" }, 404);
}

// ---------------------------------------------------------------------------------- the Worker
/** Linker A's dispatch-owner endpoint (packages/linker-packed/src/host.ts), named here so neither linker imports the other. */
const DISPATCH_PATH = "/_forge/linker/dispatch";

/** Tenants whose schedule-index record this isolate has handed to dispatch() (once per isolate, like the runtime). */
const seenTenants = new Set<string>();

export default {
  async fetch(request: Request, env: HostEnv, ctx: { waitUntil(p: Promise<unknown>): void; exports: Record<string, (o: { props: unknown }) => unknown> }): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/_linker/")) return admin(request, env, url);
    const t0 = performance.now();
    try {
      const l = await current(env);
      const resolveMs = performance.now() - t0;
      if (!l) return json({ code: "NoManifest", detail: "no Closure Manifest has been linked" }, 503, { [REFUSED_HEADER]: "NoManifest" });
      const m = l.resolved.manifest;
      let entry: EntryPoint | null = null;
      let policy: Policy;
      let closureHash: string;
      if (request.headers.get("upgrade")?.toLowerCase() === "websocket") throw new LinkError("UnlinkedEntryPoint", [`websocket ${url.pathname}: realtime streams are served by a Durable Object, which T4 does not link`]);
      entry = matchRoute(l.resolved, request.method, url.pathname) ?? matchRoute(l.resolved, request.method, url.pathname, { anyMethod: true });
      if (!entry && /^\/_forge\/objects\/[^/]+$/.test(url.pathname)) {
        // A manifest sealed before FORG-33 has no object-bytes entry point.
        policy = objectRoutePolicy(m);
        closureHash = "runtime:object-bytes";
      } else {
        if (!entry) {
          if (env.LINKER_UNCOVERED !== "runtime") throw new LinkError("UnknownEntryPoint", [`${request.method} ${url.pathname} is not an entry point of manifest ${m.manifestHash}`]);
          stats.fallbacks.push(`${request.method} ${url.pathname}`);
          console.warn(`linker: FALLBACK ${request.method} ${url.pathname} has no entry point; served by the whole-app runtime child`);
          policy = privilegedPolicy(m, l.schema, `fallback:${request.method} ${url.pathname}`);
          closureHash = sweepEntry(l)?.closureHash ?? "runtime";
        } else {
          policy = derivePolicy(m, entry, l.schema);
          closureHash = entry.closureHash;
        }
      }
      const child = await childFor(env, ctx, l, closureHash, policy);
      const tChild = performance.now();
      const res = await child.stub.getEntrypoint().fetch(request);
      const childMs = performance.now() - tChild;
      const cold = child.cold();
      record(child, policy.label, cold);
      const out = new Response(res.body, res);
      out.headers.delete(REFUSED_HEADER);
      out.headers.set("x-forge-entry", entry?.id ?? policy.label);
      out.headers.set("x-forge-closure", closureHash);
      out.headers.set("x-forge-isolate", cold ? "cold" : "warm");
      out.headers.set("x-forge-link-ms", (performance.now() - t0).toFixed(2));
      // FORG-48: where the miss time went. resolve = current(); build = the child's blobs; child = the child's answer.
      const f = child.fetch;
      out.headers.set("x-forge-link-breakdown", `resolve=${resolveMs.toFixed(1)};build=${child.buildMs.toFixed(1)};child=${childMs.toFixed(1)}${f ? `;fetch=${f.config};memory=${f.memory};cache=${f.cache};store=${f.store};storeBytes=${f.storeBytes}` : ""}`);
      if (policy.privileged) out.headers.set("x-forge-linker", "fallback-whole-app");
      // The runtime's dispatch() (FORG-29) runs in the dispatch child, which holds the whole app and
      // every subscription's transport: the post-commit outbox sweep after a committed write, and the
      // first-sight schedule-index record a whole-app Worker makes for every tenant it serves.
      const tenant = request.headers.get("x-forge-tenant");
      const sweep = request.method !== "GET" && res.status < 300;
      if (tenant && (sweep || !seenTenants.has(tenant)) && env.FORGE_DISPATCH) {
        // Linker C: one dispatch owner for both tiers, linker A's sweep script (same body as its forwarders).
        seenTenants.add(tenant);
        const owner = env.FORGE_DISPATCH;
        ctx.waitUntil(
          owner
            .fetch(`https://dispatch${DISPATCH_PATH}`, { method: "POST", body: JSON.stringify({ tenant, sweep }), headers: { "content-type": "application/json" } })
            .then((r) => {
              if (!r.ok) throw new Error(`dispatch owner answered ${r.status}`);
            })
            .catch((e: unknown) => {
              if (!sweep) seenTenants.delete(tenant);
              console.warn("linker: dispatch hand-off failed", String(e));
            }),
        );
      } else if (tenant && (sweep || !seenTenants.has(tenant))) {
        seenTenants.add(tenant);
        ctx.waitUntil(
          dispatchChild(env, ctx, l, "runtime:dispatch")
            .then(async (c) => {
              await c.stub.getEntrypoint("Forge")["dispatch"]!(tenant, { sweep });
              record(c, "runtime:dispatch", c.cold());
            })
            .catch((e: unknown) => {
              if (!sweep) seenTenants.delete(tenant);
              console.warn("linker: dispatch failed", String(e));
            }),
        );
      }
      return out;
    } catch (e) {
      if (e instanceof LinkError) {
        stats.refused.push(e.message);
        return problem(e);
      }
      throw e;
    }
  },

  async queue(batch: { queue: string; messages: Array<{ body: unknown; ack(): void; retry(): void }> }, env: HostEnv, ctx: { exports: Record<string, (o: { props: unknown }) => unknown> }): Promise<void> {
    const l = await current(env);
    const entry = l?.resolved.byQueue.get(batch.queue);
    if (!l || !entry) {
      // Fail closed: an unclaimed queue is retried (and eventually dead-lettered), never acked unseen.
      console.warn(`linker: queue ${batch.queue} has no entry point; retrying ${batch.messages.length} message(s)`);
      for (const msg of batch.messages) msg.retry();
      return;
    }
    const child = await childFor(env, ctx, l, entry.closureHash, derivePolicy(l.resolved.manifest, entry, l.schema));
    const outcomes = (await child.stub.getEntrypoint("Forge")["queue"]!(batch.queue, batch.messages.map((x) => x.body))) as string[];
    record(child, `queue-consumer:${entry.id}`, child.cold());
    batch.messages.forEach((msg, i) => (outcomes[i] === "ack" ? msg.ack() : msg.retry()));
  },

  async scheduled(event: { cron?: string; scheduledTime?: number }, env: HostEnv, ctx: { exports: Record<string, (o: { props: unknown }) => unknown> }): Promise<void> {
    const l = await current(env);
    if (!l) return;
    // The runtime's scheduled() runs the outbox sweep, every due schedule and the workflow sweep at
    // once, so every cron runs in the sweep's child: its closure covers all three (README).
    const child = await dispatchChild(env, ctx, l, `cron:${event.cron ?? "?"}`);
    await child.stub.getEntrypoint("Forge")["scheduled"]!({ cron: event.cron, scheduledTime: event.scheduledTime });
    record(child, `cron:${event.cron ?? "?"}`, child.cold());
  },
};

// ------------------------------------------------------------------------- capability handles
/**
 * D1, narrowed to the tables the closure may read and write. A refused statement throws the
 * runtime's capability denial (FORG-34), which the child's D1 adapter answers as 403
 * CapabilityDenied: not a storage failure, and not retried.
 */
export class D1Gate extends WorkerEntrypoint<HostEnv, GateProps> {
  private check(sql: string) {
    const denial = sqlDenial(sql, this.ctx.props);
    if (!denial) return;
    recordDenial(denial.detail!);
    throw capabilityDeniedError(denial);
  }
  private stmt(sql: string, params: unknown[]) {
    this.check(sql);
    return this.env.DB.prepare(sql).bind(...params);
  }
  async first(sql: string, params: unknown[]) {
    return this.stmt(sql, params).first();
  }
  async all(sql: string, params: unknown[]) {
    const r = await this.stmt(sql, params).all();
    return { results: r.results, meta: { changes: Number(r.meta?.["changes"] ?? 0) } };
  }
  async run(sql: string, params: unknown[]) {
    const r = await this.stmt(sql, params).run();
    return { meta: { changes: Number(r.meta["changes"] ?? 0) } };
  }
  async batch(statements: Array<{ sql: string; params: unknown[] }>) {
    const prepared = statements.map((s) => this.stmt(s.sql, s.params));
    const rs = await this.env.DB.batch(prepared);
    return rs.map((r) => ({ results: r.results ?? [], meta: { changes: Number(r.meta?.["changes"] ?? 0) } }));
  }
}

const plainObject = (o: R2ObjectLike) => ({ size: o.size, etag: o.etag, ...(o.httpMetadata ? { httpMetadata: { ...(o.httpMetadata.contentType ? { contentType: o.httpMetadata.contentType } : {}) } } : {}) });

/** One R2 binding the closure declares. */
export class ObjectsGate extends WorkerEntrypoint<HostEnv, BindingProps> {
  private bucket() {
    return this.env[this.ctx.props.binding] as {
      head(k: string): Promise<R2ObjectLike | null>;
      get(k: string): Promise<R2ObjectLike | null>;
      put(k: string, v: unknown, o?: unknown): Promise<R2ObjectLike>;
      delete(k: string): Promise<void>;
    };
  }
  async head(key: string) {
    const o = await this.bucket().head(key);
    return o ? plainObject(o) : null;
  }
  async get(key: string) {
    const o = await this.bucket().get(key);
    return o ? { ...plainObject(o), body: o.body } : null;
  }
  async put(key: string, value: unknown, options?: unknown) {
    const o = await this.bucket().put(key, value, options);
    return { etag: o.etag };
  }
  async delete(key: string) {
    await this.bucket().delete(key);
  }
}

/** One queue producer the closure declares. */
export class QueueGate extends WorkerEntrypoint<HostEnv, BindingProps> {
  async send(body: unknown, options?: unknown) {
    await (this.env[this.ctx.props.binding] as { send(b: unknown, o?: unknown): Promise<void> }).send(body, options);
  }
}

/** One Workflows binding the closure declares: create and wake, nothing else. */
export class WorkflowGate extends WorkerEntrypoint<HostEnv, BindingProps> {
  private wf() {
    return this.env[this.ctx.props.binding] as { create(o: unknown): Promise<unknown>; get(id: string): Promise<{ sendEvent(e: unknown): Promise<void> }> };
  }
  async create(opts: { id: string; params: unknown }) {
    await this.wf().create(opts);
  }
  async sendEvent(id: string, event: unknown) {
    await (await this.wf().get(id)).sendEvent(event);
  }
}

/** globalOutbound for a child whose entry point declares egress: only those origins pass. */
export class Egress extends WorkerEntrypoint<HostEnv, EgressProps> {
  async fetch(request: Request): Promise<Response> {
    const origin = new URL(request.url).origin;
    if (!this.ctx.props.allow.includes(origin)) {
      const detail = `${this.ctx.props.label} has no egress to ${origin}`;
      recordDenial(detail);
      const body = capabilityDenied({ capability: `egress:${origin}`, entryPoint: this.ctx.props.label, detail }).problem(crypto.randomUUID());
      return new Response(JSON.stringify({ ...body, origin }), { status: 403, headers: { "content-type": "application/problem+json", "x-forge-egress": "denied" } });
    }
    return fetch(request);
  }
}

/**
 * The Workflows class for one workflow entry point (`trigger.className`). Workflows bind to a class
 * the deployed script exports, so the host exports one per workflow and runs each advance in the
 * workflow entry point's child.
 */
/** One driver step of a workflow instance in its entry point's child. A LinkError means no unit code ran. */
export async function advanceWorkflow(env: HostEnv, ctx: HostCtx, className: string, tenant: string, id: string): Promise<{ status: string; dueAt?: string }> {
  const l = await current(env);
  const entry = l?.resolved.byWorkflowClass.get(className);
  if (!l || !entry) throw new LinkError("UnknownEntryPoint", [`workflow class ${className} is not an entry point`]);
  const child = await childFor(env, ctx, l, entry.closureHash, derivePolicy(l.resolved.manifest, entry, l.schema));
  const st = (await child.stub.getEntrypoint("Forge")["advance"]!(tenant, id)) as { status: string; dueAt?: string };
  record(child, `workflow:${entry.id}`, child.cold());
  return st;
}

export function forgeWorkflow(className: string) {
  return class ForgeWorkflow extends WorkflowEntrypoint<HostEnv, { tenant: string; id: string }> {
    async run(event: { payload: { tenant: string; id: string } }, step: WorkflowStepLike) {
      const env = this.env;
      const ctx = this.ctx as unknown as { exports: Record<string, (o: { props: unknown }) => unknown> };
      const advance = () => advanceWorkflow(env, ctx, className, event.payload.tenant, event.payload.id);
      for (let n = 0; n < 10_000; n++) {
        const state = await step.do(`advance:${n}`, advance);
        if (state.status === "sleeping") await step.sleep(`sleep:${n}`, Math.max(0, Date.parse(state.dueAt!) - Date.now()));
        else if (state.status === "waiting") {
          const timeout = state.dueAt ? Math.max(1000, Date.parse(state.dueAt) - Date.now()) : 365 * 24 * 3600 * 1000;
          try {
            await step.waitForEvent(`wait:${n}`, { type: "forge.wake", timeout });
          } catch {
            // Deadline reached: the next advance applies the timeout.
          }
        } else if (state.status === "running") await step.sleep(`retry:${n}`, 1000);
        else return state;
      }
      return null;
    }
  };
}
