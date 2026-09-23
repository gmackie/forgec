import {Effect} from 'effect';
import {expect,it} from 'vitest';
import {foundation,foundationAdapters} from './helpers/foundation.js';
import {Integrations} from '../src/foundation/integration.js';
import {Evidence} from '../src/foundation/evidence.js';
import {Deliveries} from '../src/foundation/delivery.js';
import {Evaluations} from '../src/foundation/evaluation.js';
import {Reconciliations} from '../src/foundation/reconciliation.js';
import {localAuthorizer} from '../src/gatekeeper.js';
const p='@forgegraph/foundation/integration/_/',i='@forgegraph/foundation/identifiers/_/',s='@forgegraph/foundation/specification/_/',r='@forgegraph/foundation/reconciliation/_/',l='@forgegraph/foundation/lineage/_/',fuf='@forgegraph/foundation/fulfillment/_/',e='@forgegraph/foundation/evaluation/_/';
const run=Effect.runPromise,at='2026-01-01T00:00:00Z';
for(const adapter of foundationAdapters)it(`${adapter}: accepted-prefix checkpoints, webhook dedup, cursor races and real bridges`,async()=>{
 const f=await foundation('integration',adapter,true),{call,ctx,engine}=f;
 try{
  const integrations=new Integrations(engine);
  const repo=await call(s+'Repository.create',{key:'sync',provider:'git',locator:'https://example.test/sync'}),pin=await call(s+'SpecificationPin.create',{repository:repo.id,anchor:'sync',revision:'a'.repeat(40)});
  const bundle=await call('@forgegraph/foundation/evidence/_/EvidenceBundle.create',{key:'sync',label:'Sync'}),seal=await run(new Evidence(engine).seal(String(bundle.id),null,ctx));
  const workSet=await call(fuf+'FulfillmentSet.create',{label:'Sync'}),worker=await call(fuf+'FulfillmentExecutor.create',{key:'adapter'});
  for(const [index,type]of ['GitHubIssue','LinearIssue','IndustrialDevice'].entries()){
   const scope=await call(r+'ReconciliationScope.create',{key:type}),desired=await call(r+'DesiredRevision.create',{scope:scope.id,sequence:1,pin:pin.id});await run(new Reconciliations(engine).publish(String(scope.id),String(desired.id),'Desired',null,ctx));
   const connection=await call(p+'Connection.create',{key:type,provider:type,credentialBinding:'kernel-secret-binding-'+type,direction:'Bidirectional',authority:'Manual',reconciliation:scope.id});
   const identifierSet=await call(i+'IdentifierSet.create',{label:type}),identifier=await call(i+'Identifier.create',{identifierSet:identifierSet.id,namespace:type.toLowerCase(),issuer:null,issuerScope:'namespace',value:'42',validFrom:at,validUntil:null});
   const graph=await call(l+'LineageGraph.create',{label:type}),source=await call(l+'LineageNode.create',{graph:graph.id,rank:1,label:'Provider'}),target=await call(l+'LineageNode.create',{graph:graph.id,rank:2,label:'Accepted internal state'});
   const lineage=await call(l+'LineageRelation.create',{graph:graph.id,source:source.id,target:target.id,kind:'Copied',definition:pin.id,supersedes:null,revision:1});
   const mapping=await call(p+'ExternalMapping.create',{connection:connection.id,identifier:identifier.id,node:source.id});
   await call('@fixture/integration-consumer/_/'+type+'.create',{mapping:mapping.id,[['repository','team','serial'][index]!]:type});
   const receipts=await Promise.all([run(integrations.webhook(String(connection.id),'event-1','a'.repeat(64),String(seal.id),ctx)),run(integrations.webhook(String(connection.id),'event-1','a'.repeat(64),String(seal.id),ctx))]);expect(receipts[0].id).toBe(receipts[1].id);
   await expect(run(integrations.webhook(String(connection.id),'event-1','b'.repeat(64),String(seal.id),ctx))).rejects.toThrow();
   const fulfillment=await call(fuf+'Fulfillment.create',{fulfillmentSet:workSet.id,ordinal:index+1,specificationPin:pin.id,executor:worker.id,requestedAt:at});
   const sync=await call(p+'SyncRun.create',{connection:connection.id,key:'batch-1',before:null,afterToken:'opaque-provider-page-2',expectedCount:2,fulfillment:fulfillment.id,desired:desired.id});
   const first=await call(p+'AcceptedRecord.create',{run:sync.id,mapping:mapping.id,connection:connection.id,ordinal:1,previous:null,support:seal.id,lineage:lineage.id,sourceNode:source.id});
   await expect(call(p+'SyncSeal.create',{run:sync.id,head:first.id,count:1})).rejects.toThrow();
   expect(await run(new Integrations(engine).cursor(String(connection.id),ctx))).toBeNull();
   const second=await call(p+'AcceptedRecord.create',{run:sync.id,mapping:mapping.id,connection:connection.id,ordinal:2,previous:first.id,support:seal.id,lineage:lineage.id,sourceNode:source.id});
   const batch=await call(p+'SyncSeal.create',{run:sync.id,head:second.id,count:2});
   expect(await run(new Integrations(engine).cursor(String(connection.id),ctx))).toBeNull();
   const cursor=await run(integrations.checkpoint(String(sync.id),String(batch.id),{...ctx,idempotencyKey:'checkpoint-'+index}));
   expect(await run(new Integrations(engine).checkpoint(String(sync.id),String(batch.id),{...ctx,idempotencyKey:'checkpoint-'+index}))).toEqual(cursor);
   expect((await run(integrations.accepted(String(batch.id),ctx))).map(x=>x.id)).toEqual([first.id,second.id]);
   const nextRun=await call(p+'SyncRun.create',{connection:connection.id,key:'batch-2',before:cursor.id,afterToken:'opaque-provider-page-3',expectedCount:1,fulfillment:fulfillment.id,desired:desired.id});
   const nextRecord=await call(p+'AcceptedRecord.create',{run:nextRun.id,mapping:mapping.id,connection:connection.id,ordinal:1,previous:null,support:seal.id,lineage:lineage.id,sourceNode:source.id}),nextSeal=await call(p+'SyncSeal.create',{run:nextRun.id,head:nextRecord.id,count:1});
   const race=await Promise.allSettled([run(integrations.checkpoint(String(nextRun.id),String(nextSeal.id),ctx)),run(integrations.checkpoint(String(nextRun.id),String(nextSeal.id),ctx))]);expect(race.filter(x=>x.status==='fulfilled')).toHaveLength(1);expect(race.filter(x=>x.status==='rejected')).toHaveLength(1);
   expect((await run(integrations.cursor(String(connection.id),ctx)))?.token).toBe('opaque-provider-page-3');
   await expect(run(integrations.checkpoint(String(sync.id),String(batch.id),ctx))).rejects.toThrow();
   const evalSet=await call(e+'EvaluationSet.create',{label:type}),executor=await call(e+'EvaluationExecutor.create',{key:type,label:type}),evaluations=new Evaluations(engine);
   const observed=await run(evaluations.create({evaluationSet:String(evalSet.id),definition:String(pin.id),executor:String(executor.id)},ctx));await run(evaluations.start(String(observed.id),at,ctx));const finish=await run(evaluations.finish(String(observed.id),'Completed',at,'Drift observed',ctx,String(seal.id)));
   const observation=await call(r+'Observation.create',{desired:desired.id,run:observed.id,finish:finish.id,support:seal.id,observedAt:at}),drift=await call(r+'Drift.create',{observation:observation.id,desired:desired.id,pin:pin.id,anchor:'sync',field:'title',explanation:'Provider differs'});
   const conflict=await call(p+'SyncConflict.create',{mapping:mapping.id,connection:connection.id,desired:desired.id,drift:drift.id,description:'Conflicting edit'});await call(p+'SyncResolution.create',{conflict:conflict.id,authority:'Internal',support:seal.id,reason:'Explicit authorized local correction'});
   const deliveries=new Deliveries(engine),destination=await call('@forgegraph/foundation/delivery/_/DeliveryDestination.create',{key:type,label:type});const intent=await run(deliveries.create({key:'out-'+type,destination:String(destination.id),maxAttempts:2},ctx));
   await call(p+'OutboundDelivery.create',{connection:connection.id,mapping:mapping.id,intent:intent.id});const step=await run(deliveries.claim(String(intent.id),'Send','Correction',ctx)),attempt=await run(deliveries.start(String(step.id),at,type,'outbound-key-'+type,ctx));
   await run(deliveries.receipt({step:String(step.id),attempt:String(attempt.id),outcome:'Succeeded',completedAt:at,providerReference:'ack',callbackKey:type,detail:'Provider acknowledged',support:String(seal.id)},ctx));expect(await run(deliveries.outcome(String(step.id),ctx))).toBe('Succeeded');
   await expect(run(integrations.cursor(String(connection.id),{...ctx,tenant:'foreign'}))).rejects.toThrow();
   await expect(call(p+'ExternalMapping.create',{connection:connection.id,identifier:identifier.id,node:source.id},{...ctx,tenant:'foreign'})).rejects.toThrow();
   if(index===2){engine.gatekeeper.authorizer=localAuthorizer({policies:[{id:'connection',actions:[p+'Connection.get'],requires:[],where:[]}],pips:[],epoch:1,knownObligations:[]});await expect(run(integrations.cursor(String(connection.id),ctx))).rejects.toThrow();await expect(run(integrations.webhook(String(connection.id),'denied','a'.repeat(64),String(seal.id),ctx))).rejects.toThrow();}
  }
 }finally{await f.close();}
});
