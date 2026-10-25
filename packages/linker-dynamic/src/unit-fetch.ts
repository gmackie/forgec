// How a closure's blobs (its unit modules, the libraries and the app bundle) reach the Worker Loader
// (FORG-48). Blobs are content-addressed by sha256, so every copy outside the unit store is immutable
// and may be cached forever. Layers, nearest first:
//
//   memory  this host isolate's LRU of verified, decoded blobs, shared by every child the isolate builds.
//           acme's children differ only in their unit modules (288 B to 1 KB each); the runtime, Effect
//           and app.json are the same three blobs in every child, 99% of its 850 KB.
//   cache   the Cache API (one cache per colo), keyed by digest: outlives host isolates.
//   store   the unit store (R2), the source of truth.
//
// Bytes read from the Cache API or the store are hashed and compared with their digest before they are
// used. A mismatch fails closed (ModuleDigestMismatch) and names the layer; it never falls through to
// another layer. A corrupt Cache API entry is deleted before the error is thrown, so the next request
// reads the store. The memory layer holds only bytes that were verified when they entered it.
//
// LINKER_UNIT_CACHE selects the layers: unset means "memory,cache,parallel"; "off" is the pre-FORG-48
// path (every blob from the store, one after another), kept as a kill switch and as the baseline.
import { sha256 } from "./hash.ts";
import { LinkError } from "./manifest.ts";
import { verifiedBlob, type BlobStore } from "./store.ts";

export type Layer = "memory" | "cache" | "store";

export interface UnitFetchConfig {
  memory: boolean;
  cache: boolean;
  parallel: boolean;
}

const LAYERS = ["memory", "cache", "parallel"] as const;

/** Parses LINKER_UNIT_CACHE. Unknown words are refused, so a typo cannot silently disable a layer. */
export function unitFetchConfig(value?: string | null): UnitFetchConfig {
  const v = (value ?? "").trim();
  if (!v) return { memory: true, cache: true, parallel: true };
  if (v === "off") return { memory: false, cache: false, parallel: false };
  const words = v.split(",").map((w) => w.trim()).filter(Boolean);
  const unknown = words.filter((w) => !(LAYERS as readonly string[]).includes(w));
  if (unknown.length) throw new Error(`LINKER_UNIT_CACHE: unknown ${unknown.join(", ")} (use "off" or a list of ${LAYERS.join(", ")})`);
  return { memory: words.includes("memory"), cache: words.includes("cache"), parallel: words.includes("parallel") };
}

export const configLabel = (c: UnitFetchConfig) => LAYERS.filter((l) => c[l]).join(",") || "off";

/** The slice of the Cache API used here (a `caches.open()` cache). */
export interface CacheLike {
  match(key: string): Promise<Response | undefined>;
  put(key: string, response: Response): Promise<void>;
  delete(key: string): Promise<boolean>;
}

/** Cache API keys: a reserved hostname, so they cannot collide with anything this zone serves. */
export const CACHE_NAME = "forge-linker-units";
export const cacheKey = (digest: string) => `https://units.forge-linker.invalid/${digest.replace(":", "/")}`;

/** The Cache API cache for unit blobs, or null where there is none (Node, or a runtime without `caches`). */
export async function openUnitCache(): Promise<CacheLike | null> {
  const c = (globalThis as { caches?: { open(name: string): Promise<CacheLike> } }).caches;
  if (!c?.open) return null;
  try {
    return await c.open(CACHE_NAME);
  } catch {
    return null;
  }
}

interface Entry {
  text: string;
  bytes: number;
  json?: unknown;
}

