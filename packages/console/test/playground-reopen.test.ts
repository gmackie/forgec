import { expect, it } from "vitest";
import { canonical as registryCanonical, digestOf as registryDigest } from "@forgegraph/registry/artifacts";
import type { AppBundle } from "@forgegraph/runtime";
import type { PlaygroundDocument } from "../src/playground-document.js";
import { example } from "../web/editor/example.js";
import { canonical, digestOf } from "../web/editor/digest.js";
import { contractGraph } from "../web/editor/playground-model.js";
import { decideReopen } from "../web/editor/playground-reopen.js";
import { matchingPositions, matchingSamples } from "../web/editor/playground-session.js";
import { inspect } from "./editor-wasm.js";

it("uses the same canonical digest as the registry", async () => {
  const value = { b: 1, a: { d: "héllo", c: [3, { z: 1, y: 2 }] } };
  expect(canonical(value)).toBe(registryCanonical(value));
  expect(await digestOf(canonical(value))).toBe(registryDigest(registryCanonical(value)));
});

it("drops a position and a sample when the declaration name is gone", () => {
  const nodes = [{ path: "operations.forge", name: "DailySupportDigest" }];
  expect(
    matchingPositions(nodes, [
      { path: "operations.forge", name: "DailySupportDigest", x: 12, y: 34 },
      { path: "operations.forge", name: "Renamed", x: 9, y: 9 },
    ]),
  ).toEqual([{ path: "operations.forge", name: "DailySupportDigest", x: 12, y: 34 }]);
  expect(
    matchingSamples(nodes, [
      { path: "operations.forge", name: "DailySupportDigest", clock: "2026-10-03T08:00:00.000Z", payload: { note: "kept" } },
      { path: "operations.forge", name: "Renamed", clock: "2026-10-03T09:00:00.000Z", payload: {} },
    ]),
  ).toEqual([
    {
      path: "operations.forge",
      name: "DailySupportDigest",
      clock: "2026-10-03T08:00:00.000Z",
      payload: "{\"note\":\"kept\"}",
    },
  ]);
});

async function compiled() {
  const analysis = await inspect({ ...example, emit: "ir" });
  if (!analysis.ir) throw new Error("missing ir");
  const bundle = {
    version: "app-bundle/1",
    buildHash: "playground",
    ir: analysis.ir,
    contracts: { version: "contracts/1", resources: [], functions: [] },
    sql: {},
    dynamo: {},
  } as AppBundle;
  return { bundle, bundleDigest: await digestOf(canonical(bundle)) };
}

function document(bundleDigest: string, files = example.files): PlaygroundDocument {
  return {
    version: "playground/1",
    bundleDigest,
    name: example.name,
    currentFile: example.currentFile,
    files,
    positions: [
      { path: "operations.forge", name: "DailySupportDigest", x: 12, y: 34 },
      { path: "operations.forge", name: "Removed", x: 9, y: 9 },
    ],
    samples: [
      { path: "operations.forge", name: "DailySupportDigest", clock: "2026-10-03T08:00:00.000Z", payload: { note: "kept" } },
      { path: "operations.forge", name: "Removed", clock: "2026-10-03T09:00:00.000Z", payload: {} },
    ],
  };
}

it("continues when the draft recompiles to the published bundle", async () => {
  const { bundle, bundleDigest } = await compiled();
  let calls = 0;
  const decision = await decideReopen(bundle, document(bundleDigest), (project) => {
    calls += 1;
    return inspect(project);
  });
  expect(calls).toBe(1);
  expect(decision.mode).toBe("edit");
  if (decision.mode !== "edit") return;
  expect(decision.positions).toEqual([{ path: "operations.forge", name: "DailySupportDigest", x: 12, y: 34 }]);
  expect(decision.samples.map((sample) => sample.name)).toEqual(["DailySupportDigest"]);
  const graph = contractGraph(bundle.ir);
  expect(
    graph.edges.some((edge) => {
      const from = graph.nodes.find((node) => node.id === edge.from);
      const to = graph.nodes.find((node) => node.id === edge.to);
      return from?.name === "DailySupportDigest" && to?.name === "BuildSupportDigest" && edge.label === "runs";
    }),
  ).toBe(true);
});

it("opens a missing, mismatched, or oversized layer as the compiled contract", async () => {
  const { bundle, bundleDigest } = await compiled();
  let calls = 0;
  const inspectOnce = (project: Parameters<typeof inspect>[0]) => {
    calls += 1;
    return inspect(project);
  };
  const missing = await decideReopen(bundle, null, inspectOnce);
  expect(missing.mode).toBe("readonly");
  if (missing.mode === "readonly") expect(missing.reason).toMatch(/no playground source layer/);
  const wrong = await decideReopen(
    bundle,
    document(`sha256:${"ab".repeat(32)}`),
    inspectOnce,
  );
  expect(wrong.mode).toBe("readonly");
  if (wrong.mode === "readonly") expect(wrong.reason).toMatch(/does not match this package/);
  expect(calls).toBe(0);
  const changed = structuredClone(example.files);
  const operations = changed.find((file) => file.path === "operations.forge");
  if (!operations) throw new Error("operations.forge missing");
  operations.text = operations.text.replace('cron "0 8 * * *"', 'cron "0 9 * * *"');
  const mismatch = await decideReopen(bundle, document(bundleDigest, changed), inspectOnce);
  expect(mismatch.mode).toBe("readonly");
  if (mismatch.mode === "readonly") expect(mismatch.reason).toMatch(/does not recompile/);
  const huge = document(bundleDigest);
  huge.files = [{ path: "main.forge", text: "x".repeat(8_000_001) }];
  huge.currentFile = "main.forge";
  const oversized = await decideReopen(bundle, huge, inspectOnce);
  expect(oversized.mode).toBe("readonly");
  if (oversized.mode === "readonly") expect(oversized.reason).toMatch(/too large/);
  expect(calls).toBe(1);
});
