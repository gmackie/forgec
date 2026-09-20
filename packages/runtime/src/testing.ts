/** Deterministic service implementations for tests and the in-memory target. */
import { Layer } from "effect";
import type { Resource } from "./model.js";
import { Clock, CursorSecret, IdGen, Storage, type StorageAdapter } from "./services.js";

export function testLayer(storage: StorageAdapter, opts: { start?: string; secret?: string } = {}) {
  let t = Date.parse(opts.start ?? "2026-01-01T00:00:00.000Z");
  const counters = new Map<string, number>();
  let ops = 0;
  const clock = Layer.succeed(Clock)({ now: () => new Date((t += 1000) - 1000).toISOString() });
  const ids = Layer.succeed(IdGen)({
    next: (r: Resource) => {
      const prefix = r.name.slice(0, 3).toLowerCase();
      const n = (counters.get(prefix) ?? 0) + 1;
      counters.set(prefix, n);
      return `${prefix}_${String(n).padStart(4, "0")}`;
    },
    opId: () => `op_${String(++ops).padStart(6, "0")}`,
  });
  return Layer.mergeAll(clock, ids, Layer.succeed(Storage)(storage), Layer.succeed(CursorSecret)({ key: opts.secret ?? "test-secret" }));
}