/** A byte-bounded LRU of verified, decoded blobs (a Map keeps insertion order; a hit re-inserts). */
export class MemoryUnits {
  private readonly entries = new Map<string, Entry>();
  private size = 0;
  readonly budget: number;
  constructor(budget: number) {
    this.budget = budget;
  }
  get(digest: string): Entry | undefined {
    const e = this.entries.get(digest);
    if (e) {
      this.entries.delete(digest);
      this.entries.set(digest, e);
    }
    return e;
  }
  set(digest: string, text: string, bytes: number): Entry {
    const e: Entry = { text, bytes };
    if (bytes > this.budget) return e; // never cached, still returned
    const old = this.entries.get(digest);
    if (old) {
      this.size -= old.bytes;
      this.entries.delete(digest);
    }
    this.entries.set(digest, e);
    this.size += bytes;
    for (const [d, x] of this.entries) {
      if (this.size <= this.budget) break;
      this.entries.delete(d);
      this.size -= x.bytes;
    }
    return e;
  }
  clear() {
    this.entries.clear();
    this.size = 0;
  }
  stats() {
    return { entries: this.entries.size, bytes: this.size, budget: this.budget };
  }
}

/** Default budget: the blobs of a few app builds side by side, well under a host isolate's 128 MB. */
export const MEMORY_BUDGET = 32 * 1024 * 1024;
/** This host isolate's memory layer. */
export const memoryUnits = new MemoryUnits(MEMORY_BUDGET);

/** Workers allow 6 simultaneous open connections per request; more would queue anyway. */
export const STORE_CONCURRENCY = 6;

export interface BlobRead {
  digest: string;
  what: string;
  layer: Layer;
  bytes: number;
  /** Wall time of this read. On deployed Workers timers advance only across I/O, so a memory hit or the hashing reads 0. */
  ms: number;
}

export interface FetchReport {
  config: string;
  /** Wall time from the first read to the last. */
  ms: number;
  reads: BlobRead[];
  memory: number;
  cache: number;
  store: number;
  storeBytes: number;
}

const decoder = new TextDecoder();

async function check(bytes: Uint8Array, digest: string, what: string, layer: string): Promise<void> {
  const actual = await sha256(bytes);
  if (actual !== digest) throw new LinkError("ModuleDigestMismatch", [`${what}: ${layer} copy of blob ${digest} hashes to ${actual}`]);
}

export interface UnitFetcherOptions {
  config: UnitFetchConfig;
  cache?: CacheLike | null;
  memory?: MemoryUnits;
  /** Where Cache API writes go; without it they are awaited. */
  waitUntil?: (p: Promise<unknown>) => void;
  concurrency?: number;
}

/** One request's reads. Not shared across requests: a Workers promise must not outlive its request's I/O. */
export class UnitFetcher {
  private readonly store: BlobStore;
  private readonly o: UnitFetcherOptions;
  private readonly memory: MemoryUnits | null;
  private readonly inflight = new Map<string, Promise<Entry>>();
  readonly reads: BlobRead[] = [];
  private started = 0;
  private ended = 0;

  constructor(store: BlobStore, options: UnitFetcherOptions) {
    this.store = store;
    this.o = options;
    this.memory = options.config.memory ? (options.memory ?? memoryUnits) : null;
  }

  /** A blob's verified text. */
  async text(digest: string, what: string): Promise<string> {
    return (await this.entry(digest, what)).text;
  }

  /** A blob's verified bytes parsed as JSON; with the memory layer the parse is kept with the entry. */
  async json<T = unknown>(digest: string, what: string): Promise<T> {
    const e = await this.entry(digest, what);
    if (e.json === undefined) e.json = JSON.parse(e.text);
    return e.json as T;
  }

  /** Every named blob's entry: in parallel (bounded) when the config allows, else one after another. */
  async all(blobs: Record<string, string>, what: (name: string) => string): Promise<Record<string, { text: string; json(): unknown }>> {
    const names = Object.keys(blobs);
    const out: Record<string, { text: string; json(): unknown }> = {};
    const one = async (name: string) => {
      const e = await this.entry(blobs[name]!, what(name));
      out[name] = { text: e.text, json: () => (e.json === undefined ? (e.json = JSON.parse(e.text)) : e.json) };
    };
    if (!this.o.config.parallel) {
      for (const n of names) await one(n);
      return out;
    }
    let next = 0;
    const worker = async () => {
      while (next < names.length) await one(names[next++]!);
    };
    await Promise.all(Array.from({ length: Math.min(this.o.concurrency ?? STORE_CONCURRENCY, names.length) }, worker));
    return out;
  }

