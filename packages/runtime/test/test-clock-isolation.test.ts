import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Effect, Layer } from "effect";
import { expect, it } from "vitest";
import { Engine } from "../src/engine.js";
import { Model, type AppBundle } from "../src/model.js";
import { Clock } from "../src/services.js";
import { testLayer } from "../src/testing.js";
import { MemoryStorage } from "../src/adapters/memory.js";

const model = new Model(JSON.parse(readFileSync(resolve(import.meta.dirname, "../../../conformance/fixtures/allocation-consumer/app.json"), "utf8")) as AppBundle);
const now = (engine: Engine) => Effect.runPromise(Clock.pipe(Effect.map(clock => clock.now()), Effect.provide(engine.layer)));

it("a delayed older engine clock jump cannot advance a newer test fixture", async () => {
  const older = new Engine(model, testLayer(new MemoryStorage()));
  let release!: () => void;
  const delayed = new Promise<void>(resolve => { release = resolve; }).then(() => older.testClockJump(86400000));
  const newer = new Engine(model, testLayer(new MemoryStorage()));
  release();
  await delayed;
  expect(await now(newer)).toBe("2026-01-01T00:00:00.000Z");
  expect(await now(older)).toBe("2026-01-02T00:00:00.000Z");
});

it("engines sharing a test layer share its clock without affecting other layers", async () => {
  const layer = testLayer(new MemoryStorage());
  const first = new Engine(model, layer), restarted = new Engine(model, layer);
  const unrelated = new Engine(model, testLayer(new MemoryStorage()));
  restarted.testClockJump(60000);
  expect(await now(first)).toBe("2026-01-01T00:01:00.000Z");
  first.testClockJump(60000);
  expect(await now(restarted)).toBe("2026-01-01T00:02:01.000Z");
  expect(await now(unrelated)).toBe("2026-01-01T00:00:00.000Z");
});

it("an engine without a registered test layer cannot jump another engine's test clock", async () => {
  const base = testLayer(new MemoryStorage());
  const production = new Engine(model, Layer.merge(base, Layer.succeed(Clock)({ now: () => "2030-01-01T00:00:00.000Z" })));
  const test = new Engine(model, testLayer(new MemoryStorage()));
  production.testClockJump(86400000);
  expect(await now(test)).toBe("2026-01-01T00:00:00.000Z");
});
