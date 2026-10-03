import type { DomainIR, WorkflowStep } from "@forgegraph/runtime";
import type { Analysis, Project, SyntaxNode } from "./language.js";
import { appDeclarations, type Declaration } from "./app-model.js";
import { children, textOf } from "./model.js";

const kinds = {
  RESOURCE_DECL: "resource",
  FUNCTION_DECL: "function",
  SOURCE_DECL: "source",
  WORKFLOW_DECL: "workflow",
  CHANNEL_DECL: "channel",
} as const;

export type NodeKind = (typeof kinds)[keyof typeof kinds];

export interface CanvasNode {
  id: string;
  name: string;
  kind: NodeKind;
  path: string;
  module: string;
  cron: string | null;
}

export interface GraphNode extends CanvasNode {
  entry: Declaration;
}

export interface GraphEdge {
  from: string;
  to: string;
  label: string;
}

const order: NodeKind[] = ["source", "function", "workflow", "channel", "resource"];

function qualified(source: string, node: SyntaxNode): string {
  const name = children(node, "QUALIFIED_NAME")[0];
  return name ? textOf(source, name).trim() : "";
}

function cronOf(source: string, node: SyntaxNode): string | null {
  const decl = children(node, "CRON_DECL")[0];
  if (!decl) return null;
  const raw = textOf(source, decl).replace(/^cron\s+/, "").trim();
  try {
    const value = JSON.parse(raw);
    return typeof value === "string" ? value : null;
  } catch {
    return null;
  }
}

function walk(node: SyntaxNode, visit: (node: SyntaxNode) => void) {
  visit(node);
  for (const child of node.children) if (!child.token) walk(child, visit);
}

/** Runnable declarations and the wires the source already declares. */
export function playgroundGraph(
  project: Project,
  analysis: Analysis,
): { nodes: GraphNode[]; edges: GraphEdge[] } {
  const nodes = appDeclarations(project, analysis)
    .flatMap((entry): GraphNode[] => {
      const kind = kinds[entry.node.kind as keyof typeof kinds];
      if (!kind) return [];
      return [
        {
          id: entry.id,
          name: entry.name,
          kind,
          path: entry.path,
          module: entry.module,
          cron: entry.node.kind === "SOURCE_DECL" ? cronOf(entry.source, entry.node) : null,
          entry,
        },
      ];
    })
    .sort(
      (a, b) => order.indexOf(a.kind) - order.indexOf(b.kind) || a.name.localeCompare(b.name),
    );
  const edges: GraphEdge[] = [];
  const link = (from: GraphNode, raw: string, label: string, kind?: NodeKind) => {
    const trimmed = raw.trim();
    const short = trimmed.split(".").at(-1) ?? trimmed;
    const candidates = nodes.filter(
      (node) =>
        (!kind || node.kind === kind) && (node.name === trimmed || node.name === short),
    );
    const to = candidates.find((node) => node.module === from.module) ?? candidates[0];
    if (!to || to.id === from.id) return;
    if (edges.some((edge) => edge.from === from.id && edge.to === to.id && edge.label === label))
      return;
    edges.push({ from: from.id, to: to.id, label });
  };
  for (const node of nodes) {
    const source = node.entry.source;
    const syntax = node.entry.node;
    if (node.kind === "source") {
      const target = children(syntax, "TARGET_DECL")[0];
      if (target) link(node, qualified(source, target), "runs", "function");
    }
    walk(syntax, (child) => {
      if (child.kind === "USE_DECL") {
        const name = qualified(source, child);
        if (name) link(node, name, "uses", "resource");
      } else if (child.kind === "SEND_DECL") {
        const channel = qualified(source, child);
        if (channel) link(node, channel, "sends", "channel");
      } else if (child.kind === "STEP_CALL") {
        const callee = qualified(source, child);
        if (callee) link(node, callee, "calls", "function");
      }
    });
  }
  for (const entry of appDeclarations(project, analysis)) {
    if (entry.node.kind !== "SUBSCRIPTION_DECL") continue;
    const names = children(entry.node, "QUALIFIED_NAME");
    const channel = names[0] ? (textOf(entry.source, names[0]).split(".")[0] ?? "") : "";
    const handler = names[1] ? textOf(entry.source, names[1]).trim() : "";
    const from = nodes.find(
      (node) => node.kind === "channel" && (node.name === channel || node.name.endsWith(`.${channel}`)),
    );
    const to = nodes.find(
      (node) =>
        node.kind === "function" &&
        (node.name === handler || node.name === handler.split(".").at(-1)),
    );
    if (from && to)
      edges.push({ from: from.id, to: to.id, label: "on" });
  }
  return { nodes, edges };
}

export function hasCompilerErrors(analysis: Analysis | null): boolean {
  return (
    !analysis ||
    Boolean(analysis.error) ||
    analysis.diagnostics.some((diagnostic) => diagnostic.severity === "error")
  );
}

