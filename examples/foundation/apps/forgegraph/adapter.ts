import { Effect } from "../../../../packages/runtime/src/foundation/app-runtime.js";
import type { Engine, CallContext } from "../../../../packages/runtime/src/engine.js";
import { sha256, stableJson } from "../../../../packages/runtime/src/engine.js";
import { Evaluations } from "../../../../packages/runtime/src/foundation/evaluation.js";
import { findTerminalFact } from "../../../../packages/runtime/src/foundation/facts.js";

export interface CheckEvent {
  v:2;phase:"typecheck"|"lint"|"test"|"e2e"|"build"|"all";
  event:"run_started"|"test_started"|"test_finished"|"output"|"run_finished"|"skipped";
  at:string;stream?:string;status?:"running"|"passed"|"failed"|"skipped";
  exitCode?:number;confidence?:"exact"|"scraped";
  test?:{name:string;status:"passed"|"failed"|"skipped"|"pending"|"other";duration:number};
}
export interface EligibilityInput {
  changeset:{id:string;parentChangesetId:string|null;status:string};
  policy:{autoMerge:boolean;requiredChecks:string[]|null};
  checks:Record<string,"pending"|"passed"|"failed">;parentStatus?:string;
}
export interface ForgeGraphFunctions {
  summarizeChecks(events:CheckEvent[]):{status:"passed"|"failed";phases:{phase:string;status:string;confidence?:string}[]};
  isEligibleForAutoMerge(input:EligibilityInput):Promise<{eligible:boolean;reason?:string}>;
}
export interface AssessmentInput {
  repositoryId:string;changesetId:string;buildId:string;headSHA:string;
  definition:string;evaluationSet:string;executor:string;
  changeset:EligibilityInput["changeset"];policy:EligibilityInput["policy"];parentStatus?:string;
  events:CheckEvent[];
}
const p="@foundation-app/forgegraph/_/",e="@forgegraph/foundation/evaluation/_/";
/** Assesses existing CI observations. This new run is not the original CI execution.
 * The real ForgeGraph folds and eligibility function are injected by its caller. */
export async function assessChangeset(engine:Engine,source:ForgeGraphFunctions,input:AssessmentInput,ctx:CallContext,
  currentHead:()=>Promise<string>,now:()=>string):Promise<{eligible:boolean;reason:string;assessment:string}> {
  const run=Effect.runPromise;
  if(input.changeset.id!==input.changesetId||await currentHead()!==input.headSHA)throw new Error("Changeset head or identity drifted before assessment");
  const definition=await run(engine.call("@forgegraph/foundation/specification/_/SpecificationPin.get",{id:input.definition},ctx));
  if(definition.revision!==input.headSHA)throw new Error("Assessment definition does not pin source head");
  const sourceDigest=await sha256(stableJson(input.events));
  const policyDigest=await sha256(stableJson({changeset:input.changeset,policy:input.policy,parentStatus:input.parentStatus??null}));
  const key=`forgegraph:${input.repositoryId}:${input.changesetId}:${input.buildId}`;
  const context=(stage:string)=>({...ctx,idempotencyKey:key+":"+stage});
  const evaluations=new Evaluations(engine);
  const execution=await run(evaluations.create({definition:input.definition,evaluationSet:input.evaluationSet,executor:input.executor},context("run")));
  const assessment=await run(engine.call(p+"ChangesetAssessment.create",{repositoryId:input.repositoryId,changesetId:input.changesetId,buildId:input.buildId,headSHA:input.headSHA,sourceDigest,policyDigest,definition:input.definition,run:execution.id},context("assessment")));
  const previous=await run(findTerminalFact(engine,p+"ChangesetAssessmentResult","assessment",assessment.id,ctx));
  if(previous){
    await run(evaluations.result(String(previous.finish),ctx));
    if(await currentHead()!==input.headSHA)throw new Error("Changeset head drifted after assessment");
    return{eligible:previous.eligible===true,reason:String(previous.reason),assessment:String(assessment.id)};
  }
  const started=await run(findTerminalFact(engine,e+"EvaluationStart","run",execution.id,ctx));
  if(!started){
    const assessedAt=now();
    if(input.events.some(event=>!Number.isFinite(Date.parse(event.at))||Date.parse(event.at)>Date.parse(assessedAt)))throw new Error("CI observation is not historical at assessment time");
    await run(evaluations.start(String(execution.id),assessedAt,context("start")));
  }
  const summary=source.summarizeChecks(input.events),required=input.policy.requiredChecks??[];
  const checks:EligibilityInput["checks"]={};
  for(const phase of required){
    const events=input.events.filter(x=>x.phase===phase),folded=summary.phases.find(x=>x.phase===phase);
    const streams=new Set(events.filter(x=>x.event==="run_started"||x.event==="run_finished").map(x=>x.stream??""));
    const exact=streams.size>0&&[...streams].every(stream=>{
      const last=events.filter(x=>(x.stream??"")===stream&&(x.event==="run_started"||x.event==="run_finished")).at(-1);
      return last?.event==="run_finished"&&last.status==="passed"&&last.exitCode===0&&last.confidence==="exact";
    });
    checks[phase]=folded?.status==="passed"&&exact&&!events.some(x=>x.event==="skipped"||x.status==="failed"||x.test?.status==="failed"||x.confidence==="scraped")?"passed":"failed";
  }
  const decision=await source.isEligibleForAutoMerge({changeset:input.changeset,policy:input.policy,checks,...(input.parentStatus?{parentStatus:input.parentStatus}:{})});
  const stillCurrent=await currentHead()===input.headSHA;
  const eligible=required.length>0&&decision.eligible&&stillCurrent;
  const reason=!stillCurrent?"Changeset head drifted during assessment":!required.length?"No required checks configured":decision.reason??(eligible?"Required exact CI checks and parent policy passed":"CI assessment failed");
  const oldFinish=await run(findTerminalFact(engine,e+"EvaluationFinish","run",execution.id,ctx));
  const outcome=eligible?"Completed":"Failed";
  if(oldFinish&&oldFinish.outcome!==outcome)throw new Error("Assessment changed after terminal execution; use a new build identity");
  const finish=oldFinish??await run(evaluations.finish(String(execution.id),outcome,now(),reason,context("finish")));
  await run(evaluations.result(String(finish.id),ctx));
  const result=await run(engine.call(p+"ChangesetAssessmentResult.create",{assessment:assessment.id,finish:finish.id,eligible,reason},context("result")));
  return{eligible:result.eligible===true,reason:String(result.reason),assessment:String(assessment.id)};
}
