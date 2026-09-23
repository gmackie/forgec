import { expect,it } from "vitest";
import { deriveExecutionRequirements,executionCompatibility,executionDigest,pinExecutionManifest,runnerEligibility,type ExecutionArtifact } from "../src/execution.js";
const manifest=(id:string,requires:string[],kind:"provider"|"implementation"="implementation")=>pinExecutionManifest({version:"execution-manifest/1",id,requires,kind});
const browser=manifest("playwright",["browser.playwright","browser.chromium"]);
const agent=manifest("agent",["tool.jj","tool.codex","filesystem.writable"]);
const linux=manifest("linux",["os.linux"],"provider");
const build=manifest("build",["tool.forgec"]);
const artifact:ExecutionArtifact={modules:[{resources:[],functions:[{id:"Verify",uses:[{kind:"function",function:"Browser"}]},{id:"Browser",uses:[]},{id:"Agent",uses:[{kind:"function",function:"Browser"}]}]}]};
const input={artifact,artifactDigest:executionDigest(artifact),operation:"Verify",profile:{id:"ci",bindings:{Verify:build.digest,Browser:browser.digest,Agent:agent.digest},providers:[linux.digest]},manifests:[browser,agent,linux,build]};
it("derives Forge verification and Bob agent requirements with provenance",()=>{
 const verification=deriveExecutionRequirements(input);
 expect(verification.requirements).toEqual(["browser.chromium","browser.playwright","os.linux","tool.forgec"]);
 expect(verification.explanations["browser.chromium"]?.[0]).toContain("operation:Browser -> playwright@");
 expect(deriveExecutionRequirements({...input,operation:"Agent"}).requirements).toEqual(["browser.chromium","browser.playwright","filesystem.writable","os.linux","tool.codex","tool.jj"]);
 expect(runnerEligibility(verification,["os.linux","tool.forgec"]).missing).toEqual(["browser.chromium","browser.playwright"]);
 expect(runnerEligibility(verification,verification.requirements).eligible).toBe(true);
});
it("is deterministic under manifest/atom ordering and records explicit reasons",()=>{
 expect(deriveExecutionRequirements({...input,manifests:[...input.manifests].reverse()})).toEqual(deriveExecutionRequirements(input));
 expect(manifest("playwright",["browser.chromium","browser.playwright","browser.chromium"]).digest).toBe(browser.digest);
 const result=deriveExecutionRequirements({...input,explicit:[{atom:"tool.nix",reason:"unmodeled legacy build script"}]});
 expect(result.explanations["tool.nix"]).toEqual(["explicit:unmodeled legacy build script"]);
 expect(()=>deriveExecutionRequirements({...input,explicit:[{atom:"tool.nix",reason:""}]})).toThrow();
});
it("fails closed on missing bindings, unsupported dependencies and tampered pins",()=>{
 expect(()=>deriveExecutionRequirements({...input,artifactDigest:"bad"})).toThrow();
 expect(()=>deriveExecutionRequirements({...input,profile:{...input.profile,bindings:{}}})).toThrow();
 expect(()=>deriveExecutionRequirements({...input,manifests:[{...browser,manifest:{...browser.manifest,requires:[]}},agent,linux,build]})).toThrow();
 expect(()=>manifest("unsafe",["os.linux || os.macos"])).toThrow();
});
it("binding changes affect new snapshots while existing task requirements stay unchanged",()=>{
 const queued=deriveExecutionRequirements(input);
 const copy=structuredClone(queued);
 const nextBrowser=manifest("playwright-v2",["browser.firefox"]);
 const next=deriveExecutionRequirements({...input,profile:{...input.profile,bindings:{...input.profile.bindings,Browser:nextBrowser.digest}},manifests:[...input.manifests,nextBrowser]});
 expect(executionCompatibility(queued,next)).toMatchObject({changed:true,added:["browser.firefox"],removed:["browser.chromium","browser.playwright"]});
 expect(queued).toEqual(copy);
});

it("derives only the selected nested workflow activity and pins its graph identity", async () => {
 const {deriveWorkflowStepRequirements}=await import("../src/execution.js");
 const workflowArtifact:ExecutionArtifact=structuredClone(artifact);
 workflowArtifact.modules[0]!.workflows=[{id:"Review",version:2,graphHash:"a".repeat(64),steps:[
  {kind:"choice",id:"choice",then:[{kind:"call",id:"agent",target:{kind:"function",function:"Agent"}}],otherwise:[
   {kind:"parallel",id:"parallel",branches:[[{kind:"map",id:"verify",call:{kind:"call",id:"verify",target:{kind:"function",function:"Verify"}}}],[{kind:"sleep",id:"delay"}]]},
  ]},
 ]}];
 const source={...input,artifact:workflowArtifact,artifactDigest:executionDigest(workflowArtifact),workflow:"Review",step:"verify"};
 const result=deriveWorkflowStepRequirements(source);
 expect(result.operation).toBe("Verify");
 expect(result.requirements).toEqual(["browser.chromium","browser.playwright","os.linux","tool.forgec"]);
 expect(result.workflowStep).toEqual({workflow:"Review",step:"verify",version:2,graphHash:"a".repeat(64)});
 expect(result.explanations["browser.chromium"]).toContain(`workflow:Review#step:verify@2/${"a".repeat(64)}`);
 expect(deriveWorkflowStepRequirements({...source,step:"agent"}).requirements).toContain("tool.codex");
 const changed=structuredClone(workflowArtifact);
 changed.modules[0]!.workflows![0]!.version=3;
 changed.modules[0]!.workflows![0]!.graphHash="b".repeat(64);
 const next=deriveWorkflowStepRequirements({...source,artifact:changed,artifactDigest:executionDigest(changed)});
 expect(executionCompatibility(result,next)).toMatchObject({changed:true,added:[],removed:[]});
 expect(result.workflowStep?.version).toBe(2);
 for(const step of ["missing","delay","choice","parallel"]) expect(()=>deriveWorkflowStepRequirements({...source,step})).toThrow("function call");
 expect(()=>deriveWorkflowStepRequirements({...source,artifactDigest:"bad"})).toThrow("digest");
 expect(()=>deriveWorkflowStepRequirements({...source,workflow:"Missing"})).toThrow("exactly once");
 const duplicate=structuredClone(workflowArtifact);
 duplicate.modules[0]!.workflows![0]!.steps.push({kind:"call",id:"verify",target:{kind:"function",function:"Agent"}});
 expect(()=>deriveWorkflowStepRequirements({...source,artifact:duplicate,artifactDigest:executionDigest(duplicate)})).toThrow("ambiguous");
});

it("supports valid atoms that also name JavaScript object properties",()=>{
 const pin=manifest("object-names",["constructor"]);
 const result=deriveExecutionRequirements({...input,manifests:[...input.manifests,pin],profile:{...input.profile,bindings:{...input.profile.bindings,Verify:pin.digest}}});
 expect(result.requirements).toContain("constructor");
 expect(result.explanations["constructor"]).toHaveLength(1);
});