  report(): FetchReport {
    const by = (l: Layer) => this.reads.filter((r) => r.layer === l);
    return {
      config: configLabel(this.o.config),
      ms: Math.round((this.ended - this.started) * 100) / 100,
      reads: this.reads,
      memory: by("memory").length,
      cache: by("cache").length,
      store: by("store").length,
      storeBytes: by("store").reduce((n, r) => n + r.bytes, 0),
    };
  }

  private entry(digest: string, what: string): Promise<Entry> {
    const hit = this.memory?.get(digest);
    if (hit) {
      this.note({ digest, what, layer: "memory", bytes: hit.bytes, ms: 0 }, performance.now());
      return Promise.resolve(hit);
    }
    let p = this.inflight.get(digest);
    if (!p) {
      p = this.read(digest, what);
      this.inflight.set(digest, p);
    }
    return p;
  }

  private note(r: BlobRead, end: number) {
    if (!this.started) this.started = end - r.ms;
    this.ended = Math.max(this.ended, end);
    this.reads.push({ ...r, ms: Math.round(r.ms * 100) / 100 });
  }

  private keep(digest: string, text: string, bytes: number): Entry {
    return this.memory ? this.memory.set(digest, text, bytes) : { text, bytes };
  }

  private async read(digest: string, what: string): Promise<Entry> {
    const t0 = performance.now();
    if (!this.started) this.started = t0;
    const cache = this.o.config.cache ? (this.o.cache ?? null) : null;
    if (cache) {
      const hit = await cache.match(cacheKey(digest)).catch(() => undefined);
      if (hit) {
        const bytes = new Uint8Array(await hit.arrayBuffer());
        try {
          await check(bytes, digest, what, "the Cache API");
        } catch (e) {
          // Fail closed for this request; drop the entry so the next one reads the store.
          await cache.delete(cacheKey(digest)).catch(() => false);
          throw e;
        }
        const e = this.keep(digest, decoder.decode(bytes), bytes.byteLength);
        this.note({ digest, what, layer: "cache", bytes: bytes.byteLength, ms: performance.now() - t0 }, performance.now());
        return e;
      }
    }
    const bytes = await verifiedBlob(this.store, digest, what);
    const e = this.keep(digest, decoder.decode(bytes), bytes.byteLength);
    this.note({ digest, what, layer: "store", bytes: bytes.byteLength, ms: performance.now() - t0 }, performance.now());
    if (cache) {
      const res = new Response(bytes as Uint8Array<ArrayBuffer>, { headers: { "content-type": "application/octet-stream", "cache-control": "public, max-age=31536000, immutable", "x-forge-unit-digest": digest } });
      const put = cache.put(cacheKey(digest), res).catch((err: unknown) => console.warn(`linker: Cache API write of ${digest} failed: ${String(err)}`));
      if (this.o.waitUntil) this.o.waitUntil(put);
      else await put;
    }
    return e;
  }
}

/** Drops blobs from this colo's Cache API (administration: forces the next read to the store). */
export async function forgetCached(digests: string[]): Promise<number> {
  const cache = await openUnitCache();
  if (!cache) return 0;
  let n = 0;
  for (const d of new Set(digests)) if (await cache.delete(cacheKey(d)).catch(() => false)) n++;
  return n;
}

/**
 * Which of `digests` the store does not hold (one `head` each, at most STORE_CONCURRENCY at once).
 * The store stays the source of truth for existence: a cached copy does not prove a blob is still stored.
 */
export async function missingBlobs(store: BlobStore, digests: Array<[digest: string, what: string]>, parallel = true): Promise<string[]> {
  const missing: Array<string | null> = digests.map(() => null);
  let next = 0;
  const worker = async () => {
    while (next < digests.length) {
      const i = next++;
      const [d, what] = digests[i]!;
      if (!(await store.has(d))) missing[i] = what;
    }
  };
  await Promise.all(Array.from({ length: parallel ? Math.min(STORE_CONCURRENCY, digests.length) : 1 }, worker));
  return missing.filter((m): m is string => m !== null);
}
