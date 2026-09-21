/** Deterministic service implementations for tests and the in-memory target. */
import { Layer } from "effect";
import type { Resource } from "./model.js";
import { MemoryObjectStore } from "./adapters/memory-objects.js";
import { Clock, CursorSecret, IdGen, Objects, Storage, type ObjectStoreAdapter, type StorageAdapter } from "./services.js";

/** Clocks of every test layer created in this process; Engine.testClockJump advances the latest. */
export const testClocks: { jump: (ms: number) => void }[] = [];

export function testLayer(storage: StorageAdapter, opts: { start?: string; secret?: string; runId?: string; objects?: ObjectStoreAdapter; idPrefix?: string } = {}) {
  let t = Date.parse(opts.start ?? "2026-01-01T00:00:00.000Z");
  testClocks.push({ jump: (ms) => void (t += ms) });
  const counters = new Map<string, number>();
  let ops = 0;
  // Operation ids seed provider idempotency tokens; against shared live stores they must not repeat across runs.
  const runId = opts.runId ?? "";
  const clock = Layer.succeed(Clock)({ now: () => new Date((t += 1000) - 1000).toISOString() });
  const ids = Layer.succeed(IdGen)({
    next: (r: Resource) => {
      const prefix = r.name.slice(0, 3).toLowerCase();
      const n = (counters.get(prefix) ?? 0) + 1;
      counters.set(prefix, n);
      return `${opts.idPrefix ?? ""}${prefix}_${String(n).padStart(4, "0")}`;
    },
    opId: () => `${runId}op_${String(++ops).padStart(6, "0")}`,
  });
  return Layer.mergeAll(clock, ids, Layer.succeed(Storage)(storage), Layer.succeed(CursorSecret)({ key: opts.secret ?? "test-secret" }), Layer.succeed(Objects)(opts.objects ?? new MemoryObjectStore()));
}
