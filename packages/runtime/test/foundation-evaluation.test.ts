import { Effect } from "effect";
import { it, expect } from "vitest";
import { Evaluations } from "../src/foundation/evaluation.js";
import { localAuthorizer } from "../src/gatekeeper.js";
import { foundation, foundationAdapters } from "./helpers/foundation.js";
const p='@forgegraph/foundation/evaluation/_/',s='@forgegraph/foundation/specification/_/',e='@forgegraph/foundation/evidence/_/',d='@fixture/evaluation-consumer/_/';
for(const adapter of foundationAdapters) {
 it(`${adapter}: definition pins, operational phases and four independent domain verdicts`,async()=>{
  const f=await foundation('evaluation',adapter,true),{call,ctx,engine}=f;
  try {
   const repository=await call(s+'Repository.create',{key:'eval-definitions',provider:'git',locator:'https://example.test/defs'});
   const pin=await call(s+'SpecificationPin.create',{repository:repository.id,anchor:'inspection',revision:'a'.repeat(40)});
   const group=await call(p+'EvaluationSet.create',{label:'candidate set'});
   const executor=await call(p+'EvaluationExecutor.create',{key:'runner',label:'Runner revision 1'});
   const api=new Evaluations(engine),run=await Effect.runPromise(api.create({evaluationSet:String(group.id),definition:String(pin.id),executor:String(executor.id)},ctx));
   expect(await Effect.runPromise(api.phase(String(run.id),ctx))).toBe('Planned');
   await expect(Effect.runPromise(api.finish(String(run.id),'Completed','2026-01-01T01:00:00Z','no execution',ctx))).rejects.toThrow();
   await Effect.runPromise(api.start(String(run.id),'2026-01-01T00:00:00Z',ctx));
   expect(await Effect.runPromise(api.phase(String(run.id),ctx))).toBe('Running');
   for(const [type,payload] of [
    ['ChangeVerification',{commit:'b'.repeat(40),testsPassed:8,testsFailed:1}],
    ['LevelEvaluation',{candidate:'level-7',reachable:true,difficulty:'0.700'}],
    ['LanguageModelEvaluation',{modelRevision:'model-v1',datasetRevision:'dataset-v2',accuracy:'0.800'}],
    ['Inspection',{lot:'L1',diameter:'12.300',unit:'mm',acceptable:false}],
   ] as const) expect(await call(d+type+'.create',{run:run.id,...payload})).toMatchObject({run:run.id});
   const bundle=await call(e+'EvidenceBundle.create',{key:'support',label:'Support'});
   const seal=await call(e+'EvidenceSeal.create',{bundle:bundle.id,head:null,recordedBy:ctx.actor});
   await expect(Effect.runPromise(api.finish(String(run.id),'Completed','2025-12-31T00:00:00Z','wrong chronology',ctx))).rejects.toThrow();
   const finish=await Effect.runPromise(api.finish(String(run.id),'Completed','2026-01-01T01:00:00Z','evaluation executed; domain verdict is unacceptable',ctx,String(seal.id)));
   expect(finish.support).toBe(seal.id);
   expect(await Effect.runPromise(api.phase(String(run.id),ctx))).toBe('Completed');
   await call(s+'SpecificationPin.create',{repository:repository.id,anchor:'inspection',revision:'c'.repeat(40)});
   expect((await call(p+'EvaluationRun.get',{id:run.id})).definition).toBe(pin.id);
   for(const [type,id] of [['EvaluationRun',run.id],['EvaluationFinish',finish.id]]) {
    for(const operation of ['update','delete']) await expect(call(p+type+'.'+operation,{id,patch:{definition:pin.id}})).rejects.toThrow();
   }
   const child=await Effect.runPromise(api.create({evaluationSet:String(group.id),definition:String(pin.id),executor:String(executor.id),parent:String(run.id)},ctx));
   expect(child.depth).toBe(2);
   await expect(call(p+'EvaluationRun.create',{evaluationSet:group.id,definition:pin.id,executor:executor.id,parent:child.id,depth:1})).rejects.toThrow();
   await expect(call(p+'EvaluationRun.get',{id:run.id},{...ctx,tenant:'other'})).rejects.toThrow();
   engine.gatekeeper.authorizer=localAuthorizer({policies:[],pips:[],epoch:1,knownObligations:[]});
   await expect(Effect.runPromise(api.phase(String(run.id),ctx))).rejects.toMatchObject({code:'NotFound'});
  }finally{await f.close();}
 });
 it(`${adapter}: competing terminal outcomes, idempotent retries and cancellation dominate late starts`,async()=>{
  const f=await foundation('evaluation',adapter,true),{call,ctx,engine}=f;
  try {
   const repository=await call(s+'Repository.create',{key:'defs',provider:'git',locator:'https://example.test/defs'});
   const pin=await call(s+'SpecificationPin.create',{repository:repository.id,anchor:'test',revision:'a'.repeat(40)});
   const group=await call(p+'EvaluationSet.create',{label:'Runs'}),executor=await call(p+'EvaluationExecutor.create',{key:'ci',label:'CI'});
   const api=new Evaluations(engine),input={evaluationSet:String(group.id),definition:String(pin.id),executor:String(executor.id)};
   const run=await Effect.runPromise(api.create(input,ctx));
   const start=await Effect.runPromise(api.start(String(run.id),'2026-01-01T00:00:00Z',{...ctx,idempotencyKey:'start'}));
   expect(await Effect.runPromise(api.start(String(run.id),'2026-01-01T00:00:00Z',{...ctx,idempotencyKey:'start'}))).toEqual(start);
   const outcomes=await Promise.allSettled(['Completed','Failed'].map(outcome=>Effect.runPromise(api.finish(String(run.id),outcome as 'Completed'|'Failed','2026-01-01T01:00:00Z','done',ctx))));
   expect(outcomes.filter(x=>x.status==='fulfilled')).toHaveLength(1);
   const cancelled=await Effect.runPromise(api.create(input,ctx));
   await Effect.runPromise(api.finish(String(cancelled.id),'Cancelled','2026-01-01T01:00:00Z','withdrawn',ctx));
   await expect(Effect.runPromise(api.start(String(cancelled.id),'2026-01-01T02:00:00Z',ctx))).rejects.toThrow();
   // Direct late start/racing intent is subordinate to the immutable terminal fact.
   await call(p+'EvaluationStart.create',{run:cancelled.id,startedAt:'2026-01-01T02:00:00Z',recordedBy:ctx.actor});
   expect(await Effect.runPromise(api.phase(String(cancelled.id),ctx))).toBe('Cancelled');
   engine.gatekeeper.authorizer=localAuthorizer({policies:[{id:'except-terminal',actions:[p+'EvaluationRun.*',p+'EvaluationStart.*'],requires:[],where:[]}],pips:[],epoch:1,knownObligations:[]});
   await expect(Effect.runPromise(api.phase(String(cancelled.id),ctx))).rejects.toMatchObject({code:'NotFound'});
  }finally{await f.close();}
 });
}

