/** Offline derivation of runner requirements. These atoms describe execution,
 * never authorization. A queued task carries this materialized snapshot. */
import { createHash } from "node:crypto";
export interface ExecutionManifest {
  version: "execution-manifest/1";
  id: string;
  kind: "implementation" | "provider";
  requires: string[];
}
export interface PinnedExecutionManifest { digest: string; manifest: ExecutionManifest }
/** Structural subset of compiled workflow IR needed for activity selection. */
export interface ExecutionWorkflowStep {
  kind: string;
  id?: string;
  target?: { kind: string; function?: string };
  call?: ExecutionWorkflowStep;
  then?: ExecutionWorkflowStep[];
  otherwise?: ExecutionWorkflowStep[];
  branches?: ExecutionWorkflowStep[][];
}
export interface ExecutionArtifact {
  modules: { functions: { id: string; generated?: boolean; uses: {kind: string; function?: string; resource?: string}[] }[]; resources: {id: string}[]; workflows?: { id: string; version: number; graphHash: string; steps: ExecutionWorkflowStep[] }[] }[];
}
export interface ExecutionProfile {
  id: string;
  /** Function/resource identity -> content digest of its selected implementation/provider. */
  bindings: Record<string, string>;
  providers: string[];
}
export interface ExecutionRequirements {
  version: "execution-requirements/1";
  artifactDigest: string;
  operation: string;
  profileDigest: string;
  requirements: string[];
  explanations: Record<string, string[]>;
  provenanceDigest: string;
  workflowStep?: { workflow: string; step: string; version: number; graphHash: string };
}
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).sort(([a],[b])=>a<b?-1:a>b?1:0).map(([k,v])=>[k,canonical(v)]));
  return value;
}
export function executionDigest(value: unknown): string {
  return createHash("sha256").update("forge:execution:"+JSON.stringify(canonical(value))).digest("hex");
}
function atoms(values: string[]): string[] {
  if (!Array.isArray(values) || values.length>256 || values.some(v=>typeof v!=="string" || !/^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/.test(v) || v.length>128)) throw Error("execution requirements must be at most 256 simple capability atoms");
  return [...new Set(values)].sort();
}
export function pinExecutionManifest(manifest: ExecutionManifest): PinnedExecutionManifest {
  if (manifest.version!=="execution-manifest/1" || !["implementation","provider"].includes(manifest.kind) || !manifest.id) throw Error("invalid execution manifest");
  const allowed=new Set(["version","id","kind","requires"]);
  if(Object.keys(manifest).some(k=>!allowed.has(k))) throw Error("unknown execution manifest field");
  const normalized={...manifest,requires:atoms(manifest.requires)};
  return {digest:executionDigest(normalized),manifest:normalized};
}
export function deriveExecutionRequirements(input: {
  artifact: ExecutionArtifact; artifactDigest: string; operation: string;
  profile: ExecutionProfile; manifests: PinnedExecutionManifest[];
  explicit?: {atom:string;reason:string}[];
}): ExecutionRequirements {
  if (executionDigest(input.artifact)!==input.artifactDigest) throw Error("artifact digest mismatch");
  const manifests=new Map<string,ExecutionManifest>();
  for (const pin of input.manifests) {
    const checked=pinExecutionManifest(pin.manifest);
    if(checked.digest!==pin.digest) throw Error("execution manifest digest mismatch");
    manifests.set(pin.digest,checked.manifest);
  }
  const explanations:Record<string,string[]>=Object.create(null);
  const add=(atom:string,source:string)=>{(explanations[atom]??=[]).push(source);};
  const useManifest=(digest:string,source:string,kind?:ExecutionManifest["kind"])=>{
    const manifest=manifests.get(digest);
    if(!manifest || kind && manifest.kind!==kind) throw Error(`missing or invalid pinned execution manifest for ${source}`);
    for(const atom of manifest.requires) add(atom,`${source} -> ${manifest.id}@${digest}`);
  };
  for(const digest of [...new Set(input.profile.providers)].sort()) useManifest(digest,`profile:${input.profile.id}`,"provider");
  const functions=new Map(input.artifact.modules.flatMap(m=>m.functions).map(f=>[f.id,f]));
  const resources=new Set(input.artifact.modules.flatMap(m=>m.resources).map(r=>r.id));
  const visited=new Set<string>();
  const visit=(id:string)=>{
    if(visited.has(id)) return;
    if(visited.size>=4096) throw Error("execution dependency graph exceeds 4096 nodes");
    visited.add(id);
    const fn=functions.get(id);
    if(!fn && !resources.has(id)) throw Error(`unknown execution dependency ${id}`);
    const binding=input.profile.bindings[id];
    if(binding) useManifest(binding,`operation:${id}`,fn?"implementation":"provider");
    else if(!fn?.generated) throw Error(`missing pinned execution binding for ${id}`);
    for(const use of fn?.uses??[]) {
      if(use.kind==="function" && use.function) visit(use.function);
      else if(use.resource) visit(use.resource);
      else throw Error(`unsupported execution dependency in ${id}`);
    }
  };
  visit(input.operation);
  for(const explicit of input.explicit??[]) {
    atoms([explicit.atom]);
    if(!explicit.reason.trim()) throw Error("explicit requirements need an explanation");
    add(explicit.atom,`explicit:${explicit.reason}`);
  }
  const sorted=Object.fromEntries(Object.keys(explanations).sort().map(k=>[k,[...new Set(explanations[k])].sort()]));
  const result={version:"execution-requirements/1" as const,artifactDigest:input.artifactDigest,operation:input.operation,profileDigest:executionDigest({...input.profile,providers:[...new Set(input.profile.providers)].sort()}),requirements:atoms(Object.keys(sorted)),explanations:sorted};
  return {...result,provenanceDigest:executionDigest(result)};
}
export function executionCompatibility(before: ExecutionRequirements,after: ExecutionRequirements) {
  return {changed:before.provenanceDigest!==after.provenanceDigest,added:after.requirements.filter(a=>!before.requirements.includes(a)),removed:before.requirements.filter(a=>!after.requirements.includes(a)),action:before.provenanceDigest===after.provenanceDigest?"none":"review-new-tasks; preserve-existing-snapshots"};
}
export function runnerEligibility(task: Pick<ExecutionRequirements,"requirements"|"explanations">,capabilities:string[]) {
  const available=new Set(atoms(capabilities));
  const missing=task.requirements.filter(a=>!available.has(a));
  return {eligible:missing.length===0,missing,explanations:structuredClone(task.explanations)};
}

