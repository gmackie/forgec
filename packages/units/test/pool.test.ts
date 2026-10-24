// FORG-41: the instance pool on its own, with stand-in instances (no WASM).
import { describe, expect, it } from "vitest";
import { DEFAULT_POOL, instancePool } from "../src/pool.ts";

const tick = () => new Promise<void>((r) => setTimeout(r, 1));
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
}

/** Instances are numbered in creation order. */
function counter() {
  let n = 0;
  return async () => ++n;
}

describe("instancePool", () => {
  it("gives every in-flight call its own instance, and reuses the most recently released", async () => {
    const pool = instancePool(counter(), { max: 8, idle: 8 });
    const gates = [deferred(), deferred(), deferred()];
    const seen: number[] = [];
    const calls = gates.map((g) => pool.run(async (i) => (seen.push(i), await g.promise, i)));
    await tick();
    expect(seen.sort()).toEqual([1, 2, 3]);
    gates.forEach((g) => g.resolve());
    expect(await Promise.all(calls)).toEqual([1, 2, 3]);
    expect(pool.stats()).toMatchObject({ live: 3, idle: 3, created: 3, peak: 3 });
    // Last released first.
    expect(await pool.run(async (i) => i)).toBe(3);
  });

  it("discards an instance whose call throws, and never hands it out again", async () => {
    const pool = instancePool(counter(), { max: 2, idle: 2 });
    await expect(pool.run(async () => Promise.reject(new Error("trap")))).rejects.toThrow("trap");
    await expect(pool.run(() => {
      throw new Error("sync trap");
    })).rejects.toThrow("sync trap");
    expect(pool.stats()).toMatchObject({ live: 0, idle: 0, discarded: 2 });
    // Instances 1 and 2 were discarded: the next call gets a new one.
    expect(await pool.run(async (i) => i)).toBe(3);
  });

  it("makes calls beyond max wait, and a waiter gets a fresh instance when the busy one is discarded", async () => {
    const pool = instancePool(counter(), { max: 1, idle: 1 });
    const gate = deferred();
    const first = pool.run(async (i) => {
      await gate.promise;
      throw new Error(`trap on ${i}`);
    });
    const second = pool.run(async (i) => i);
    await tick();
    expect(pool.stats()).toMatchObject({ live: 1, waiting: 1 });
    gate.resolve();
    await expect(first).rejects.toThrow("trap on 1");
    expect(await second).toBe(2);
    expect(pool.stats()).toMatchObject({ live: 1, idle: 1, waiting: 0, created: 2, discarded: 1, peak: 1 });
  });

  it("hands a released instance straight to a waiting call", async () => {
    const pool = instancePool(counter(), { max: 1, idle: 0 });
    const gate = deferred();
    const first = pool.run(async (i) => (await gate.promise, i));
    const second = pool.run(async (i) => i);
    await tick();
    gate.resolve();
    expect(await Promise.all([first, second])).toEqual([1, 1]);
    // idle 0: nothing is kept once no call waits.
    expect(pool.stats()).toMatchObject({ live: 0, idle: 0, created: 1 });
  });

  it("drops instances released beyond the idle limit", async () => {
    const pool = instancePool(counter(), { max: 4, idle: 1 });
    const gates = [deferred(), deferred(), deferred()];
    const calls = gates.map((g) => pool.run(async () => g.promise));
    await tick();
    gates.forEach((g) => g.resolve());
    await Promise.all(calls);
    expect(pool.stats()).toMatchObject({ live: 1, idle: 1, created: 3 });
  });

  it("surfaces a failing create to the caller and frees the slot", async () => {
    let fail = true;
    const pool = instancePool(async () => {
      if (fail) throw new Error("the host does not provide it");
      return "ok";
    }, { max: 1, idle: 1 });
    await expect(pool.warm()).rejects.toThrow("the host does not provide it");
    await expect(pool.run(async (i) => i)).rejects.toThrow("the host does not provide it");
    fail = false;
    expect(await pool.run(async (i) => i)).toBe("ok");
    expect(pool.stats()).toMatchObject({ live: 1, created: 1 });
  });

  it("warm creates one instance only when none is alive", async () => {
    const pool = instancePool(counter());
    await pool.warm();
    await pool.warm();
    expect(pool.stats()).toMatchObject({ live: 1, idle: 1, created: 1 });
  });

  it("defaults to 32 instances, all kept idle", () => {
    expect(DEFAULT_POOL).toEqual({ max: 32, idle: 32 });
    expect(() => instancePool(counter(), { max: 0, idle: 0 })).toThrow(RangeError);
  });
});
