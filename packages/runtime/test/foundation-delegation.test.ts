import { Effect } from 'effect';
import { expect,it,vi } from 'vitest';
import { foundation,foundationAdapters } from './helpers/foundation.js';
import { Delegations } from '../src/foundation/delegation.js';
import { Entitlements } from '../src/foundation/entitlement.js';
import { Evidence } from '../src/foundation/evidence.js';
import { Engine } from '../src/engine.js';
import { localAuthorizer } from '../src/gatekeeper.js';
const p='@forgegraph/foundation/delegation/_/',e='@forgegraph/foundation/entitlement/_/';
const from='2026-01-01T00:00:00Z',until='2026-02-01T00:00:00Z',at='2026-01-15T00:00:00Z';
for(const adapter of foundationAdapters)it(`${adapter}: scoped organization, human and agent delegation chains`,async()=>{
 const h=await foundation('delegation',adapter,true),run=Effect.runPromise;try{
  const {engine,ctx,call}=h,service=new Delegations(engine);
  const party=await call('@forgegraph/foundation/party/_/Party.create',{label:'Organization'}),rootSubject=await call(p+'DelegationSubject.create',{label:'Organization'}),manager=await call(p+'DelegationSubject.create',{label:'Manager'}),agent=await call(p+'DelegationSubject.create',{label:'Agent'}),human=await call(p+'DelegationSubject.create',{label:'Colleague'});
  const holder=await call(p+'DelegationPartySubject.create',{subject:rootSubject.id,party:party.id}),scope=await call(e+'EntitlementScope.create',{label:'Deployment'}),right=await call(e+'RightDefinition.create',{namespace:'operations',name:'deploy'});
  const root=await run(new Entitlements(engine).issue({holder:String(party.id),right:String(right.id),scope:String(scope.id),validFrom:from,validUntil:until,reason:'Root authority'},ctx));
  const repo=await call('@forgegraph/foundation/specification/_/Repository.create',{key:'limits',provider:'git',locator:'https://example.test/limits'}),pin=await call('@forgegraph/foundation/specification/_/SpecificationPin.create',{repository:repo.id,anchor:'limits',revision:'a'.repeat(40)}),bundle=await call('@forgegraph/foundation/evidence/_/EvidenceBundle.create',{key:'authority',label:'Authority'}),seal=await run(new Evidence(engine).seal(String(bundle.id),null,ctx));
  const input={delegator:rootSubject.id,delegate:manager.id,root:root.id,rootHolder:holder.id,parent:null,depth:1,scope:scope.id,right:right.id,constraints:pin.id,purpose:'release',validFrom:from,validUntil:until,redelegable:true,source:'board-approval',support:seal.id};
  const first=await call(p+'Delegation.create',input);await call('@fixture/delegation-consumer/_/EmployeeDelegation.create',{delegation:first.id,position:'Release manager'});
  const child=await call(p+'Delegation.create',{...input,delegator:manager.id,delegate:agent.id,parent:first.id,depth:2,redelegable:false});await call('@fixture/delegation-consumer/_/AgentDelegation.create',{delegation:child.id,tool:'deployment-runner'});
  const colleague=await call(p+'Delegation.create',{...input,delegator:manager.id,delegate:human.id,parent:first.id,depth:2,redelegable:false});await call('@fixture/delegation-consumer/_/HumanDelegation.create',{delegation:colleague.id,mandate:'Cover release shift'});
  expect((await run(service.assurance(String(child.id),String(agent.id),at,ctx)))).toMatchObject({effective:true,root:root.id,chain:[child.id,first.id]});
  const pip=await run(service.pip(String(child.id),String(agent.id),ctx));
  const policy=localAuthorizer({policies:[{id:'use-delegation',actions:['release'],requires:[{pip:pip.pip,attribute:pip.attribute}],where:[{field:'id',op:'in',from:{pip:pip.pip,attribute:pip.attribute,map:{true:['release']}}}]}],pips:[],epoch:1,knownObligations:[]});
  vi.useFakeTimers({toFake:['Date']});vi.setSystemTime(new Date(pip.observedAt));try{expect((await run(policy.decide({principal:{tenant:ctx.tenant,actor:ctx.actor},action:'release',kind:'read',current:{id:'release'},attributes:[pip],requestId:'delegation'}))).effect).toBe('allow');}finally{vi.useRealTimers();}
  await expect(call(p+'Delegation.create',{...input,delegator:agent.id,delegate:human.id,parent:child.id,depth:3})).rejects.toThrow();
  await expect(call(p+'Delegation.create',{...input,delegator:manager.id,delegate:agent.id,parent:first.id,depth:2,purpose:'unrelated'})).rejects.toThrow();
  await expect(call(p+'Delegation.create',{...input,validUntil:'2026-03-01T00:00:00Z'})).rejects.toThrow();
  expect((await run(service.explain(String(child.id),until,ctx))).effective).toBe(false);
  const races=await Promise.allSettled([run(service.revoke(String(first.id),at,'Ended',ctx)),run(service.revoke(String(first.id),at,'Revoked',ctx))]);expect(races.filter(r=>r.status==='fulfilled')).toHaveLength(1);
  expect((await run(service.explain(String(child.id),at,ctx))).effective).toBe(false);expect((await run(service.explain(String(child.id),from,ctx))).effective).toBe(true);
  await run(new Entitlements(engine).revoke(String(root.id),from,'Root ended',ctx));expect((await run(service.explain(String(child.id),from,ctx))).reasons).toContain('root-revoked');
  await expect(run(service.assurance(String(child.id),String(manager.id),at,ctx))).rejects.toThrow();
  const hidden=new Engine(engine.model,engine.layer);hidden.gatekeeper.authorizer=localAuthorizer({policies:engine.model.resources.filter(r=>r.id!==p+'DelegationRevocation').map(r=>({id:r.id,actions:[r.id+'.*'],requires:[],where:[]})),pips:[],epoch:2,knownObligations:[]});await expect(run(new Delegations(hidden).explain(String(child.id),at,ctx))).rejects.toThrow();
  await expect(run(service.explain(String(child.id),at,{...ctx,tenant:'foreign'}))).rejects.toThrow();
 }finally{await h.close();}
});
