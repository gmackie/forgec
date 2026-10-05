import { expect,it } from "vitest";
import { resolve } from "node:path";
import { Engine } from "../src/engine.js";
import { localAuthorizer } from "../src/gatekeeper.js";
import { foundation,foundationAdapters } from "./helpers/foundation.js";
import { assessChangeset,type AssessmentInput,type ForgeGraphFunctions } from "../../../examples/foundation/apps/forgegraph/adapter.js";
const root=process.env.FORGE_FOUNDATION_FORGEGRAPH_ROOT;
if(!root)throw new Error("FORGE_FOUNDATION_FORGEGRAPH_ROOT must name the pinned real ForgeGraph checkout");
const fold=await import(resolve(root,"packages/check-events/src/fold.ts"));
const eligibility=await import(resolve(root,"packages/api/src/automerge/eligibility.ts"));
const source:ForgeGraphFunctions={summarizeChecks:fold.summarizeChecks,isEligibleForAutoMerge:eligibility.isEligibleForAutoMerge};
process.env.FORGE_FOUNDATION_FIXTURE=process.env.FORGE_FOUNDATION_FORGEGRAPH_BUNDLE??resolve(import.meta.dirname,"../../../examples/foundation/apps/forgegraph/generated");
for(const provider of foundationAdapters)it(`${provider}: real ForgeGraph CI fold and changeset policy drive a pinned assessment`,async()=>{
 const f=await foundation("forgegraph",provider);try{
  const sp="@forgegraph/foundation/specification/_/",ep="@forgegraph/foundation/evaluation/_/";
  const repository=await f.call(sp+"Repository.create",{key:"app",provider:"git",locator:"https://example.test/app"});
  const definition=await f.call(sp+"SpecificationPin.create",{repository:repository.id,anchor:"HEAD",revision:"a".repeat(40)});
  const set=await f.call(ep+"EvaluationSet.create",{label:"Changeset assessments"}),executor=await f.call(ep+"EvaluationExecutor.create",{key:"gate",label:"ForgeGraph exact checks"});
  const input:AssessmentInput={repositoryId:"repo-1",changesetId:"change-1",buildId:"build-1",headSHA:"a".repeat(40),definition:String(definition.id),evaluationSet:String(set.id),executor:String(executor.id),changeset:{id:"change-1",status:"open",parentChangesetId:null},policy:{autoMerge:true,requiredChecks:["test","typecheck"]},events:["test","typecheck"].map(phase=>({v:2,phase:phase as "test"|"typecheck",event:"run_finished",at:"2026-01-01T12:00:00Z",status:"passed",exitCode:0,confidence:"exact"}))};
  let tick=Date.parse("2026-01-02T00:00:00Z");const now=()=>new Date(tick+=1000).toISOString(),head=async()=>input.headSHA;
  const approved=await assessChangeset(f.engine,source,input,f.ctx,head,now);expect(approved.eligible).toBe(true);
  expect(await assessChangeset(f.engine,source,input,f.ctx,head,now)).toEqual(approved);
  await expect(assessChangeset(f.engine,source,{...input,events:[]},f.ctx,head,now)).rejects.toMatchObject({code:"IdempotencyMismatch"});
  for(const [buildId,events] of [["missing",[]],["skipped",input.events.map(e=>({...e,status:"skipped" as const}))],["scraped",input.events.map(e=>({...e,confidence:"scraped" as const}))],["failed",input.events.map(e=>({...e,status:"failed" as const,exitCode:1}))]] as const){
   expect((await assessChangeset(f.engine,source,{...input,buildId,events:[...events]},f.ctx,head,now)).eligible).toBe(false);
  }
  expect((await assessChangeset(f.engine,source,{...input,buildId:"parent",changeset:{...input.changeset,parentChangesetId:"parent"},parentStatus:"open"},f.ctx,head,now)).eligible).toBe(false);
  expect((await assessChangeset(f.engine,source,{...input,buildId:"reopened",events:[...input.events,{v:2,phase:"test",event:"run_started",at:"2026-01-01T12:00:01Z"}]},f.ctx,head,now)).eligible).toBe(false);
  expect((await assessChangeset(f.engine,source,{...input,buildId:"contradictory-test",events:[...input.events,{v:2,phase:"test",event:"test_finished",at:"2026-01-01T12:00:01Z",test:{name:"broken",status:"failed",duration:1}}]},f.ctx,head,now)).eligible).toBe(false);
  await expect(assessChangeset(f.engine,source,{...input,buildId:"future-event",events:input.events.map(e=>({...e,at:"2099-01-01T00:00:00Z"}))},f.ctx,head,now)).rejects.toThrow("not historical");
  const guarded=new Engine(f.engine.model,f.engine.layer);
  guarded.gatekeeper.authorizer=localAuthorizer({policies:f.engine.model.resources.map(r=>({id:r.id,actions:[r.id+(r.id==="@foundation-app/forgegraph/_/ChangesetAssessmentResult"?".get":".*")],requires:[],where:[]})),pips:[],epoch:1,knownObligations:[]});
  const interrupted={...input,buildId:"interrupted-result"};
  await expect(assessChangeset(guarded,source,interrupted,f.ctx,head,now)).rejects.toThrow();
  expect((await assessChangeset(f.engine,source,interrupted,f.ctx,head,now)).eligible).toBe(true);
  let read=0;
  expect((await assessChangeset(f.engine,source,{...input,buildId:"head-race"},f.ctx,async()=>++read===1?input.headSHA:"b".repeat(40),now)).eligible).toBe(false);
  await expect(assessChangeset(f.engine,source,input,f.ctx,async()=>"b".repeat(40),now)).rejects.toThrow("drifted");
  await expect(assessChangeset(f.engine,source,input,{...f.ctx,tenant:"other"},head,now)).rejects.toThrow();
 }finally{await f.close();}
});
