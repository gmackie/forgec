import { expect, it } from "vitest";
import type { Project } from "../web/editor/language.js";
import { example } from "../web/editor/example.js";
import { canFire, hasCompilerErrors, playgroundGraph } from "../web/editor/playground-model.js";
import { openPlaygroundRuntime } from "../web/editor/playground-run.js";
import { inspect } from "./editor-wasm.js";
const due = "2026-10-03T08:00:00.000Z";
const early = "2026-10-03T07:00:00.000Z";

function withoutDigest(project: Project): Project {
  return {
    ...project,
    files: project.files.map((file) =>
      file.path === "operations.forge"
        ? {
            ...file,
            text: file.text.replace(
              "function BuildSupportDigest {\n  purpose CustomerSupport\n  uses { Ticket read }\n}\n\n",
              "",
            ),
          }
        : file,
    ),
  };
}

it("connects DailySupportDigest to BuildSupportDigest and fires that schedule", async () => {
  const analysis = inspect({ ...example, emit: "ir" });
  const graph = playgroundGraph(example, analysis);
  const source = graph.nodes.find((node) => node.name === "DailySupportDigest");
  const target = graph.nodes.find((node) => node.name === "BuildSupportDigest");
  expect(source?.kind).toBe("source");
  expect(target?.kind).toBe("function");
  expect(
    graph.edges.some(
      (edge) => edge.from === source?.id && edge.to === target?.id && edge.label === "runs",
    ),
  ).toBe(true);
  expect(analysis.ir).toBeTruthy();

  const session = openPlaygroundRuntime(analysis.ir!);
  const ran = await session.tick(due);
  expect(ran.find((result) => result.source.endsWith("/DailySupportDigest"))).toMatchObject({
    outcome: "ran",
    occurrence: due,
  });
  const again = await session.tick(due);
  expect(again.find((result) => result.source.endsWith("/DailySupportDigest"))).toMatchObject({
    outcome: "duplicate",
    occurrence: due,
  });

  const fresh = openPlaygroundRuntime(analysis.ir!);
  expect(await fresh.tick(early)).toEqual([]);
});

it("keeps fire disabled when the compiler rejects the draft", () => {
  const project = withoutDigest(example);
  expect(project.files.find((file) => file.path === "operations.forge")?.text).not.toContain(
    "function BuildSupportDigest",
  );
  const analysis = inspect(project);
  const source = playgroundGraph(project, analysis).nodes.find(
    (node) => node.name === "DailySupportDigest",
  );
  expect(hasCompilerErrors(analysis)).toBe(true);
  expect(canFire(analysis, source ?? null)).toBe(false);
});
