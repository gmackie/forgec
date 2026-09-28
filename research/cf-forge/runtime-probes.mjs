import { readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
const require = createRequire(new URL("../../packages/runtime/package.json", import.meta.url));
const { Effect } = await import(require.resolve("effect"));
const { Engine } = await import("../../packages/runtime/src/engine.ts");
const { Model } = await import("../../packages/runtime/src/model.ts");
const { MemoryStorage } = await import("../../packages/runtime/src/adapters/memory.ts");
const { testLayer } = await import("../../packages/runtime/src/testing.ts");
const { defineFunction } = await import("../../packages/runtime/src/functions.ts");
const { err } = await import("../../packages/runtime/src/errors.ts");
const bundle = JSON.parse(
  await readFile(new URL("../../conformance/fixtures/acme.app.json", import.meta.url)),
);
const observations = [];
let attempts = 0;
const engine = new Engine(new Model(bundle), testLayer(new MemoryStorage()), {
  functions: [
    defineFunction("@acme/commerce/_/FulfillOrder", () =>
      Effect.gen(function* () {
        attempts++;
        return yield* Effect.fail(err("DependencyUnavailable", "fixture failure"));
      }),
    ),
  ],
});
const envelope = {
  channel: "@acme/commerce/_/OrderEvents",
  message: "OrderSubmitted",
  tenant: "research",
  opId: "op",
  ordinal: 0,
  messageId: "op:0",
  payload: { order: "order", customer: "customer", revision: 2 },
  createdAt: "2026-09-28T00:00:00Z",
};
let first;
try {
  first = await engine.consume("fulfill-order", envelope);
} catch (e) {
  first = { error: e.code };
}
const second = await engine.consume("fulfill-order", envelope);
observations.push({
  name: "failed inbound handler must remain retryable",
  status: attempts === 2 ? "pass" : "fail",
  first,
  second,
  handlerAttempts: attempts,
  note: "MemoryStorage; this is not a live queue certification.",
});
try {
  const { operationMetadataSchema } = await import(
    pathToFileURL(resolve(process.env.CF_FORGE_ROOT, "packages/fern-forge/schemas/operation.ts"))
  );
  const operations = Object.values(bundle.openapi.paths).flatMap((path) =>
    Object.values(path).filter((o) => o?.operationId),
  );
  const rejected = operations
    .map((o) => ({ id: o.operationId, result: operationMetadataSchema().safeParse(o) }))
    .filter((o) => !o.result.success);
  observations.push({
    name: "our OpenAPI metadata accepted by fern-forge docs",
    status: rejected.length ? "fail" : "pass",
    total: operations.length,
    rejected: rejected.length,
    example: rejected[0] ? { id: rejected[0].id, issues: rejected[0].result.error.issues } : null,
  });
} catch (e) {
  observations.push({ name: "fern-forge docs metadata probe", status: "error", error: e.message });
}
await writeFile(
  new URL("./results/runtime-probes.json", import.meta.url),
  JSON.stringify(observations, null, 2) + "\n",
);
console.log(JSON.stringify(observations, null, 2));
