import { Effect } from "../app-runtime.js";
import type { Engine, CallContext } from "../../engine.js";
import { Evaluations } from "../evaluation.js";
import { findTerminalFact } from "../facts.js";

/** Structural subset of LevelForge's actual ArtifactProductionJobStore port.
 * The caller retains its full job shape; Foundation never stores its opaque payload. */
export interface ProductionJob {
  jobId: string; revision: number; graph: { graphId: string }; status: string;
  provenance: { sourceRevision?: string };
  executors: { id: string; version: string }[];
  events: { type: string; at: string }[];
}
export interface ProductionStore<J extends ProductionJob> {
  create(job: J): Promise<J>; load(jobId: string): Promise<J | undefined>;
  save(job: J, expectedRevision: number): Promise<J>; list(): Promise<J[]>;
}
const p="@foundation-app/levelforge/_/", e="@forgegraph/foundation/evaluation/_/";
/** Opt-in decoration at the real recipe runtime's awaited persistence seam.
 * Load reconciles a durable app write whose Foundation mirror was interrupted. */
export function withFoundationProduction<J extends ProductionJob>(store: ProductionStore<J>, engine: Engine,
  binding: { projectId: string; definition: string; evaluationSet: string; executor: string }, ctx: CallContext): ProductionStore<J> {
  const evaluations=new Evaluations(engine), run=Effect.runPromise;
  async function validate(job:J):Promise<void> {
    const definition=await run(engine.call("@forgegraph/foundation/specification/_/SpecificationPin.get",{id:binding.definition},ctx));
    if(!job.provenance.sourceRevision||job.provenance.sourceRevision!==definition.revision)throw new Error("Production source revision differs from the exact definition pin");
    if(!job.executors.length||job.executors.length>128||job.executors.some(x=>!x.version||x.version==="unavailable"))throw new Error("Production requires available versioned executors");
  }
  async function mirror(job:J,allowPlan=false):Promise<J> {
    await validate(job);
    const starts=job.events.filter(x=>x.type==="job.started"||x.type==="job.resumed");
    const attempt=Math.max(1,starts.length);
    if(attempt>64)throw new Error("Production attempts exceed bounded evaluation ancestry");
    if(!allowPlan)await run(engine.call(p+"ProductionAttempt.find.byProjectIdJobIdAttempt",{params:{projectId:binding.projectId,jobId:job.jobId,attempt}},ctx));
    const key=`levelforge:${binding.projectId}:${job.jobId}:${attempt}`;
    const context=(stage:string)=>({...ctx,idempotencyKey:key+":"+stage});
    let parent:string|undefined;
    if(attempt>1){const previous=await run(engine.call(p+"ProductionAttempt.find.byProjectIdJobIdAttempt",{params:{projectId:binding.projectId,jobId:job.jobId,attempt:attempt-1}},ctx));parent=String(previous.run);}
    const execution=await run(evaluations.create({evaluationSet:binding.evaluationSet,definition:binding.definition,executor:binding.executor,...(parent?{parent}:{})},context("run")));
    const link=await run(engine.call(p+"ProductionAttempt.create",{projectId:binding.projectId,jobId:job.jobId,attempt,graphId:job.graph.graphId,sourceRevision:job.provenance.sourceRevision,definition:binding.definition,run:execution.id},context("attempt")));
    for(const [ordinal,executor] of job.executors.entries())await run(engine.call(p+"ProductionExecutor.create",{attempt:link.id,ordinal,executorId:executor.id,executorVersion:executor.version},context("executor:"+ordinal)));
    const started=starts.at(-1);
    const finish=await run(findTerminalFact(engine,e+"EvaluationFinish","run",execution.id,ctx));
    if(started&&!finish)await run(evaluations.start(String(execution.id),started.at,context("start")));
    const last=job.events.filter(x=>x.type.startsWith("job.")).at(-1);
    const outcome=last?.type==="job.completed"?"Completed":last?.type==="job.failed"?"Failed":last?.type==="job.cancelled"?"Cancelled":null;
    if(outcome&&last){
      if(finish){if(finish.outcome!==outcome||finish.finishedAt!==new Date(last.at).toISOString())throw new Error("Production terminal changed after durable completion");}
      else await run(evaluations.finish(String(execution.id),outcome,last.at,last.type,context("finish")));
    }
    return job;
  }
  return {
    create:async job=>{await validate(job);if(job.status!=="pending"||job.events.some(x=>x.type!=="job.created"))throw new Error("New production must bind before execution");return mirror(await store.create(job),true);},
    save:async(job,revision)=>{
      await validate(job);
      const previous=await store.load(job.jobId);
      if(!previous||previous.graph.graphId!==job.graph.graphId||previous.provenance.sourceRevision!==job.provenance.sourceRevision||JSON.stringify(previous.executors)!==JSON.stringify(job.executors))throw new Error("Production immutable input changed");
      return mirror(await store.save(job,revision),job.status==="running"&&["job.started","job.resumed"].includes(job.events.at(-1)?.type??""));
    },
    load:async id=>{const job=await store.load(id);return job?mirror(job,job.status==="pending"):undefined;},
    list:()=>store.list(),
  };
}
