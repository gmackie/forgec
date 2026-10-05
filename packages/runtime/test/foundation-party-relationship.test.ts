import { Effect } from 'effect';
import { expect,it } from 'vitest';
import { foundation,foundationAdapters } from './helpers/foundation.js';
import { PartyRelationships } from '../src/foundation/party-relationship.js';
import { Evidence } from '../src/foundation/evidence.js';
import { Engine } from '../src/engine.js';
import { localAuthorizer } from '../src/gatekeeper.js';
const p='@forgegraph/foundation/party-relationship/_/',sp='@forgegraph/foundation/specification/_/',e='@forgegraph/foundation/evidence/_/';
const start='2026-01-01T00:00:00Z',mid='2026-01-15T00:00:00Z',end='2026-02-01T00:00:00Z';
for(const adapter of foundationAdapters)it(`${adapter}: typed Party Relationship perspectives, provenance and history`,async()=>{
 const f=await foundation('party-relationship',adapter,true),run=Effect.runPromise;
 try{
  const {engine,ctx,call}=f,service=new PartyRelationships(engine);
  const repo=await call(sp+'Repository.create',{key:'relationships',provider:'git',locator:'https://example.test/spec'}),pin=await call(sp+'SpecificationPin.create',{repository:repo.id,anchor:'relationships',revision:'a'.repeat(40)});
  const support=await call(e+'EvidenceBundle.create',{key:'proof',label:'Signed relationship evidence'}),seal=await run(new Evidence(engine).seal(String(support.id),null,ctx));
  for(const [key,profile,forward,inverse,extra] of [
   ['employment','Employment','employs','employeeOf',{jobTitle:'Engineer'}],
   ['corporate','CorporateOwnership','parentOf','subsidiaryOf',{ownershipPercent:'75.0000'}],
   ['guardianship','Guardianship','guardianOf','dependentOf',{courtOrder:'order-1'}],
   ['supply','SupplyRelationship','supplies','customerOf',{supplierNumber:'supplier-1'}],
  ] as const){
   const definition=await call(p+'PartyRelationshipDefinition.create',{key,pin:pin.id,forwardLabel:forward,inverseLabel:inverse});
   const from=await call('@forgegraph/foundation/party/_/Party.create',{label:forward}),to=await call('@forgegraph/foundation/party/_/Party.create',{label:inverse});
   const input={definition:String(definition.id),fromParty:String(from.id),toParty:String(to.id),validFrom:start,validUntil:end,source:'signed-contract:'+key,support:String(seal.id)};
   const relation=await run(service.record(input,ctx));
   await call('@fixture/party-relationship-consumer/_/'+profile+'.create',{relationship:relation.id,definition:definition.id,fromParty:from.id,toParty:to.id,validFrom:start,validUntil:end,...extra});
   expect((await run(service.listAt(String(from.id),'forward',start,ctx))).items).toMatchObject([{id:relation.id,label:forward,otherParty:to.id}]);
   expect((await run(service.listAt(String(to.id),'inverse',start,ctx))).items).toMatchObject([{id:relation.id,label:inverse,otherParty:from.id}]);
   expect(await run(service.current(String(relation.id),end,ctx))).toBeNull();
   await expect(run(service.record({...input,toParty:input.fromParty},ctx))).rejects.toThrow();
   await expect(run(service.record(input,ctx))).rejects.toMatchObject({code:'UniqueConflict'});
   const replacement=await run(service.record({...input,validFrom:mid},ctx));
   const results=await Promise.allSettled([run(service.end(String(relation.id),mid,'Superseded',ctx,String(replacement.id))),run(service.end(String(relation.id),mid,'Ended',ctx))]);
   expect(results.filter(r=>r.status==='fulfilled')).toHaveLength(1);
   expect(await run(service.current(String(relation.id),mid,ctx))).toBeNull();
   expect(await run(service.current(String(relation.id),start,ctx))).not.toBeNull();
   await expect(run(service.end(String(replacement.id),start,'Backwards',ctx,String(relation.id)))).rejects.toThrow();
   await expect(call(p+'PartyRelationship.delete',{id:relation.id})).rejects.toThrow();
   await expect(run(service.current(String(relation.id),start,{...ctx,tenant:'foreign'}))).rejects.toThrow();
   const guarded=new Engine(engine.model,engine.layer);guarded.gatekeeper.authorizer=localAuthorizer({policies:engine.model.resources.filter(r=>r.id!==p+'PartyRelationshipEnd').map(r=>({id:r.id,actions:[r.id+'.*'],requires:[],where:[]})),pips:[],epoch:2,knownObligations:[]});
   await expect(run(new PartyRelationships(guarded).current(String(relation.id),start,ctx))).rejects.toThrow();
  }
  expect(engine.model.resources.some(r=>/\/(Participation|Delegation|Entitlement)$/.test(r.id))).toBe(false);
 }finally{await f.close();}
});
