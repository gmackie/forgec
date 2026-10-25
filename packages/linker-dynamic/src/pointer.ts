// The current-manifest pointer (FORG-47). Before this, each host isolate held the pointer in module
// scope and a `PUT /_linker/manifest` moved it only in the isolate that took the PUT; deployed, the
// other isolates kept serving the old closures with no bound (research/composable-units/r4-deployed).
//
// The pointer now lives in one Durable Object per scope (`ManifestPointer`, ./pointer-object.ts):
//   - It names what serves: the manifest blob, the kit blob, and the closureHash of every entry point
//     (plus, for linker C's tier host, the entry points it serves dynamically).
//   - It is versioned. A swap is a compare-and-swap that names the version it replaces. A writer
//     holding an older version gets `StalePointer` (409) with the current version, and nothing moves.
//   - Each host isolate caches its copy for at most `ttlMs` (LINKER_POINTER_TTL_MS, default 1000 ms).
//     A request that finds the copy older than that revalidates it first (one DO read; concurrent
//     requests in the isolate share it). So a swap committed at time T is served by every request that
//     starts after T + ttlMs, on every isolate. The isolate that made the swap sees it at once.
//   - If the DO cannot be read when a revalidation is due, the request is refused (`LinkerRefused`,
//     reason `PointerUnavailable`, 503, with linker B's refusal header), never served from a copy older
//     than the bound. Linker C's router falls back to the packed script on that refusal and counts it.
//   - Pointers are scoped: one DO per scope name (`pointer:<scope>`). Hosts serve `LINKER_SCOPE`
//     (default "default"); the admin API takes `?scope=`. LOOM-19 can give each Loom Session its own
//     scope without changing the layout.
//
// This module is pure (no `cloudflare:workers`), so the CAS and the cache are unit-tested in Node.
import { LinkError } from "./manifest.ts";

export const DEFAULT_SCOPE = "default";
export const DEFAULT_TTL_MS = 1000;
/** How many earlier pointers the DO keeps, for the admin view and for a swap-back by hand. */
export const HISTORY = 10;
const SCOPE_RE = /^[a-z0-9][a-z0-9:._-]{0,63}$/;

export interface PointerBody {
  /** The manifest's own hash (identity); the blob below is its exact bytes in the unit store. */
  manifestHash: string;
  /** Unit-store digest of the manifest text. */
  manifestBlob: string;
  /** Unit-store digest of the kit (libraries and app bundles) the manifest was linked with. */
  kitBlob: string;
  /** Entry point id -> closureHash, for every entry point of the manifest. */
  closures: Record<string, string>;
  /** Linker C: the entry points the tier host serves dynamically, with their closureHash. Null for B. */
  dynamic: Record<string, string> | null;
}

export interface Pointer extends Partial<PointerBody> {
  scope: string;
  /** 0 until the first swap; +1 on every swap. */
  version: number;
  updatedAt: string | null;
  history: Array<{ version: number; manifestHash: string; manifestBlob: string; kitBlob: string; updatedAt: string }>;
}

export type SwapResult = { ok: true; pointer: Pointer; previous: Pointer } | { ok: false; current: Pointer };

/** The storage a ManifestPointer DO keeps (`ctx.storage` satisfies it). */
export interface PointerStorage {
  get<T>(key: string): Promise<T | undefined>;
  put<T>(key: string, value: T): Promise<void>;
}

/** What a host calls on the DO (the RPC surface of ManifestPointer). */
export interface PointerService {
  read(scope: string): Promise<Pointer>;
  swap(scope: string, expect: number, body: PointerBody): Promise<SwapResult>;
}

/** The DO namespace binding (`LINKER_POINTER`). */
export interface PointerNamespace {
  idFromName(name: string): unknown;
  get(id: unknown): PointerService;
}

export function checkScope(scope: string): string {
  if (!SCOPE_RE.test(scope)) throw new LinkError("LinkerRefused", [`BadScope: scope ${JSON.stringify(scope)} is not [a-z0-9][a-z0-9:._-]{0,63}`], { reason: "BadScope" });
  return scope;
}

const empty = (scope: string): Pointer => ({ scope, version: 0, updatedAt: null, history: [] });

// ------------------------------------------------------------------------------- the DO's state
export async function readPointer(storage: PointerStorage, scope: string): Promise<Pointer> {
  return (await storage.get<Pointer>("pointer")) ?? empty(scope);
}