for(const adapter of foundationAdapters)it(`${adapter}: quarantined migration history stays inspectable but never authorizes new results`,async()=>{
 const f=await foundation('evaluation',adapter,true),{call,ctx,engine}=f,run=Effect.runPromise;
 try{
  const repository=await call(s+'Repository.create',{key:'legacy',provider:'git',locator:'https://example.test/legacy'});
  const pin=await call(s+'SpecificationPin.create',{repository:repository.id,anchor:'assessment',revision:'a'.repeat(40)});
  const group=await call(p+'EvaluationSet.create',{label:'Migration history'}),executor=await call(p+'EvaluationExecutor.create',{key:'assessor',label:'Assessor'}),api=new Evaluations(engine);
  const input={evaluationSet:String(group.id),definition:String(pin.id),executor:String(executor.id)};
  const legacy=await run(api.create(input,ctx));
  await run(api.start(String(legacy.id),'2026-01-01T00:00:00Z',ctx));
  const finish=await run(api.finish(String(legacy.id),'Completed','2026-01-01T01:00:00Z','Historical outcome',ctx));
  expect((await run(api.result(String(finish.id),ctx))).id).toBe(finish.id);
  const quarantine=await call(p+'EvaluationQuarantine.create',{run:legacy.id,sourceDigest:'a'.repeat(64),reason:'Legacy export cannot prove binding before execution',recordedBy:ctx.actor});
  expect(await run(api.phase(String(legacy.id),ctx))).toBe('Completed');
  expect((await call(p+'EvaluationFinish.get',{id:finish.id})).id).toBe(finish.id);
  await expect(run(api.result(String(finish.id),ctx))).rejects.toMatchObject({code:'ValidationFailed'});
  await expect(run(api.start(String(legacy.id),'2026-01-02T00:00:00Z',ctx))).rejects.toThrow();
  await expect(call(p+'EvaluationQuarantine.delete',{id:quarantine.id})).rejects.toThrow();
  const fresh=await run(api.create(input,ctx));await run(api.start(String(fresh.id),'2026-01-01T00:00:00Z',ctx));
  const freshFinish=await run(api.finish(String(fresh.id),'Completed','2026-01-01T01:00:00Z','Fresh execution',ctx));
  expect((await run(api.result(String(freshFinish.id),ctx))).id).toBe(freshFinish.id);
  engine.gatekeeper.authorizer=localAuthorizer({policies:engine.model.resources.filter(r=>r.id!==p+'EvaluationQuarantine').map(r=>({id:r.id,actions:[r.id+'.*'],requires:[],where:[]})),pips:[],epoch:1,knownObligations:[]});
  await expect(run(api.result(String(finish.id),ctx))).rejects.toThrow();
 }finally{await f.close();}
});