export function canFire(analysis: Analysis | null, node: CanvasNode | null): boolean {
  return Boolean(node && node.kind === "source" && node.cron) && !hasCompilerErrors(analysis);
}

export function place(index: number) {
  return { x: 28 + (index % 2) * 300, y: 28 + Math.floor(index / 2) * 124 };
}

export function positionFor(
  node: { path: string; name: string },
  index: number,
  positions: { path: string; name: string; x: number; y: number }[],
) {
  const saved = positions.find((item) => item.path === node.path && item.name === node.name);
  if (saved && Number.isFinite(saved.x) && Number.isFinite(saved.y)) return { x: saved.x, y: saved.y };
  return place(index);
}

function remember(edges: GraphEdge[], from: string, to: string, label: string) {
  if (!to || from === to) return;
  if (edges.some((edge) => edge.from === from && edge.to === to && edge.label === label)) return;
  edges.push({ from, to, label });
}

function byRef(nodes: CanvasNode[], ref: string, kind: NodeKind) {
  const short = ref.split("/").at(-1) ?? ref;
  const matches = nodes.filter(
    (node) =>
      node.kind === kind &&
      (node.id === ref || node.name === ref || node.name === short || node.id.endsWith(`/${short}`)),
  );
  return matches.find((node) => node.id === ref) ?? matches[0];
}

function walkSteps(steps: WorkflowStep[], visit: (target: string) => void) {
  for (const step of steps) {
    if (step.kind === "call" && step.target.kind === "function") visit(step.target.function);
    else if (step.kind === "map") walkSteps([step.call], visit);
    else if (step.kind === "choice") {
      walkSteps(step.then, visit);
      walkSteps(step.otherwise, visit);
    } else if (step.kind === "parallel") {
      for (const branch of step.branches) walkSteps(branch, visit);
    }
  }
}

/** Read-only graph of a compiled contract. Declarations come from Domain IR, not syntax trees. */
export function contractGraph(ir: DomainIR): { nodes: CanvasNode[]; edges: GraphEdge[] } {
  const nodes: CanvasNode[] = [];
  for (const module of ir.modules ?? []) {
    const path = module.id;
    for (const resource of module.resources ?? []) {
      nodes.push({ id: resource.id, name: resource.name, kind: "resource", path, module: path, cron: null });
    }
    for (const fn of module.functions ?? []) {
      nodes.push({ id: fn.id, name: fn.name, kind: "function", path, module: path, cron: null });
    }
    for (const source of module.sources ?? []) {
      nodes.push({
        id: source.id,
        name: source.name,
        kind: "source",
        path,
        module: path,
        cron: source.cron ?? null,
      });
    }
    for (const workflow of module.workflows ?? []) {
      nodes.push({ id: workflow.id, name: workflow.name, kind: "workflow", path, module: path, cron: null });
    }
    for (const channel of module.channels ?? []) {
      nodes.push({ id: channel.id, name: channel.name, kind: "channel", path, module: path, cron: null });
    }
  }
  nodes.sort(
    (a, b) => order.indexOf(a.kind) - order.indexOf(b.kind) || a.name.localeCompare(b.name) || a.id.localeCompare(b.id),
  );
  const edges: GraphEdge[] = [];
  for (const module of ir.modules ?? []) {
    for (const source of module.sources ?? []) {
      const from = nodes.find((node) => node.id === source.id);
      const to = from ? byRef(nodes, source.target, "function") : undefined;
      if (from && to) remember(edges, from.id, to.id, "runs");
    }
    for (const fn of module.functions ?? []) {
      const from = nodes.find((node) => node.id === fn.id);
      if (!from) continue;
      for (const use of fn.uses ?? []) {
        if (use.kind === "resource") {
          const to = byRef(nodes, use.resource, "resource");
          if (to) remember(edges, from.id, to.id, "uses");
        } else if (use.kind === "function") {
          const to = byRef(nodes, use.function, "function");
          if (to) remember(edges, from.id, to.id, "calls");
        }
      }
      for (const send of fn.sends ?? []) {
        const to = byRef(nodes, send.channel, "channel");
        if (to) remember(edges, from.id, to.id, "sends");
      }
    }
    for (const workflow of module.workflows ?? []) {
      const from = nodes.find((node) => node.id === workflow.id);
      if (!from) continue;
      walkSteps(workflow.steps ?? [], (target) => {
        const to = byRef(nodes, target, "function");
        if (to) remember(edges, from.id, to.id, "calls");
      });
    }
    const subscriptions =
      (module as { subscriptions?: { channel: string; handler: string }[] }).subscriptions ?? [];
    for (const subscription of subscriptions) {
      const from = byRef(nodes, subscription.channel, "channel");
      const to = byRef(nodes, subscription.handler, "function");
      if (from && to) remember(edges, from.id, to.id, "on");
    }
  }
  return { nodes, edges };
}