/**
 * The compare-and-swap. Inside a Durable Object it is atomic: the get and the put are storage
 * operations only, so the input gate admits no other call between them.
 */
export async function swapPointer(storage: PointerStorage, scope: string, expect: number, body: PointerBody, now: number): Promise<SwapResult> {
  const previous = await readPointer(storage, scope);
  if (previous.version !== expect) return { ok: false, current: previous };
  const history = previous.manifestHash ? [{ version: previous.version, manifestHash: previous.manifestHash, manifestBlob: previous.manifestBlob!, kitBlob: previous.kitBlob!, updatedAt: previous.updatedAt! }, ...previous.history].slice(0, HISTORY) : previous.history;
  const pointer: Pointer = { scope, version: previous.version + 1, updatedAt: new Date(now).toISOString(), ...body, history };
  await storage.put("pointer", pointer);
  return { ok: true, pointer, previous };
}

// ------------------------------------------------------------------------- the isolate's cache
export interface PointerEnv {
  LINKER_POINTER?: PointerNamespace;
  LINKER_SCOPE?: string;
  LINKER_POINTER_TTL_MS?: string;
}

export const ttlOf = (env: PointerEnv) => {
  const n = Number(env.LINKER_POINTER_TTL_MS ?? DEFAULT_TTL_MS);
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_TTL_MS;
};
export const scopeOf = (env: PointerEnv, requested?: string | null) => checkScope(requested || env.LINKER_SCOPE || DEFAULT_SCOPE);

function service(env: PointerEnv, scope: string): PointerService {
  if (!env.LINKER_POINTER) throw refused("NoPointerBinding", `this host has no LINKER_POINTER Durable Object binding, so it cannot know the current manifest of scope ${scope}`);
  return env.LINKER_POINTER.get(env.LINKER_POINTER.idFromName(`pointer:${scope}`));
}

export const refused = (reason: string, detail: string) => new LinkError("LinkerRefused", [`${reason}: ${detail}`], { reason });

/** How this request found its pointer: `x-forge-pointer` on every answer. */
export interface PointerRead {
  pointer: Pointer;
  /** `cached`: within the bound; `revalidated`: read from the DO, same version; `changed`: read, new version. */
  how: "cached" | "revalidated" | "changed";
  /** Wall time of the DO read (0 when cached). */
  ms: number;
}

interface Entry {
  pointer: Pointer;
  checkedAt: number;
  inflight: Promise<PointerRead> | null;
}

export interface PointerCacheStats {
  hits: number;
  revalidations: number;
  changes: number;
  failures: number;
  /** The last 50 DO read times, ms. */
  readMs: number[];
}

/**
 * One isolate's view of the pointers it serves. `now` is injectable for tests; deployed, Date.now()
 * at the start of a request is the request's arrival time (the clock advances across I/O).
 */
export class PointerCache {
  private readonly entries = new Map<string, Entry>();
  readonly stats: PointerCacheStats = { hits: 0, revalidations: 0, changes: 0, failures: 0, readMs: [] };
  private readonly now: () => number;
  constructor(now: () => number = Date.now) {
    this.now = now;
  }

  /** The pointer for `scope`, revalidated if this isolate's copy is older than `ttlMs`. Throws LinkerRefused. */
  async read(env: PointerEnv, scope: string): Promise<PointerRead> {
    const ttl = ttlOf(env);
    const e = this.entries.get(scope);
    if (e && this.now() - e.checkedAt < ttl) {
      this.stats.hits++;
      return { pointer: e.pointer, how: "cached", ms: 0 };
    }
    if (e?.inflight) return e.inflight;
    const started = this.now();
    const t0 = performance.now();
    const inflight = (async (): Promise<PointerRead> => {
      let pointer: Pointer;
      try {
        pointer = await service(env, scope).read(scope);
      } catch (err) {
        this.stats.failures++;
        if (err instanceof LinkError) throw err;
        throw refused("PointerUnavailable", `the manifest pointer for scope ${scope} could not be read (${String(err).slice(0, 200)}); refusing rather than serving a copy older than ${ttl} ms`);
      }
      const ms = performance.now() - t0;
      this.stats.revalidations++;
      this.stats.readMs.push(Math.round(ms * 100) / 100);
      if (this.stats.readMs.length > 50) this.stats.readMs.shift();
      const changed = !e || e.pointer.version !== pointer.version;
      if (changed) this.stats.changes++;
      this.entries.set(scope, { pointer, checkedAt: started, inflight: null });
      return { pointer, how: changed ? "changed" : "revalidated", ms };
    })();
    // Concurrent requests in this isolate share the read; a failed read leaves no entry behind it.
    if (e) e.inflight = inflight;
    else this.entries.set(scope, { pointer: empty(scope), checkedAt: Number.NEGATIVE_INFINITY, inflight });
    try {
      return await inflight;
    } catch (err) {
      const now = this.entries.get(scope);
      if (now?.inflight === inflight) {
        if (e) now.inflight = null;
        else this.entries.delete(scope);
      }
      throw err;
    }
  }

