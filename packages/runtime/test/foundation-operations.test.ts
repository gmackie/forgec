import {Effect} from 'effect';
import {deriveExecutionRequirements,executionDigest,pinExecutionManifest} from '@forgegraph/capability-manifest';
import {expect,it} from 'vitest';
import {foundation,foundationAdapters} from './helpers/foundation.js';
import {Operations} from '../src/foundation/operations.js';
import {Allocations} from '../src/foundation/allocation.js';
import {Usage} from '../src/foundation/usage.js';
import {Lineage} from '../src/foundation/lineage.js';
import {Fulfillments} from '../src/foundation/fulfillment.js';
import {Evaluations} from '../src/foundation/evaluation.js';
import {Evidence} from '../src/foundation/evidence.js';
import {WorkQueue} from '../src/work-queues.js';
import {Storage} from '../src/services.js';
import {localAuthorizer} from '../src/gatekeeper.js';
const p='@forgegraph/foundation/operations/_/',s='@forgegraph/foundation/specification/_/',a='@forgegraph/foundation/allocation/_/',u='@forgegraph/foundation/usage/_/',l='@forgegraph/foundation/lineage/_/',ful='@forgegraph/foundation/fulfillment/_/',e='@forgegraph/foundation/evaluation/_/';
const run=Effect.runPromise,at='2026-01-01T00:00:00Z';
for(const adapter of foundationAdapters)it(`${adapter}: operation usage replay, real task linkage, lineage and terminal cleanup races`,async()=>{
 const f=await foundation('operations',adapter,true),{call,ctx,engine}=f;
 try{
  const operations=new Operations(engine),allocations=new Allocations(engine),usage=new Usage(engine),lineage=new Lineage(engine),fulfillments=new Fulfillments(engine);
  const repo=await call(s+'Repository.create',{key:'operations',provider:'git',locator:'https://example.test/operations'}),pin=await call(s+'SpecificationPin.create',{repository:repo.id,anchor:'work',revision:'a'.repeat(40)});
  const dimension=await call(u+'UsageDimension.create',{key:'duration',unit:'second'}),source=await call(u+'UsageSource.create',{key:'execution-meter'});
  const bundle=await call('@forgegraph/foundation/evidence/_/EvidenceBundle.create',{key:'operations',label:'Operations'}),seal=await run(new Evidence(engine).seal(String(bundle.id),null,ctx));
  const storage=await run(Effect.service(Storage).pipe(Effect.provide(engine.layer)));
  const queue=new WorkQueue(storage,{id:'operations-work',execute:'@fixture/operations-consumer/_/Execute',leaseMs:1000,maxAttempts:2,maxTasks:32,maxRunners:8},()=>1000);
  for(const [index,type]of ['ManufacturingRun','LabRun','BobDevelopmentRun','MediaProduction'].entries()){
   const operation=await call(p+'Operation.create',{key:type,definition:pin.id});await call('@fixture/operations-consumer/_/'+type+'.create',{operation:operation.id,label:type});
   const pool=await call(a+'AllocationPool.create',{key:type,mode:'fungible',capacity:'2',unit:'slot'});
   const reservations=[];for(const key of ['actual','unused'])reservations.push(await call(a+'AllocationReservation.create',{pool:pool.id,key,quantity:'1',unit:'slot',from:'2026-01-02T00:00:00Z',until:'2026-01-03T00:00:00Z',holdUntil:'2026-01-01T12:00:00Z'}));
   for(const reservation of reservations)await run(allocations.act(String(reservation.id),'reserve',ctx));
   const grant=await run(allocations.act(String(reservations[0]!.id),'allocate',ctx));
   const firstPlan=await call(p+'PlannedAllocationLink.create',{operation:operation.id,reservation:reservations[0]!.id,previous:null,depth:1}),secondPlan=await call(p+'PlannedAllocationLink.create',{operation:operation.id,reservation:reservations[1]!.id,previous:firstPlan.id,depth:2});
   const stream=await call(u+'UsageStream.create',{label:type,dimension:dimension.id});
   const operationRun=await call(p+'OperationRun.create',{operation:operation.id,ordinal:1,plans:secondPlan.id,usageStream:stream.id,usageSource:source.id});
   const actual=await call(p+'ActualAllocationLink.create',{run:operationRun.id,operation:operation.id,planned:firstPlan.id,reservation:reservations[0]!.id,grant:grant.id,previous:null,depth:1});
   const started=await run(operations.start(String(operationRun.id),String(actual.id),{...ctx,idempotencyKey:'start-'+type}));
   const competingRun=await call(p+'OperationRun.create',{operation:operation.id,ordinal:2,plans:secondPlan.id,usageStream:stream.id,usageSource:source.id});await expect(run(operations.start(String(competingRun.id),null,ctx))).rejects.toThrow();
   const measurements={stream:String(stream.id),dimension:String(dimension.id),unit:'second',quantity:'12.5',ordinal:1,source:String(source.id),eventKey:type,occurredAt:at};
   const measured=await run(operations.usage(String(operationRun.id),measurements,ctx));expect(await run(new Operations(engine).usage(String(operationRun.id),measurements,ctx))).toEqual(measured);
   await expect(run(operations.usage(String(operationRun.id),{...measurements,quantity:'15'},ctx))).rejects.toThrow();
   expect((await run(usage.aggregate(String(stream.id),'2025-12-31T00:00:00Z','2026-01-02T00:00:00Z',ctx))).quantity).toBe('12.500000');
   const workSet=await call(ful+'FulfillmentSet.create',{label:type}),worker=await call(ful+'FulfillmentExecutor.create',{key:type});
   for(let ordinal=1;ordinal<=2;ordinal++){
    const fulfillment=await call(ful+'Fulfillment.create',{fulfillmentSet:workSet.id,ordinal,specificationPin:pin.id,executor:worker.id,requestedAt:at});await call(p+'OperationFulfillmentLink.create',{run:operationRun.id,operation:operation.id,fulfillment:fulfillment.id});
    const manifest=pinExecutionManifest({version:'execution-manifest/1',kind:'implementation',id:'operations-execute',requires:[]});
    const requirements=deriveExecutionRequirements({artifact:engine.model.bundle.ir,artifactDigest:executionDigest(engine.model.bundle.ir),operation:queue.definition.execute,profile:{id:'local',bindings:{[queue.definition.execute]:manifest.digest},providers:[]},manifests:[manifest]});
    // Actual queue durable enqueue bridge; business outcome remains independent.
    await run(fulfillments.enqueueTask(queue,type+'-'+ordinal,{fulfillment:String(fulfillment.id)},requirements,ctx));
    expect((await run(queue.get(ctx.tenant,type+'-'+ordinal))).id).toBe(type+'-'+ordinal);
   }
   expect((await call(p+'OperationFulfillmentLink.list.byRun',{params:{run:operationRun.id}})).items).toHaveLength(2);
   const graph=await call(l+'LineageGraph.create',{label:type}),input=await call(l+'LineageNode.create',{graph:graph.id,rank:1,label:'Input'}),output=await call(l+'LineageNode.create',{graph:graph.id,rank:3,label:'Output'}),transformation=await call(l+'Transformation.create',{graph:graph.id,rank:2,definition:pin.id,label:type});
   const ins=await run(lineage.member('Input',String(transformation.id),String(input.id),null,ctx)),outs=await run(lineage.member('Output',String(transformation.id),String(output.id),null,ctx)),lineageSeal=await run(lineage.seal(String(transformation.id),String(ins.id),String(outs.id),ctx));
   await call(p+'OperationLineageLink.create',{run:operationRun.id,operation:operation.id,transformation:transformation.id,seal:lineageSeal.id});expect((await run(lineage.traverse(String(output.id),'ancestors',ctx))).nodes).toHaveLength(2);
   const evaluations=new Evaluations(engine),evalSet=await call(e+'EvaluationSet.create',{label:type}),executor=await call(e+'EvaluationExecutor.create',{key:type,label:type}),evaluation=await run(evaluations.create({evaluationSet:String(evalSet.id),definition:String(pin.id),executor:String(executor.id)},ctx));await run(evaluations.start(String(evaluation.id),at,ctx));const finish=await run(evaluations.finish(String(evaluation.id),'Completed',at,'Measured',ctx,String(seal.id)));
   const evalLink=await call(p+'OperationEvaluationLink.create',{run:operationRun.id,operation:operation.id,evaluation:evaluation.id,finish:finish.id,support:seal.id});
   await expect(run(operations.end(String(operationRun.id),'Completed','Missing evaluation',ctx))).rejects.toThrow();
   let terminalId:string;
   if(index===0){
    const crashed=await call(p+'OperationEnd.create',{run:operationRun.id,start:started.id,outcome:'Completed',evaluation:evalLink.id,reason:'Crash before cleanup'});
    await call(p+'OperationCleanup.create',{ended:crashed.id,reason:'Untrusted premature marker'});
    expect((await run(operations.state(String(operationRun.id),ctx))).cleanupPending).toBe(true);
    await run(new Operations(engine).cleanup(String(crashed.id),ctx));
    expect((await run(operations.state(String(operationRun.id),ctx))).cleanupPending).toBe(false);
    terminalId=String(crashed.id);
   }else{
   const race=await Promise.allSettled([run(operations.end(String(operationRun.id),'Completed','Done',ctx,String(evalLink.id))),run(operations.end(String(operationRun.id),'Cancelled','Cancel',ctx))]);expect(race.filter(x=>x.status==='fulfilled')).toHaveLength(1);expect(race.filter(x=>x.status==='rejected')).toHaveLength(1);
   const accepted=race.find(x=>x.status==='fulfilled')!;if(accepted.status!=='fulfilled')throw new Error('No terminal outcome');
   terminalId=String(accepted.value.id);
   }
   await run(new Operations(engine).cleanup(terminalId,ctx));expect((await run(operations.state(String(operationRun.id),ctx))).cleanupPending).toBe(false);
   expect((await run(allocations.inspect(String(pool.id),'2026-01-02T12:00:00Z',ctx))).available).toBe('2.000000');
   const journal=await call(a+'AllocationJournal.list.byPool',{params:{pool:pool.id}});expect((journal.items as {action:string}[]).filter(x=>x.action==='release')).toHaveLength(1);expect((journal.items as {action:string}[]).filter(x=>x.action==='cancel')).toHaveLength(1);
   expect((await run(usage.aggregate(String(stream.id),'2025-12-31T00:00:00Z','2026-01-02T00:00:00Z',ctx))).quantity).toBe('12.500000');
   await expect(run(operations.state(String(operationRun.id),{...ctx,tenant:'foreign'}))).rejects.toThrow();await expect(call(p+'OperationRun.create',{operation:operation.id,ordinal:3,plans:null,usageStream:stream.id,usageSource:source.id},{...ctx,tenant:'foreign'})).rejects.toThrow();
   if(index===3){engine.gatekeeper.authorizer=localAuthorizer({policies:[{id:'run',actions:[p+'OperationRun.get'],requires:[],where:[]}],pips:[],epoch:1,knownObligations:[]});await expect(run(operations.state(String(operationRun.id),ctx))).rejects.toThrow();await expect(run(operations.cleanup(terminalId,ctx))).rejects.toThrow();}
  }
 }finally{await f.close();}
});
