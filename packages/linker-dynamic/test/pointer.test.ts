// FORG-47: the manifest pointer's compare-and-swap and each isolate's bounded cache, in Node. The DO
// is played by an in-memory storage behind the same functions the ManifestPointer class calls; the
// workerd runs (several isolates, a real DO) are packages/linker-tiered/test/pointer.test.ts.
import { describe, expect, it } from "vitest";
import { LinkError } from "../src/manifest.ts";
import { expectedVersion, LinkedCache, PointerCache, readPointer, scopeOf, swap, swapPointer, type Pointer, type PointerBody, type PointerEnv, type PointerService, type PointerStorage } from "../src/pointer.ts";

const body = (n: number): PointerBody => ({ manifestHash: `sha256:m${n}`, manifestBlob: `sha256:b${n}`, kitBlob: "sha256:kit", closures: { "GET /x": `sha256:c${n}` }, dynamic: null });

function memory(): PointerStorage {
  const m = new Map<string, unknown>();
  return { get: async <T>(k: string) => structuredClone(m.get(k)) as T | undefined, put: async (k, v) => void m.set(k, structuredClone(v)) };
}

/** A DO namespace over in-memory storage, one storage per object name; `down` makes every call throw. */
function namespace() {
  const objects = new Map<string, PointerStorage>();
  const state = { down: false, reads: 0, delayMs: 0 };
  const svc = (name: string): PointerService => {
    if (!objects.has(name)) objects.set(name, memory());
    const s = objects.get(name)!;
    const gate = async () => {
      if (state.delayMs) await new Promise((r) => setTimeout(r, state.delayMs));
      if (state.down) throw new Error("Durable Object unreachable (test)");
    };
    return {
      read: async (scope) => (await gate(), state.reads++, readPointer(s, scope)),
      swap: async (scope, expect, b) => (await gate(), swapPointer(s, scope, expect, b, Date.now())),
    };
  };
  const env: PointerEnv = { LINKER_POINTER: { idFromName: (n) => n, get: (id) => svc(id as string) }, LINKER_POINTER_TTL_MS: "1000" };
  return { env, state, objects };
}

describe("pointer compare-and-swap", () => {
  it("versions every swap and keeps a short history", async () => {
    const s = memory();
    expect((await readPointer(s, "default")).version).toBe(0);
    const a = await swapPointer(s, "default", 0, body(1), 0);
    const b = await swapPointer(s, "default", 1, body(2), 1000);
    expect(a.ok && b.ok).toBe(true);
    const p = await readPointer(s, "default");
    expect([p.version, p.manifestHash, p.updatedAt]).toEqual([2, "sha256:m2", "1970-01-01T00:00:01.000Z"]);
    expect(p.history.map((h) => [h.version, h.manifestHash])).toEqual([[1, "sha256:m1"]]);
  });

  it("refuses a stale writer and leaves the pointer where it was", async () => {
    const s = memory();
    await swapPointer(s, "default", 0, body(1), 0);
    // Two writers both read version 1; the first wins, the second is stale.
    expect((await swapPointer(s, "default", 1, body(2), 0)).ok).toBe(true);
    const stale = await swapPointer(s, "default", 1, body(3), 0);
    expect(stale.ok).toBe(false);
    expect(!stale.ok && stale.current.version).toBe(2);
    expect((await readPointer(s, "default")).manifestHash).toBe("sha256:m2");
  });

  it("swap() answers StalePointer (409) naming both versions", async () => {
    const { env } = namespace();
    await swap(env, "default", null, body(1));
    await swap(env, "default", 1, body(2));
    const e = await swap(env, "default", 1, body(3)).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(LinkError);
    expect((e as LinkError).status).toBe(409);
    expect((e as LinkError).problem()).toMatchObject({ code: "StalePointer", expected: 1, current: 2, manifestHash: "sha256:m2" });
  });

  it("an unconditional swap uses the version it just read", async () => {
    const { env } = namespace();
    const r = await swap(env, "default", null, body(1));
    expect([r.previous.version, r.pointer.version]).toEqual([0, 1]);
    expect((await swap(env, "default", null, body(2))).pointer.version).toBe(2);
  });

  it("keeps scopes apart (one object per scope)", async () => {
    const { env, objects } = namespace();
    await swap(env, "default", null, body(1));
    await swap(env, "session:abc", null, body(9));
    expect([...objects.keys()].sort()).toEqual(["pointer:default", "pointer:session:abc"]);
    const c = new PointerCache();
    expect((await c.read(env, "default")).pointer.manifestHash).toBe("sha256:m1");
    expect((await c.read(env, "session:abc")).pointer.manifestHash).toBe("sha256:m9");
    expect(() => scopeOf(env, "Bad Scope!")).toThrow(/BadScope/);
    expect(scopeOf({ ...env, LINKER_SCOPE: "session:x" })).toBe("session:x");
    expect(scopeOf(env)).toBe("default");
  });

  it("parses If-Match", () => {
    const req = (h: Record<string, string>) => new Request("http://x/", { headers: h });
    expect(expectedVersion(req({}))).toBeNull();
    expect(expectedVersion(req({ "if-match": '"7"' }))).toBe(7);
    expect(expectedVersion(req({ "if-match": "7" }))).toBe(7);
    expect(expectedVersion(req({ "x-linker-pointer-version": "0" }))).toBe(0);
    expect(() => expectedVersion(req({ "if-match": "*" }))).toThrow(/not a pointer version/);
  });
});

