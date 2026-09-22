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
export interface ExecutionArtifact {
  modules: { functions: { id: string; generated?: boolean; uses: {kind: string; function?: string; resource?: string}[] }[]; resources: {id: string}[] }[];
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
  const explanations:Record<string,string[]>={};
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
