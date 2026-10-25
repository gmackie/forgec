// FORG-48: the unit fetch layers in Node, against an in-memory store and an in-memory Cache API.
import { describe, expect, it } from "vitest";
import { LinkError } from "../src/manifest.ts";
import { MemoryBlobStore } from "../src/store.ts";
import { cacheKey, MemoryUnits, missingBlobs, UnitFetcher, unitFetchConfig, type CacheLike } from "../src/unit-fetch.ts";

const enc = (s: string) => new TextEncoder().encode(s);

/** The Cache API's shape over a Map, counting calls. */
class FakeCache implements CacheLike {
  readonly entries = new Map<string, Uint8Array>();
  readonly calls = { match: 0, put: 0, delete: 0 };
  async match(key: string) {
    this.calls.match++;
    const b = this.entries.get(key);
    return b ? new Response(b.slice() as Uint8Array<ArrayBuffer>) : undefined;
  }
  async put(key: string, res: Response) {
    this.calls.put++;
    this.entries.set(key, new Uint8Array(await res.arrayBuffer()));
  }
  async delete(key: string) {
    this.calls.delete++;
    return this.entries.delete(key);
  }
}

/** A store that counts reads and can hold a read open, to observe concurrency. */
class CountingStore extends MemoryBlobStore {
  gets = 0;
  open = 0;
  maxOpen = 0;
  override async get(digest: string) {
    this.gets++;
    this.open++;
    this.maxOpen = Math.max(this.maxOpen, this.open);
    await new Promise((r) => setTimeout(r, 5));
    this.open--;
    return super.get(digest);
  }
}

const linkError = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    if (e instanceof LinkError) return e;
    throw e;
  }
  throw new Error("expected a LinkError");
};

async function seeded(n = 3) {
  const store = new CountingStore();
  const blobs: Record<string, string> = {};
  for (let i = 0; i < n; i++) blobs[`m${i}.js`] = await store.put(enc(`export default ${i};`));
  return { store, blobs };
}

describe("unitFetchConfig", () => {
  it("defaults to every layer, reads off, and refuses unknown words", () => {
    expect(unitFetchConfig(undefined)).toEqual({ memory: true, cache: true, parallel: true });
    expect(unitFetchConfig("off")).toEqual({ memory: false, cache: false, parallel: false });
    expect(unitFetchConfig("memory,parallel")).toEqual({ memory: true, cache: false, parallel: true });
    expect(() => unitFetchConfig("memroy")).toThrow(/unknown memroy/);
  });
});

