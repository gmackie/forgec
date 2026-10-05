import { Effect } from "effect";
import {
  Engine,
  MemoryStorage,
  Model,
  defineFunction,
  testLayer,
  type DomainIR,
  type TickResult,
} from "@forgegraph/runtime";

export interface PlaygroundSession {
  tick(now: string): Promise<TickResult[]>;
}

/**
 * One in-memory runtime for the open draft. Schedule ticks use the real
 * scheduler. A function with no `impl/` body succeeds as a playground
 * stand-in and writes no records.
 */
export function openPlaygroundRuntime(ir: DomainIR): PlaygroundSession {
  const model = new Model({
    version: "app-bundle/1",
    buildHash: "playground",
    ir,
    contracts: { version: "contracts/1", resources: [], functions: [] },
    sql: {},
    dynamo: {},
  });
  const engine = new Engine(model, testLayer(new MemoryStorage()), {
    functions: model.functions.map((fn) =>
      defineFunction(fn.id, ({ input }) =>
        Effect.succeed({
          playground: "stand-in",
          input: (input ?? {}) as Record<string, unknown>,
        }),
      ),
    ),
  });
  return {
    tick: (now) => Effect.runPromise(engine.schedules.tick("playground", now)),
  };
}