  /** After this isolate's own swap: serve it at once. */
  remember(pointer: Pointer): void {
    this.entries.set(pointer.scope, { pointer, checkedAt: this.now(), inflight: null });
  }

  view(): Record<string, { version: number; manifestHash: string | null; ageMs: number }> {
    const now = this.now();
    return Object.fromEntries([...this.entries].map(([s, e]) => [s, { version: e.pointer.version, manifestHash: e.pointer.manifestHash ?? null, ageMs: now - e.checkedAt }]));
  }
}

/**
 * Swaps the pointer: `expect` is the version the writer replaces (If-Match). Without one, the version
 * read just before the swap is used, so even an unconditional PUT cannot overwrite a swap it did not
 * see. A stale writer gets 409 StalePointer and the pointer does not move.
 */
export async function swap(env: PointerEnv, scope: string, expect: number | null, body: PointerBody): Promise<{ pointer: Pointer; previous: Pointer }> {
  let s: PointerService;
  let base: number;
  try {
    s = service(env, scope);
    base = expect ?? (await s.read(scope)).version;
  } catch (err) {
    if (err instanceof LinkError) throw err;
    throw refused("PointerUnavailable", `the manifest pointer for scope ${scope} could not be read: ${String(err).slice(0, 200)}`);
  }
  let r: SwapResult;
  try {
    r = await s.swap(scope, base, body);
  } catch (err) {
    throw refused("PointerUnavailable", `the manifest pointer for scope ${scope} could not be swapped: ${String(err).slice(0, 200)}`);
  }
  if (!r.ok) throw new LinkError("StalePointer", [`scope ${scope}: the swap replaces version ${base}, but the pointer is at version ${r.current.version} (${r.current.manifestHash ?? "no manifest"}); read it again and retry`], { scope, expected: base, current: r.current.version, manifestHash: r.current.manifestHash ?? null });
  return r;
}

/** The pointer as the DO holds it now, bypassing every cache (admin view). */
export async function readFresh(env: PointerEnv, scope: string): Promise<Pointer> {
  try {
    return await service(env, scope).read(scope);
  } catch (err) {
    if (err instanceof LinkError) throw err;
    throw refused("PointerUnavailable", `the manifest pointer for scope ${scope} could not be read: ${String(err).slice(0, 200)}`);
  }
}

/** `If-Match: "<n>"`, `If-Match: <n>` or `x-linker-pointer-version: <n>`; null when absent. */
export function expectedVersion(request: Request): number | null {
  const raw = request.headers.get("if-match") ?? request.headers.get("x-linker-pointer-version");
  if (raw === null) return null;
  const n = Number(raw.trim().replace(/^W\//, "").replace(/^"|"$/g, ""));
  if (!Number.isInteger(n) || n < 0) throw new LinkError("StalePointer", [`If-Match ${JSON.stringify(raw)} is not a pointer version`], { expected: raw });
  return n;
}

/** Linked state per pointer target, so a swap-back to a recent manifest needs no re-link. */
export class LinkedCache<L> {
  private readonly map = new Map<string, Promise<L>>();
  private readonly size: number;
  constructor(size = 4) {
    this.size = size;
  }
  private key = (p: Pointer) => `${p.manifestBlob}|${p.kitBlob}`;
  /** The writer's own link, so its isolate serves the swap without linking twice. */
  prime(p: Pointer, value: L): void {
    this.map.set(this.key(p), Promise.resolve(value));
    while (this.map.size > this.size) this.map.delete(this.map.keys().next().value!);
  }
  get(p: Pointer, link: () => Promise<L>): Promise<L> {
    const key = this.key(p);
    let got = this.map.get(key);
    if (got) {
      this.map.delete(key);
      this.map.set(key, got);
      return got;
    }
    got = link();
    this.map.set(key, got);
    got.catch(() => this.map.get(key) === got && this.map.delete(key));
    while (this.map.size > this.size) this.map.delete(this.map.keys().next().value!);
    return got;
  }
}