/** Select a function activity from a pinned workflow without evaluating its branches.
 * The caller identifies the step actually being dispatched. Map item identities remain
 * the workflow driver's concern; every item shares this immutable execution contract. */
export function deriveWorkflowStepRequirements(input: Omit<Parameters<typeof deriveExecutionRequirements>[0], "operation"> & {
  workflow: string; step: string;
}): ExecutionRequirements {
  if (executionDigest(input.artifact) !== input.artifactDigest) throw Error("artifact digest mismatch");
  const workflows = input.artifact.modules.flatMap(module => module.workflows ?? []).filter(workflow => workflow.id === input.workflow);
  if (workflows.length !== 1) throw Error("workflow selection must resolve exactly once");
  const workflow = workflows[0]!;
  if (!Number.isSafeInteger(workflow.version) || workflow.version < 1 || !/^[a-f0-9]{64}$/.test(workflow.graphHash)) throw Error("invalid pinned workflow identity");
  const pending = [...workflow.steps];
  const ids = new Set<string>();
  let selected: ExecutionWorkflowStep | undefined;
  let count = 0;
  while (pending.length) {
    if (++count > 4096) throw Error("workflow selection graph exceeds 4096 nodes");
    const step = pending.pop()!;
    if (!["call", "map", "choice", "parallel", "wait", "sleep", "return", "fail"].includes(step.kind)) throw Error(`unsupported workflow step kind ${step.kind}`);
    if (step.id !== undefined) {
      if (ids.has(step.id)) throw Error(`ambiguous workflow step ${step.id}`);
      ids.add(step.id);
      if (step.id === input.step) selected = step;
    }
    if (step.kind === "choice") pending.push(...(step.then ?? []), ...(step.otherwise ?? []));
    if (step.kind === "parallel") for (const branch of step.branches ?? []) pending.push(...branch);
  }
  const call = selected?.kind === "map" ? selected.call : selected;
  if (selected?.kind === "map" && selected.call?.id !== selected.id) throw Error("mapped call must retain its parent step identity");
  if (call?.kind !== "call" || call.target?.kind !== "function" || !call.target.function) throw Error("workflow step must select a function call or mapped function call");
  const derived = deriveExecutionRequirements({ ...input, operation: call.target.function });
  const { provenanceDigest: _previous, ...snapshot } = derived;
  const workflowStep = { workflow: workflow.id, step: input.step, version: workflow.version, graphHash: workflow.graphHash };
  const source = `workflow:${workflow.id}#step:${input.step}@${workflow.version}/${workflow.graphHash}`;
  const result = { ...snapshot, workflowStep, explanations: Object.fromEntries(Object.entries(snapshot.explanations).map(([atom, sources]) => [atom, [...sources, source].sort()])) };
  return { ...result, provenanceDigest: executionDigest(result) };
}
