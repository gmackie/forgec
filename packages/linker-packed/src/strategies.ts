// Grouping strategies decide which entry points share a Worker script. A strategy only proposes
// groups; the linker then applies the platform's placement rules, which no strategy can override.
// To add a strategy, implement `GroupingStrategy` and register it in `STRATEGIES`.
import { createHash } from "node:crypto";
import type { Manifest, ManifestEntryPoint } from "./manifest.ts";

/**
 * Runtime surfaces outside the manifest (`uncovered`, changesets, imports, admin, objects, metadata,
 * socket upgrades). Grouped like any entry point; it serves every request no other group claims.
 */
export const RESIDUAL = { kind: "residual" as const, id: "forge:residual" };
export type Member = ManifestEntryPoint | typeof RESIDUAL;

export interface GroupingStrategy {
  name: string;
  description: string;
  /** Partition the members (manifest entry points plus RESIDUAL) into groups of member ids. */
  group(members: Member[], manifest: Manifest): string[][];
}

export const perEntryPoint: GroupingStrategy = {
  name: "per-entry-point",
  description: "One script per entry point (route, queue consumer, cron, workflow class, realtime object) and one for the residual runtime surfaces.",
  group: (members) => members.map((m) => [m.id]),
};

export const single: GroupingStrategy = {
  name: "single",
  description: "Baseline: every entry point and the residual surfaces in one script, i.e. the whole-app Worker rebuilt from the manifest.",
  group: (members) => [members.map((m) => m.id)],
};

export const STRATEGIES: Record<string, GroupingStrategy> = { [perEntryPoint.name]: perEntryPoint, [single.name]: single };

/**
 * Cloudflare placement rules. A workflow step runs inside its workflow's `WorkflowEntrypoint.run`,
 * so it cannot be a script of its own: steps join the group of their workflow class.
 */
export function applyPlatformRules(groups: string[][], members: Member[]): string[][] {
  const byId = new Map(members.map((m) => [m.id, m]));
  const home = new Map<string, number>();
  groups.forEach((g, i) => g.forEach((id) => home.set(id, i)));
  const moved = groups.map((g) => [...g]);
  for (const m of members) {
    if (m.kind !== "workflow-step") continue;
    const wf = (m.trigger as { workflow: string }).workflow;
    const target = home.get(wf);
    if (target === undefined || !byId.has(wf)) continue;
    const from = home.get(m.id)!;
    if (from === target) continue;
    moved[from] = moved[from]!.filter((x) => x !== m.id);
    moved[target]!.push(m.id);
    home.set(m.id, target);
  }
  return moved.filter((g) => g.length).map((g) => g.sort());
}

/** Cloudflare script name: lowercase, [a-z0-9-], at most 63 characters, stable for a group's members. */
export function scriptName(pkg: string, strategy: string, members: string[]): string {
  const base = pkg.replace(/^@/, "").replace(/[^a-z0-9]+/gi, "-").toLowerCase();
  const tag = createHash("sha256").update(members.join("\n")).digest("hex").slice(0, 6);
  if (strategy === "single") return `${base}-all`.slice(0, 63);
  const first = members.length === 1 ? members[0]! : members.find((m) => !m.includes("#")) ?? members[0]!;
  const slug = first.replace(/^.*\/_\//, "").replace(/[{}]/g, "").replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "").toLowerCase();
  return `${base}-${slug}`.slice(0, 63 - 7).replace(/-$/, "") + `-${tag}`;
}