describe("UnitFetcher", () => {
  it("reads the store once, then serves the isolate's memory layer and the Cache API", async () => {
    const { store, blobs } = await seeded();
    const cache = new FakeCache();
    const memory = new MemoryUnits(1 << 20);
    const config = unitFetchConfig(undefined);
    const first = new UnitFetcher(store, { config, cache, memory });
    const got = await first.all(blobs, (n) => n);
    expect(got["m1.js"]!.text).toBe("export default 1;");
    expect(first.report()).toMatchObject({ store: 3, cache: 0, memory: 0, storeBytes: 51 });
    expect(cache.entries.size).toBe(3);
    // Same isolate: memory, no store or cache read.
    const second = new UnitFetcher(store, { config, cache, memory });
    await second.all(blobs, (n) => n);
    expect(second.report()).toMatchObject({ store: 0, cache: 0, memory: 3 });
    expect(store.gets).toBe(3);
    // A new isolate (empty memory): the Cache API, verified, no store read.
    const third = new UnitFetcher(store, { config, cache, memory: new MemoryUnits(1 << 20) });
    await third.all(blobs, (n) => n);
    expect(third.report()).toMatchObject({ store: 0, cache: 3, memory: 0 });
    expect(store.gets).toBe(3);
  });

  it("off: every blob from the store, one after another, nothing kept", async () => {
    const { store, blobs } = await seeded(4);
    const cache = new FakeCache();
    const memory = new MemoryUnits(1 << 20);
    for (let i = 0; i < 2; i++) await new UnitFetcher(store, { config: unitFetchConfig("off"), cache, memory }).all(blobs, (n) => n);
    expect(store.gets).toBe(8);
    expect(store.maxOpen).toBe(1);
    expect(cache.calls).toEqual({ match: 0, put: 0, delete: 0 });
    expect(memory.stats().entries).toBe(0);
  });

  it("parallel reads are bounded by the per-request connection limit and deduplicated", async () => {
    const { store, blobs } = await seeded(10);
    const f = new UnitFetcher(store, { config: unitFetchConfig("parallel"), memory: new MemoryUnits(1 << 20) });
    await f.all({ ...blobs, dup: blobs["m0.js"]! }, (n) => n);
    expect(store.maxOpen).toBe(6);
    expect(store.gets).toBe(10);
  });

  it("a corrupt Cache API entry fails closed, is deleted, and the next request reads the store", async () => {
    const { store, blobs } = await seeded(1);
    const d = blobs["m0.js"]!;
    const cache = new FakeCache();
    cache.entries.set(cacheKey(d), enc("export default 666;"));
    const config = unitFetchConfig(undefined);
    const e = await linkError(new UnitFetcher(store, { config, cache, memory: new MemoryUnits(1 << 20) }).text(d, "u: m0.js"));
    expect(e.code).toBe("ModuleDigestMismatch");
    expect(e.message).toContain("Cache API copy of blob");
    expect(store.gets).toBe(0); // no silent fallback to the store in the failing request
    expect(cache.entries.has(cacheKey(d))).toBe(false);
    const memory = new MemoryUnits(1 << 20);
    expect(await new UnitFetcher(store, { config, cache, memory }).text(d, "u")).toBe("export default 0;");
    expect(store.gets).toBe(1);
    expect(memory.stats().entries).toBe(1);
  });

  it("corrupt or missing store bytes fail closed and are not kept", async () => {
    const { store, blobs } = await seeded(1);
    const d = blobs["m0.js"]!;
    store.blobs.set(d, enc("export default 2;"));
    const cache = new FakeCache();
    const memory = new MemoryUnits(1 << 20);
    const config = unitFetchConfig(undefined);
    expect((await linkError(new UnitFetcher(store, { config, cache, memory }).text(d, "u"))).code).toBe("ModuleDigestMismatch");
    expect(memory.stats().entries).toBe(0);
    expect(cache.entries.size).toBe(0);
    expect((await linkError(new UnitFetcher(store, { config, cache, memory }).text(`sha256:${"1".repeat(64)}`, "u"))).code).toBe("MissingModule");
  });

  it("json() parses once per memory entry", async () => {
    const store = new MemoryBlobStore();
    const d = await store.put(enc(JSON.stringify({ buildHash: "b" })));
    const memory = new MemoryUnits(1 << 20);
    const config = unitFetchConfig("memory");
    const a = await new UnitFetcher(store, { config, memory }).json(d, "app");
    const b = await new UnitFetcher(store, { config, memory }).json(d, "app");
    expect(a).toEqual({ buildHash: "b" });
    expect(b).toBe(a);
  });
});

describe("MemoryUnits", () => {
  it("evicts least recently used entries past its byte budget", () => {
    const m = new MemoryUnits(10);
    m.set("a", "aaaa", 4);
    m.set("b", "bbbb", 4);
    m.get("a");
    m.set("c", "cccc", 4);
    expect([!!m.get("a"), !!m.get("b"), !!m.get("c")]).toEqual([true, false, true]);
    expect(m.stats()).toEqual({ entries: 2, bytes: 8, budget: 10 });
    m.set("big", "x".repeat(11), 11);
    expect(m.get("big")).toBeUndefined();
  });
});

describe("missingBlobs", () => {
  it("reports what the store lacks, in order", async () => {
    const { store, blobs } = await seeded(2);
    const none = `sha256:${"2".repeat(64)}`;
    expect(await missingBlobs(store, [[blobs["m0.js"]!, "a"], [none, "b"], [blobs["m1.js"]!, "c"], [`sha256:${"3".repeat(64)}`, "d"]])).toEqual(["b", "d"]);
  });
});
