import { expect, it } from "vitest";
import type { Analysis, Project } from "../web/editor/language.js";
import { playgroundGraph } from "../web/editor/playground-model.js";
import { cutWire, deleteDeclaration, snapWire, type WireEnd } from "../web/editor/playground-wires.js";
import { inspect } from "./editor-wasm.js";

const program = `export resource Ticket @tenant @timestamps @versioned {
  id : id
}

export function Build {
}

channel Events {
  message Payload {
    value : text
  }
}

source Daily {
  cron "0 8 * * *"
  timezone "UTC"
}
`;

function projectFor(text: string): Project {
  return {
    name: "@playground/program",
    currentFile: "main.forge",
    files: [{ path: "main.forge", text }],
  };
}

function end(project: Project, analysis: Analysis, name: string): WireEnd {
  const node = playgroundGraph(project, analysis).nodes.find((item) => item.name === name);
  if (!node) {
    const details = analysis.diagnostics.map((item) => `${item.code} ${item.message}`).join("; ");
    throw new Error(`missing ${name}${details ? `: ${details}` : ""}`);
  }
  return { kind: node.kind, name: node.name, path: node.path, node: node.entry.node };
}

function edge(project: Project, analysis: Analysis, from: string, to: string, label: string) {
  const graph = playgroundGraph(project, analysis);
  const source = graph.nodes.find((node) => node.name === from);
  const target = graph.nodes.find((node) => node.name === to);
  return graph.edges.some((item) => item.from === source?.id && item.to === target?.id && item.label === label);
}

it("removes a declaration and one preceding blank line", () => {
  const text = "function A {\n}\n\nfunction B {\n}\n\nfunction C {\n}\n";
  const start = text.indexOf("function B");
  const endIndex = text.indexOf("}", start) + 1;
  expect(deleteDeclaration(text, { start, end: endIndex })).toBe("function A {\n}\n\nfunction C {\n}\n");
  expect(deleteDeclaration("function A {\n}\n", { start: 0, end: "function A {\n}".length })).toBe("");
});

it("snaps source, resource, channel, and subscription wires in one file", () => {
  let text = program;
  const snap = (fromName: string, toName: string) => {
    const project = projectFor(text);
    const analysis = inspect(project);
    const next = snapWire(text, end(project, analysis, fromName), end(project, analysis, toName));
    text = next.text;
    return next.label;
  };
  expect(snap("Daily", "Build")).toBe("runs");
  expect(snap("Build", "Ticket")).toBe("uses");
  expect(snap("Build", "Events")).toBe("sends");
  expect(snap("Events", "Build")).toBe("on");
  expect(snap("Build", "Ticket")).toBe("uses");
  expect(snap("Events", "Build")).toBe("on");
  const project = projectFor(text);
  const analysis = inspect(project);
  const errors = analysis.diagnostics.filter((item) => item.severity === "error");
  expect(errors, errors.map((item) => item.message).join("\n")).toEqual([]);
  expect(edge(project, analysis, "Daily", "Build", "runs")).toBe(true);
  expect(edge(project, analysis, "Build", "Ticket", "uses")).toBe(true);
  expect(edge(project, analysis, "Build", "Events", "sends")).toBe(true);
  expect(edge(project, analysis, "Events", "Build", "on")).toBe(true);
  expect(text.match(/uses \{/g)?.length).toBe(1);
  expect(text.match(/on Events\.Payload -> Build/g)?.length).toBe(1);
});

it("cuts a wire and leaves the declarations in place", () => {
  let text = program.replace(
    "export resource Ticket @tenant @timestamps @versioned {\n  id : id\n}",
    "export resource Ticket @tenant @timestamps @versioned {\n  id : id\n}\n\nexport resource Plan @tenant @timestamps @versioned {\n  id : id\n}",
  );
  const snap = (fromName: string, toName: string) => {
    const project = projectFor(text);
    const analysis = inspect(project);
    text = snapWire(text, end(project, analysis, fromName), end(project, analysis, toName)).text;
  };
  const cut = (fromName: string, toName: string, label: string) => {
    const project = projectFor(text);
    const analysis = inspect(project);
    text = cutWire(text, end(project, analysis, fromName), end(project, analysis, toName), label);
  };
  snap("Daily", "Build");
  snap("Build", "Ticket");
  snap("Build", "Plan");
  snap("Build", "Events");
  snap("Events", "Build");
  cut("Events", "Build", "on");
  cut("Build", "Events", "sends");
  cut("Build", "Ticket", "uses");
  let project = projectFor(text);
  let analysis = inspect(project);
  expect(analysis.diagnostics.filter((item) => item.severity === "error")).toEqual([]);
  expect(edge(project, analysis, "Daily", "Build", "runs")).toBe(true);
  expect(edge(project, analysis, "Build", "Plan", "uses")).toBe(true);
  expect(edge(project, analysis, "Build", "Ticket", "uses")).toBe(false);
  expect(edge(project, analysis, "Build", "Events", "sends")).toBe(false);
  expect(edge(project, analysis, "Events", "Build", "on")).toBe(false);
  expect(text).toContain("input Events.Payload");
  expect(text).toContain("resource Ticket");
  expect(text).toContain("resource Plan");
  cut("Daily", "Build", "runs");
  project = projectFor(text);
  analysis = inspect(project);
  expect(edge(project, analysis, "Daily", "Build", "runs")).toBe(false);
  expect(analysis.diagnostics.some((item) => item.code === "E-SRC-002")).toBe(true);
  expect(text).toContain("source Daily");
  expect(text).toContain("function Build");
});

it("rejects a wire that leaves the file or the language", () => {
  const node = { kind: "SOURCE_DECL", start: 0, end: 0, children: [] };
  const source: WireEnd = { kind: "source", name: "Daily", path: "a.forge", node };
  const other: WireEnd = { kind: "function", name: "Build", path: "b.forge", node };
  expect(() => snapWire("source Daily {}\n", source, other)).toThrow(/same file/);
  expect(() =>
    snapWire("workflow Flow {}\n", { ...source, kind: "workflow", path: "a.forge" }, { ...other, path: "a.forge" }),
  ).toThrow(/Snap a source to a function/);
});
