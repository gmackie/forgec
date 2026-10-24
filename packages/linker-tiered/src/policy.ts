// Which closures are dynamic. A link-time policy, not a manifest field: the Closure Manifest (and so
// its manifestHash, every closureHash and the packed scripts linked from it) is the same whether an
// entry point is served packed or dynamic, and moving an entry point between tiers is a re-link of
// the router and the dynamic host only.
//
// A policy names entry points by id pattern or by closure hash. It is resolved against the manifest
// at link time into a list of entry point ids; what the dynamic host later serves for those ids may
// have other closure hashes (that is what a dynamic swap is), so a closure hash in the policy pins
// the entry points that had it when the link was made, not the bytes.
import type { Manifest, ManifestEntryPoint } from "@forgegraph/linker-packed";

/** A refusal at link time by linker C (linker A's and B's refusals keep their own types). */
export class TieredLinkError extends Error {
  readonly code: "policy" | "tier";
  constructor(code: "policy" | "tier", message: string) {
    super(`${code}: ${message}`);
    this.name = "TieredLinkError";
    this.code = code;
  }
}

export interface DynamicPolicy {
  version: "tiered-policy/1";
  dynamic: {
    /** Entry point ids or glob patterns over them: `*` matches within a path segment, `**` across segments. */
    entryPoints?: string[];
    /** Closure hashes: every entry point whose closure hashed to one of these at link time. */
    closureHashes?: string[];
  };
}

export interface ResolvedDynamic {
  id: string;
  kind: ManifestEntryPoint["kind"];
  closureHash: string;
  /** The pattern or closure hash that selected it, or `workflow:<id>` for a step that follows its workflow. */
  matchedBy: string;
}

export interface ResolvedPolicy {
  policy: DynamicPolicy;
  /** Dynamic entry points, by id. */
  entryPoints: ResolvedDynamic[];
}

/**
 * Entry point kinds the dynamic tier serves. A queue consumer, cron, Durable Object or in-process
 * subscription is invoked by the platform on the script that declares it, which is a packed script;
 * linker B serves no realtime object. Those stay packed and the policy may not name them.
 */
const DYNAMIC_KINDS = new Set(["http-route", "workflow", "workflow-step"]);

export function glob(pattern: string): RegExp {
  const re = pattern.split("**").map((part) => part.split("*").map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("[^/]*")).join(".*");
  return new RegExp(`^${re}$`);
}

/** Resolves a policy against a manifest. Refuses (TieredLinkError "policy") a selector that matches nothing or an entry point that cannot be dynamic. */
export function resolvePolicy(manifest: Manifest, policy: DynamicPolicy): ResolvedPolicy {
  if (policy.version !== "tiered-policy/1") throw new TieredLinkError("policy", `unsupported policy version ${String(policy.version)}`);
  const problems: string[] = [];
  const chosen = new Map<string, ResolvedDynamic>();
  const take = (e: ManifestEntryPoint, by: string) => {
    if (!chosen.has(e.id)) chosen.set(e.id, { id: e.id, kind: e.kind, closureHash: e.closureHash, matchedBy: by });
  };
  for (const p of policy.dynamic.entryPoints ?? []) {
    const re = glob(p);
    const hits = manifest.entryPoints.filter((e) => re.test(e.id));
    if (!hits.length) problems.push(`entry point pattern ${JSON.stringify(p)} matches no entry point`);
    hits.forEach((e) => take(e, p));
  }
  for (const h of policy.dynamic.closureHashes ?? []) {
    const hits = manifest.entryPoints.filter((e) => e.closureHash === h);
    if (!hits.length) problems.push(`closure hash ${h} is no entry point's closure`);
    // A workflow step with the same closure as a route (acme's ProcessOrder#submit and the submit
    // route) still runs where its workflow runs: a hash selects the step only through its workflow.
    hits.filter((e) => e.kind !== "workflow-step").forEach((e) => take(e, h));
  }
  for (const d of chosen.values()) {
    const e = manifest.entryPoints.find((x) => x.id === d.id)!;
    if (!DYNAMIC_KINDS.has(e.kind)) problems.push(`${e.id} is a ${e.kind}, which the platform invokes on a packed script; it cannot be dynamic`);
    else if (e.kind === "http-route" && !e.root && e.bindings.some((b) => b.type === "durable-object")) problems.push(`${e.id} is a realtime upgrade route; linker B links no realtime object`);
    else if (!e.root) problems.push(`${e.id} has no closure (a runtime surface with no unit): there is nothing to load dynamically`);
  }
  // A workflow's steps run inside its class's driver step, so they share its tier: a dynamic workflow
  // brings its steps, and a step cannot be dynamic without its workflow.
  for (const e of manifest.entryPoints) {
    if (e.kind !== "workflow-step") continue;
    const wf = (e.trigger as { workflow: string }).workflow;
    if (chosen.has(wf)) take(e, `workflow:${wf}`);
    else if (chosen.has(e.id)) problems.push(`${e.id} is a step of ${wf}, which is not dynamic; a step runs in its workflow's tier`);
  }
  if (problems.length) throw new TieredLinkError("policy", problems.join("; "));
  return { policy, entryPoints: [...chosen.values()].sort((a, b) => (a.id < b.id ? -1 : 1)) };
}
