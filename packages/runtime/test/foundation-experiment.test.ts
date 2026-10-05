import {Effect} from 'effect';
import {expect,it} from 'vitest';
import {foundation,foundationAdapters} from './helpers/foundation.js';
import {Experiments} from '../src/foundation/experiment.js';
import {Allocations} from '../src/foundation/allocation.js';
import {Evaluations} from '../src/foundation/evaluation.js';
import {Evidence} from '../src/foundation/evidence.js';
import {Artifacts} from '../src/foundation/artifact.js';
import {Participations} from '../src/foundation/participation.js';
import {localAuthorizer} from '../src/gatekeeper.js';
const p='@forgegraph/foundation/experiment/_/',s='@forgegraph/foundation/specification/_/',a='@forgegraph/foundation/allocation/_/',e='@forgegraph/foundation/evaluation/_/',art='@forgegraph/foundation/artifact/_/',l='@forgegraph/foundation/lineage/_/',ful='@forgegraph/foundation/fulfillment/_/';
const run=Effect.runPromise,at='2026-01-01T00:00:00Z';
for(const adapter of foundationAdapters)it(`${adapter}: stable assignments, scarce capacity, typed evaluation and artifact lineage`,async()=>{
 const f=await foundation('experiment',adapter,true),{call,ctx,engine}=f;
 try{
  const experiments=new Experiments(engine),allocations=new Allocations(engine);
  const repo=await call(s+'Repository.create',{key:'experiment',provider:'git',locator:'https://example.test/experiment'});
  const pin=await call(s+'SpecificationPin.create',{repository:repo.id,anchor:'protocol',revision:'a'.repeat(40)});
  const variantPin=await call(s+'SpecificationPin.create',{repository:repo.id,anchor:'variant',revision:'b'.repeat(40)});
  const members=new Participations(engine,{namespace:'experiment',roles:['subject']});await run(members.registerRole('subject',ctx));
  const membersSet=await call('@forgegraph/foundation/participation/_/ParticipationSet.create',{label:'Subjects'}),party=await call('@forgegraph/foundation/party/_/Party.create',{label:'Subject'});
  const participant=await run(members.add({participationSet:String(membersSet.id),participant:String(party.id),role:'subject',validFrom:at,reason:'Enrolled'},ctx));
  for(const type of ['ABTest','LLMComparison','LevelForgeComparison','ManufacturingDOE']){
   const scarce=type==='ManufacturingDOE';
   const pool=scarce?await call(a+'AllocationPool.create',{key:type,mode:'exclusive',capacity:'1',unit:'slot'}):null;
   const experiment=await call(p+'Experiment.create',{key:type,definition:pin.id,variantCount:2,method:'SeededHash',seed:'protocol-seed-v1',pool:pool?.id??null,amendmentOf:null,revision:1});
   await call('@fixture/experiment-consumer/_/'+type+'.create',{experiment:experiment.id,label:type});
   await expect(run(experiments.state(String(experiment.id),ctx))).rejects.toThrow();
   const variants=[];
   for(let ordinal=0;ordinal<2;ordinal++)variants.push(await call(p+'ExperimentVariant.create',{experiment:experiment.id,ordinal,definition:variantPin.id,label:'Variant '+ordinal}));
   await expect(call(p+'ExperimentVariant.create',{experiment:experiment.id,ordinal:2,definition:variantPin.id,label:'Late variant'})).rejects.toThrow();
   const reservations=[];
   if(pool)for(const key of ['first','second'])reservations.push(await call(a+'AllocationReservation.create',{pool:pool.id,key,quantity:'1',unit:'slot',from:'2026-01-02T00:00:00Z',until:'2026-01-03T00:00:00Z',holdUntil:'2026-01-01T12:00:00Z'}));
   const input={experiment:String(experiment.id),subjectKey:'subject-a',provenance:'Enrolled under pinned protocol',participant:String(participant.id),...(reservations[0]?{reservation:String(reservations[0].id)}:{})};
   const duplicates=await Promise.all([run(experiments.assign(input,ctx)),run(experiments.assign(input,ctx))]);
   expect(duplicates[0].id).toBe(duplicates[1].id);
   const assigned=duplicates[0];expect((await run(experiments.state(String(experiment.id),ctx))).assignments).toHaveLength(1);
   expect(await run(new Experiments(engine).assign(input,ctx))).toEqual(assigned);
   await expect(run(experiments.assign({...input,provenance:'different'},ctx))).rejects.toThrow();
   if(pool){
    await expect(run(experiments.assign({...input,subjectKey:'subject-b',reservation:String(reservations[1]!.id)},ctx))).rejects.toThrow();
    expect((await run(allocations.inspect(String(pool.id),'2026-01-02T12:00:00Z',ctx))).available).toBe('0.000000');
   }
   const selected=variants.find(v=>v.id===assigned.variant)!;
   const evaluationSet=await call(e+'EvaluationSet.create',{label:type}),executor=await call(e+'EvaluationExecutor.create',{key:type,label:type});
   const bundle=await call('@forgegraph/foundation/evidence/_/EvidenceBundle.create',{key:type,label:type}),seal=await run(new Evidence(engine).seal(String(bundle.id),null,ctx));
   const evaluations=new Evaluations(engine),evaluation=await run(evaluations.create({evaluationSet:String(evaluationSet.id),definition:String(selected.definition),executor:String(executor.id)},ctx));await run(evaluations.start(String(evaluation.id),at,ctx));
   const finish=await run(evaluations.finish(String(evaluation.id),'Completed',at,'Measured',ctx,String(seal.id)));
   const link=await call(p+'ExperimentEvaluationLink.create',{assignment:assigned.id,variant:selected.id,run:evaluation.id,finish:finish.id,support:seal.id});
   await call('@fixture/experiment-consumer/_/Accuracy.create',{evaluation:link.id,correct:9,total:10});
   const workSet=await call(ful+'FulfillmentSet.create',{label:type}),worker=await call(ful+'FulfillmentExecutor.create',{key:type});
   const work=await call(ful+'Fulfillment.create',{fulfillmentSet:workSet.id,ordinal:1,specificationPin:selected.definition,executor:worker.id,requestedAt:at});
   await call(p+'ExperimentIntervention.create',{assignment:assigned.id,variant:selected.id,fulfillment:work.id});
   const artifact=await call(art+'Artifact.create',{key:type,label:type}),content=await call(art+'ArtifactContent.create',{});
   const upload=await call(art+'ArtifactContent.beginUpload',{id:content.id,expectedVersion:1,mediaType:'text/plain',byteCount:6});await f.objects.simulateUpload((upload.upload as {url:string}).url,new TextEncoder().encode('result'),'text/plain');
   const sealed=await call(art+'ArtifactContent.finalizeUpload',{id:content.id,expectedVersion:2});
   const revision=await run(new Artifacts(engine).publish({artifact:String(artifact.id),content:String(content.id),digest:String(sealed.digest),specificationPin:String(pin.id)},ctx));
   const graph=await call(l+'LineageGraph.create',{label:type}),node=await call(l+'LineageNode.create',{graph:graph.id,rank:1,label:'Analysis'});
   await call(p+'ExperimentArtifactLink.create',{experiment:experiment.id,revision:revision.id,node:node.id,definition:pin.id});
   await run(experiments.close(String(experiment.id),false,ctx));
   await expect(run(experiments.assign({...input,subjectKey:'late'},ctx))).rejects.toThrow();
   expect((await run(experiments.state(String(experiment.id),ctx))).closed).toBe(true);
   await expect(call(p+'ExperimentAssignment.update',{id:assigned.id,variant:variants.find(v=>v.id!==assigned.variant)!.id})).rejects.toThrow();
   await expect(run(experiments.state(String(experiment.id),{...ctx,tenant:'foreign'}))).rejects.toThrow();
   await expect(call(p+'ExperimentEvaluationLink.create',{assignment:assigned.id,variant:selected.id,run:evaluation.id,finish:finish.id,support:seal.id},{...ctx,tenant:'foreign'})).rejects.toThrow();
  }
  // Independent subjects race for one exclusive slot through real Allocation.
  const pool=await call(a+'AllocationPool.create',{key:'race',mode:'exclusive',capacity:'1',unit:'slot'});
  const experiment=await call(p+'Experiment.create',{key:'race',definition:pin.id,variantCount:1,method:'Manual',seed:'manual-v1',pool:pool.id,amendmentOf:null,revision:1});
  const variant=await call(p+'ExperimentVariant.create',{experiment:experiment.id,ordinal:0,definition:variantPin.id,label:'Only'});
  const reservations=[];for(const key of ['a','b'])reservations.push(await call(a+'AllocationReservation.create',{pool:pool.id,key,quantity:'1',unit:'slot',from:'2026-01-02T00:00:00Z',until:'2026-01-03T00:00:00Z',holdUntil:'2026-01-01T12:00:00Z'}));
  const race=await Promise.allSettled(reservations.map((reservation,index)=>run(experiments.assign({experiment:String(experiment.id),variant:String(variant.id),subjectKey:'racer-'+index,reservation:String(reservation.id),provenance:'Manual allocation'},ctx))));
  expect(race.filter(x=>x.status==='fulfilled')).toHaveLength(1);expect(race.filter(x=>x.status==='rejected')).toHaveLength(1);
  expect((await run(experiments.state(String(experiment.id),ctx))).assignments).toHaveLength(1);
  const wrong=await call(p+'Experiment.create',{key:'wrong',definition:pin.id,variantCount:1,method:'Manual',seed:'manual-v1',pool:null,amendmentOf:null,revision:1});
  await expect(call(p+'ExperimentAssignment.create',{experiment:wrong.id,subjectKey:'wrong',variant:variant.id,method:'Manual',seed:'manual-v1',provenance:'Wrong experiment',participant:null,reservation:null})).rejects.toThrow();
  engine.gatekeeper.authorizer=localAuthorizer({policies:[{id:'experiment',actions:[p+'Experiment.get'],requires:[],where:[]}],pips:[],epoch:1,knownObligations:[]});
  await expect(run(experiments.state(String(experiment.id),ctx))).rejects.toThrow();await expect(run(experiments.close(String(experiment.id),true,ctx))).rejects.toThrow();
 }finally{await f.close();}
});
