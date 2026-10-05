import { Effect, Layer } from 'effect';
import { expect,it } from 'vitest';
import { ResourceRelations } from '../src/foundation/resource-relations.js';
import { Evidence } from '../src/foundation/evidence.js';
import { Clock } from '../src/services.js';
import { Engine } from '../src/engine.js';
import { localAuthorizer } from '../src/gatekeeper.js';
import { foundation,foundationAdapters } from './helpers/foundation.js';
const p='@forgegraph/foundation/resource-relations/_/',e='@forgegraph/foundation/evidence/_/',s='@forgegraph/foundation/specification/_/',party='@forgegraph/foundation/party/_/',d='@fixture/resource-relations-consumer/_/';
const start='2025-01-01T00:00:00.000Z',boundary='2025-06-01T00:00:00.000Z',future='2027-01-01T00:00:00.000Z';
async function setup(adapter:string){
 const f=await foundation('resource-relations',adapter,true);const {call,engine,ctx}=f;
 const repo=await call(s+'Repository.create',{key:'rules',provider:'git',locator:'https://example.test/rules'});
 const pin=await call(s+'SpecificationPin.create',{repository:repo.id,anchor:'@domain/_/Relations',revision:'a'.repeat(40)});
 const kinds=['owner','operator','custodian','controller','host','payer','inspector'] as const;
 const service=new ResourceRelations(engine,{namespace:'domain',kinds});
 for(const kind of kinds)await Effect.runPromise(service.registerKind(kind,String(pin.id),ctx));
 const a=await call(party+'Party.create',{label:'A',identifiers:null}),b=await call(party+'Party.create',{label:'B',identifiers:null});
 const source=await call(e+'EvidenceSource.create',{key:'event-source',label:'Event source'});
 const bundle=await call(e+'EvidenceBundle.create',{key:'proof',label:'Event proof'});
 const evidence=new Evidence(engine);
 const item=await Effect.runPromise(evidence.record({bundle:String(bundle.id),source:String(source.id),sourceRecord:'event-1',kind:'handoff',observedAt:start,provenance:'Signed domain event'},ctx));
 const member=await Effect.runPromise(evidence.member(String(bundle.id),String(item.id),null,ctx));
 const seal=await Effect.runPromise(evidence.seal(String(bundle.id),String(member.id),ctx));
 const fact=await call(p+'RelationSource.create',{key:'event',source:source.id,sourceRecord:'event-1',occurredAt:start,evidence:seal.id,description:'Recorded domain event'});
 const subject=await call(p+'ResourceSubject.create',{key:'resource',label:'Resource'});
 const scope=await call(p+'RelationScope.create',{subject:subject.id,key:'whole',label:'Whole resource'});
 const input={key:'first',subject:String(subject.id),party:String(a.id),kind:'custodian' as const,scope:String(scope.id),validFrom:start,source:String(fact.id),reason:'Received'};
 const run=<A>(effect:Effect.Effect<A,any>)=>Effect.runPromise(effect);
 const view=(validAt:string,knownAt=future)=>run(service.asOf(String(subject.id),{validAt,knownAt},ctx));
 return {...f,a,b,source,seal,fact,subject,scope,input,service,run,view};
}
for(const adapter of foundationAdapters){
 it(`${adapter}: typed leased equipment, consignment and cloud relations remain distinct with extensible exact extent`,async()=>{
  const f=await setup(adapter);try{
   const {call,run,service,ctx,input,a,b}=f;
   for(const [type,field,kinds] of [['LeasedEquipment','serial',['owner','operator','custodian']],['ConsignedInventory','lot',['controller','custodian']],['CloudResource','account',['host','operator','payer']]] as const){
    const subject=await call(p+'ResourceSubject.create',{key:type,label:type});
    const scope=await call(p+'RelationScope.create',{subject:subject.id,key:'extent',label:'Typed extent'});
    await call(d+type+'.create',{resource:subject.id,[field]:type});
    for(const [i,kind] of kinds.entries())await run(service.establish({...input,key:type+kind,subject:String(subject.id),scope:String(scope.id),kind,party:String(i%2?a.id:b.id),quantity:'12.000001',unit:'each'},ctx));
    expect((await run(service.asOf(String(subject.id),{validAt:boundary,knownAt:future},ctx))).map(x=>x.kind).sort()).toEqual([...kinds].sort());
   }
   await run(service.establish({...input,kind:'inspector'},ctx));
   expect((await f.view(boundary))[0]?.kind).toBe('inspector');
   const denied=new Engine(f.engine.model,f.engine.layer);denied.gatekeeper.authorizer=localAuthorizer({policies:[],pips:[],epoch:1,knownObligations:[]});
   await expect(Effect.runPromise(denied.call(p+'ResourceSubject.get',{id:f.subject.id},{...ctx,actor:String(a.id)}))).rejects.toThrow();
   await expect(run(service.establish({...input,key:'foreign'},{...ctx,tenant:'foreign'}))).rejects.toThrow();
   await expect(run(service.establish({...input,key:'quantity',quantity:'1'},ctx))).rejects.toThrow();
   await expect(run(service.establish({...input,key:'negative',quantity:'-1',unit:'each'},ctx))).rejects.toThrow();
   await expect(run(service.establish({...input,key:'time',validUntil:start},ctx))).rejects.toThrow();
  }finally{await f.close();}
 });
 it(`${adapter}: atomic custody handoff has one winner, inert loser, historical knowledge and restart replay`,async()=>{
  const f=await setup(adapter);try{
   const {run,service,ctx,input,b,view}=f;
   const initial=await run(service.establish(input,ctx));
   expect(await view(boundary,new Date(Date.parse(String(initial.createdAt))-1).toISOString())).toEqual([]);
   expect((await view(boundary,String(initial.createdAt)))[0]?.knownFrom).toBe(initial.createdAt);
   const handoff={key:'transfer',prior:String(initial.current),party:String(b.id),effectiveAt:boundary,source:input.source,reason:'Receipt event'};
   await f.call(d+'CustodyHandoffEvent.create',{source:f.fact.id,resource:f.subject.id,receipt:'receipt'});
   const outcomes=await Promise.allSettled([run(service.handoff(handoff,ctx)),run(service.handoff({...handoff,key:'competitor'},ctx))]);
   expect(outcomes.filter(x=>x.status==='fulfilled')).toHaveLength(1);
   const winner=outcomes.find(x=>x.status==='fulfilled') as PromiseFulfilledResult<Record<string,unknown>>;
   expect(await view(boundary,String(initial.createdAt))).toMatchObject([{party:f.a.id}]);
   expect(await view(boundary,String(winner.value.createdAt))).toMatchObject([{party:b.id,knownFrom:winner.value.createdAt}]);
   expect(await view(start)).toMatchObject([{party:f.a.id}]);
   expect(await view(boundary)).toHaveLength(1);
   const restarted=new ResourceRelations(new Engine(f.engine.model,f.engine.layer),{namespace:'domain',kinds:['custodian']});
   const key=String(winner.value.key);
   expect((await run(restarted.handoff({...handoff,key},ctx))).id).toBe(winner.value.id);
   await expect(run(restarted.handoff({...handoff,key,reason:'Changed'},ctx))).rejects.toThrow();
   await expect(run(service.end({key:'again',relation:String(initial.current),effectiveAt:boundary,source:input.source,reason:'Again'},ctx))).rejects.toThrow();
  }finally{await f.close();}
 });
 it(`${adapter}: future ends and backdated termination preserve half-open valid time and inclusive knowledge boundaries`,async()=>{
  const f=await setup(adapter);try{
   const initial=await f.run(f.service.establish(f.input,f.ctx));
   const end=await f.run(f.service.end({key:'end',relation:String(initial.current),effectiveAt:future,source:f.input.source,reason:'Scheduled return'},f.ctx));
   expect(await f.view(boundary,String(end.createdAt))).toHaveLength(1);
   expect(await f.view(future,String(end.createdAt))).toEqual([]);
   expect(await f.view(future,String(initial.createdAt))).toHaveLength(1);
   const other=await f.run(f.service.establish({...f.input,key:'other'},f.ctx));
   const retro=await f.run(f.service.end({key:'retro',relation:String(other.current),effectiveAt:boundary,source:f.input.source,reason:'Late received event'},f.ctx));
   expect((await f.view(boundary,String(other.createdAt))).map(x=>x.relation)).toContain(other.current);
   expect((await f.view(boundary,String(retro.createdAt))).map(x=>x.relation)).not.toContain(other.current);
   await expect(f.run(f.service.asOf(String(f.subject.id),{validAt:'yesterday',knownAt:future},f.ctx))).rejects.toThrow();
  }finally{await f.close();}
 });
 it(`${adapter}: denied successor Party cannot partially end custody and empty evidence cannot publish`,async()=>{
  const f=await setup(adapter);try{
   const initial=await f.run(f.service.establish(f.input,f.ctx));
   const auth=f.engine.gatekeeper.authorizer;
   f.engine.gatekeeper.authorizer=localAuthorizer({policies:[{id:'hide-party',actions:f.engine.model.resources.filter(r=>r.id!==party+'Party').map(r=>r.id+'.*'),requires:[],where:[]}],pips:[],epoch:91,knownObligations:[]});
   await expect(f.run(f.service.handoff({key:'denied-transfer',prior:String(initial.current),party:String(f.b.id),effectiveAt:boundary,source:f.input.source,reason:'Denied'},f.ctx))).rejects.toThrow();
   f.engine.gatekeeper.authorizer=auth;
   expect(await f.view(boundary)).toMatchObject([{party:f.a.id}]);
   await expect(f.call(p+'RelationCommit.find.byPrior',{params:{prior:initial.current}})).rejects.toThrow();
   const bundle=await f.call(e+'EvidenceBundle.create',{key:'empty',label:'Empty'});
   const seal=await f.run(new Evidence(f.engine).seal(String(bundle.id),null,f.ctx));
   const source=await f.call(p+'RelationSource.create',{key:'empty',source:f.source.id,sourceRecord:'event-1',occurredAt:start,evidence:seal.id,description:'Missing support'});
   await expect(f.run(f.service.establish({...f.input,key:'empty',source:String(source.id)},f.ctx))).rejects.toThrow();
   await expect(f.call(p+'RelationCommit.find.byKey',{params:{key:'empty'}})).rejects.toThrow();
  }finally{await f.close();}
 });
 it(`${adapter}: equal knowledge timestamps are inclusive and staged successors stay inert`,async()=>{
  const f=await setup(adapter);try{
   const fixed='2026-02-01T00:00:00.000Z';
   const engine=new Engine(f.engine.model,Layer.mergeAll(f.engine.layer,Layer.succeed(Clock)({now:()=>fixed})));
   const service=new ResourceRelations(engine,{namespace:'domain',kinds:['custodian']});
   const initial=await f.run(service.establish(f.input,f.ctx));
   const candidate=await f.call(p+'PartyResourceRelation.get',{id:initial.current});
   await f.call(p+'PartyResourceRelation.create',{key:'staged',subject:candidate.subject,party:f.b.id,kind:candidate.kind,scope:candidate.scope,quantity:null,unit:null,validFrom:boundary,validUntil:null,previous:initial.current,depth:2});
   expect(await f.run(service.asOf(String(f.subject.id),{validAt:boundary,knownAt:fixed},f.ctx))).toMatchObject([{party:f.a.id}]);
   const commit=await f.run(service.handoff({key:'same-time',prior:String(initial.current),party:String(f.b.id),effectiveAt:boundary,source:f.input.source,reason:'Receipt'},f.ctx));
   expect(commit.createdAt).toBe(initial.createdAt);
   expect(await f.run(service.asOf(String(f.subject.id),{validAt:boundary,knownAt:fixed},f.ctx))).toMatchObject([{party:f.b.id}]);
   expect(await f.run(service.asOf(String(f.subject.id),{validAt:boundary,knownAt:'2026-01-31T23:59:59.999Z'},f.ctx))).toEqual([]);
   engine.gatekeeper.authorizer=localAuthorizer({policies:[{id:'hide-commit',actions:engine.model.resources.filter(r=>r.id!==p+'RelationCommit').map(r=>r.id+'.*'),requires:[],where:[]}],pips:[],epoch:77,knownObligations:[]});
   await expect(f.run(service.asOf(String(f.subject.id),{validAt:boundary,knownAt:fixed},f.ctx))).rejects.toThrow();
  }finally{await f.close();}
 });
 it(`${adapter}: denied dependency reads and mismatched or future provenance cannot publish a relation`,async()=>{
  const f=await setup(adapter);try{
   const {engine,call,run,service,input,ctx}=f;
   let epoch=10;
   for(const resource of [party+'Party',p+'RelationKind',s+'SpecificationPin',e+'EvidenceSource']){
    const authorizer=engine.gatekeeper.authorizer;
    const allowed=[p+'*',e+'*',party+'*',s+'*'].filter(x=>!resource.startsWith(x.slice(0,-1)));
    const allResources=engine.model.bundle.ir.modules.flatMap(m=>m.resources).map(r=>r.id).filter(id=>id!==resource);
    engine.gatekeeper.authorizer=localAuthorizer({policies:[{id:'all-except-dependency',actions:[...allowed,...allResources.map(id=>id+'.*')],requires:[],where:[]}],pips:[],epoch:++epoch,knownObligations:[]});
    await expect(run(service.establish({...input,key:resource},ctx))).rejects.toThrow();
    engine.gatekeeper.authorizer=authorizer;
    await expect(call(p+'RelationCommit.find.byKey',{params:{key:resource}})).rejects.toThrow();
   }
   for(const [key,sourceRecord,occurredAt] of [['mismatch','other',start],['future','event-1',future]] as const){
    const source=await call(p+'RelationSource.create',{key,source:f.source.id,sourceRecord,occurredAt,evidence:f.seal.id,description:'Invalid provenance'});
    await expect(run(service.establish({...input,key,source:String(source.id)},ctx))).rejects.toThrow();
    await expect(call(p+'RelationCommit.find.byKey',{params:{key}})).rejects.toThrow();
   }
   expect(await f.view(boundary)).toEqual([]);
  }finally{await f.close();}
 });
}
