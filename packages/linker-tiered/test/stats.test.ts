// FORG-47: tier stats aggregation and the per-isolate reporter, in Node (the DO is played by an object
// over the same applyDelta the TierStats class runs). The workerd runs are in tiered.test.ts and pointer.test.ts.
import { describe, expect, it, vi } from "vitest";
import { applyDelta, emptyState, StatsReporter, type StatsDelta, type StatsService, type TierStatsState } from "../src/stats.ts";

function fakeDo() {
  let state: TierStatsState = emptyState(Date.parse("2026-10-25T12:00:00Z"));
  const calls = { add: 0 };
  const control = { down: false };
  const svc: StatsService = {
    add: async (d: StatsDelta) => {
      if (control.down) throw new Error("stats DO unreachable (test)");
      calls.add++;
      applyDelta(state, structuredClone(d), Date.now());
    },
    read: async () => {
      if (control.down) throw new Error("stats DO unreachable (test)");
      return structuredClone(state);
    },
    reset: async () => (state = emptyState(Date.now())),
  };
  const env: Record<string, unknown> = { FORGE_TIER_STATS: { idFromName: (n: string) => n, get: () => svc }, TIER_STATS_FLUSH_MS: "30" };
  return { env, calls, control, state: () => state };
}
const ctx = () => {
  const ps: Promise<unknown>[] = [];
  return { waitUntil: (p: Promise<unknown>) => void ps.push(p), drain: () => Promise.all(ps) };
};

describe("tier stats", () => {
  it("aggregates several isolates into one count with a real since", async () => {
    const d = fakeDo();
    const a = new StatsReporter("router");
    const b = new StatsReporter("router");
    const c = ctx();
    for (let i = 0; i < 5; i++) a.record(d.env, c, (x) => x.dynamic++);
    for (let i = 0; i < 3; i++) b.record(d.env, c, (x) => x.packed++);
    await c.drain();
    const s = (await a.read(d.env)).body as unknown as TierStatsState;
    expect([s.scope, s.dynamic, s.packed, s.since]).toEqual(["shared", 5, 3, "2026-10-25T12:00:00.000Z"]);
    expect(Object.keys(s.isolates)).toHaveLength(2);
    // Batched: one flush per isolate for the window, not one per request.
    expect(d.calls.add).toBe(2);
  });

  it("flushes a fallback at once", async () => {
    const d = fakeDo();
    const r = new StatsReporter("router");
    const c = ctx();
    r.record(d.env, c, (x) => {
      x.fallback++;
      x.byReason["LoadFailed"] = 1;
    }, true);
    await Promise.resolve();
    await new Promise((res) => setTimeout(res, 0));
    expect(d.state().fallback).toBe(1);
  });

  it("keeps a delta whose flush failed, logs it, and sends it with the next", async () => {
    const d = fakeDo();
    const r = new StatsReporter("router");
    const c = ctx();
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    d.control.down = true;
    r.record(d.env, c, (x) => x.fallback++, true);
    await c.drain();
    expect(err).toHaveBeenCalled();
    expect(r.flushErrors).toHaveLength(1);
    const down = await r.read(d.env);
    expect(down.status).toBe(503);
    expect(down.body).toMatchObject({ code: "StatsUnavailable", isolate: { scope: "isolate", fallback: 1 } });
    d.control.down = false;
    r.record(d.env, c, (x) => x.fallback++, true);
    await c.drain();
    expect(d.state().fallback).toBe(2);
    err.mockRestore();
  });

  it("answers per isolate, saying so, when there is no stats binding", async () => {
    const r = new StatsReporter("router");
    r.record({}, undefined, (x) => x.dynamic++);
    const s = await r.read({});
    expect(s.body).toMatchObject({ scope: "isolate", dynamic: 1 });
    expect(Date.parse(String(s.body["since"]))).toBeGreaterThan(Date.parse("2020-01-01"));
  });

  it("resets the shared counts and moves since", async () => {
    const d = fakeDo();
    const r = new StatsReporter("tier");
    const c = ctx();
    r.record(d.env, c, (x) => x.workflowAdvances.dynamic++);
    await c.drain();
    await r.reset(d.env);
    const s = (await r.read(d.env)).body as unknown as TierStatsState;
    expect([s.workflowAdvances.dynamic, s.flushes]).toEqual([0, 0]);
    expect(s.since).not.toBe("2026-10-25T12:00:00.000Z");
  });
});