describe("an isolate's pointer cache", () => {
  it("serves its copy within the bound and revalidates after it", async () => {
    const { env, state } = namespace();
    let now = 0;
    const c = new PointerCache(() => now);
    await swap(env, "default", null, body(1));
    expect((await c.read(env, "default")).how).toBe("changed");
    now = 999;
    expect((await c.read(env, "default")).how).toBe("cached");
    expect(state.reads).toBe(2); // swap's own read + the first revalidation
    // Another isolate swaps; this one sees it at the first request after its copy expires.
    await swap(env, "default", 1, body(2));
    now = 999.5;
    expect((await c.read(env, "default")).pointer.manifestHash).toBe("sha256:m1");
    now = 1000;
    const r = await c.read(env, "default");
    expect([r.how, r.pointer.manifestHash]).toEqual(["changed", "sha256:m2"]);
    now = 2000;
    expect((await c.read(env, "default")).how).toBe("revalidated");
    expect(c.stats).toMatchObject({ hits: 2, revalidations: 3, changes: 2, failures: 0 });
  });

  it("TTL 0 reads the DO on every request", async () => {
    const { env, state } = namespace();
    env.LINKER_POINTER_TTL_MS = "0";
    await swap(env, "default", null, body(1));
    const c = new PointerCache(() => 0);
    for (let i = 0; i < 3; i++) await c.read(env, "default");
    expect(state.reads).toBe(4);
  });

  it("shares one DO read among concurrent requests", async () => {
    const { env, state } = namespace();
    await swap(env, "default", null, body(1));
    state.reads = 0;
    state.delayMs = 20;
    const c = new PointerCache(() => 0);
    const rs = await Promise.all([c.read(env, "default"), c.read(env, "default"), c.read(env, "default")]);
    expect(state.reads).toBe(1);
    expect(rs.map((r) => r.pointer.version)).toEqual([1, 1, 1]);
  });

  it("fails closed: DO unreachable after the bound is LinkerRefused/PointerUnavailable, never the old copy", async () => {
    const { env, state } = namespace();
    let now = 0;
    const c = new PointerCache(() => now);
    await swap(env, "default", null, body(1));
    await c.read(env, "default");
    state.down = true;
    now = 500;
    expect((await c.read(env, "default")).how).toBe("cached"); // within the bound the copy is current by definition
    now = 1000;
    const e = (await c.read(env, "default").catch((x: unknown) => x)) as LinkError;
    expect(e).toBeInstanceOf(LinkError);
    expect([e.code, e.status]).toEqual(["LinkerRefused", 503]);
    expect(e.problem()).toMatchObject({ code: "LinkerRefused", reason: "PointerUnavailable" });
    // Still refused on the next request (no entry was refreshed), and served again once the DO answers.
    await expect(c.read(env, "default")).rejects.toThrow(/PointerUnavailable/);
    state.down = false;
    expect((await c.read(env, "default")).how).toBe("revalidated");
    expect(c.stats.failures).toBe(2);
  });

  it("fails closed with no binding at all", async () => {
    const e = (await new PointerCache().read({}, "default").catch((x: unknown) => x)) as LinkError;
    expect(e.problem()).toMatchObject({ code: "LinkerRefused", reason: "NoPointerBinding" });
  });

  it("a swap while the DO is unreachable is refused, not applied locally", async () => {
    const { env, state } = namespace();
    state.down = true;
    await expect(swap(env, "default", null, body(1))).rejects.toMatchObject({ code: "LinkerRefused" });
    state.down = false;
    expect((await new PointerCache().read(env, "default")).pointer.version).toBe(0);
  });

  it("remembers its own swap at once", async () => {
    const { env } = namespace();
    const c = new PointerCache(() => 0);
    await swap(env, "default", null, body(1));
    await c.read(env, "default");
    const r = await swap(env, "default", 1, body(2));
    c.remember(r.pointer);
    expect((await c.read(env, "default")).pointer.manifestHash).toBe("sha256:m2");
  });
});

describe("linked state per pointer target", () => {
  it("re-links a swap-back without work and drops failures", async () => {
    const c = new LinkedCache<string>(2);
    let links = 0;
    const p = (n: number) => ({ manifestBlob: `b${n}`, kitBlob: "k" }) as Pointer;
    const link = (v: string) => async () => (links++, v);
    expect(await c.get(p(1), link("one"))).toBe("one");
    expect(await c.get(p(2), link("two"))).toBe("two");
    expect(await c.get(p(1), link("x"))).toBe("one");
    expect(links).toBe(2);
    await expect(c.get(p(3), async () => Promise.reject(new Error("no")))).rejects.toThrow("no");
    expect(await c.get(p(3), link("three"))).toBe("three");
  });
});
