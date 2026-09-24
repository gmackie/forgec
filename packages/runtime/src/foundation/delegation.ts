import { Effect } from 'effect';
import type { Engine,CallContext } from '../engine.js';
import type { Wire } from '../decode.js';
import { decodeDatetime } from '../codecs.js';
import { err,type ForgeError } from '../errors.js';
import { Clock } from '../services.js';
import { Evidence } from './evidence.js';
import { findTerminalFact } from './facts.js';
const p='@forgegraph/foundation/delegation/_/',ep='@forgegraph/foundation/entitlement/_/';
export class Delegations {
 constructor(private readonly engine:Engine){}
 explain(id:string,at:string,ctx:CallContext):Effect.Effect<{delegation:Wire;root:Wire;chain:Wire[];effective:boolean;reasons:string[]},ForgeError>{const self=this;return Effect.gen(function*(){
  const instant=yield* Effect.try({try:()=>decodeDatetime(at),catch:()=>err('ValidationFailed','Invalid delegation instant')});
  const chain:Wire[]=[],reasons:string[]=[],seen=new Set<string>();let cursor:string|null=id,root:Wire|null=null;
  while(cursor){if(chain.length>=8||seen.has(cursor))return yield* Effect.fail(err('ValidationFailed','Delegation chain is cyclic or exceeds eight hops'));seen.add(cursor);
   const row:Wire=yield* self.engine.call(p+'Delegation.get',{id:cursor},ctx);
   for(const subject of [row.delegator,row.delegate])yield* self.engine.call(p+'DelegationSubject.get',{id:subject},ctx);
   yield* self.engine.call('@forgegraph/foundation/specification/_/SpecificationPin.get',{id:row.constraints},ctx);
   const seal=yield* self.engine.call('@forgegraph/foundation/evidence/_/EvidenceSeal.get',{id:row.support},ctx);yield* new Evidence(self.engine).sealedItems(String(seal.bundle),ctx);
   const authority=yield* self.engine.call(ep+'Entitlement.get',{id:row.root},ctx),holder=yield* self.engine.call(p+'DelegationPartySubject.get',{id:row.rootHolder},ctx);
   if(authority.holder!==holder.party||row.scope!==authority.scope||row.right!==authority.right||root&&root.id!==authority.id)return yield* Effect.fail(err('ValidationFailed','Delegation root authority differs'));
   root=authority;
   const end=yield* findTerminalFact(self.engine,p+'DelegationRevocation','delegation',row.id,ctx);
   if(instant<String(row.validFrom)||instant>=String(row.validUntil))reasons.push('delegation-window:'+row.id);
   if(end&&instant>=String(end.effectiveAt))reasons.push('delegation-revoked:'+row.id);
   const child=chain.at(-1);
   if(child&&(row.redelegable!==true||child.delegator!==row.delegate||child.rootHolder!==row.rootHolder||child.scope!==row.scope||child.right!==row.right||child.constraints!==row.constraints||child.purpose!==row.purpose||Number(child.depth)!==Number(row.depth)+1||String(child.validFrom)<String(row.validFrom)||String(child.validUntil)>String(row.validUntil)))return yield* Effect.fail(err('ValidationFailed','Re-delegation exceeds its parent authority'));
   if(row.parent==null&&(row.delegator!==holder.subject||row.depth!==1))return yield* Effect.fail(err('ValidationFailed','Chain lacks a root delegator'));
   chain.push(row);cursor=row.parent==null?null:String(row.parent);
  }
  if(!root||!chain[0])return yield* Effect.fail(err('ValidationFailed','Empty delegation chain'));
  for(const [resource,id] of [['RightDefinition',root.right],['EntitlementScope',root.scope]])yield* self.engine.call(ep+resource+'.get',{id},ctx);
  yield* self.engine.call('@forgegraph/foundation/party/_/Party.get',{id:root.holder},ctx);
  const revoked=yield* findTerminalFact(self.engine,ep+'EntitlementEnd','entitlement',root.id,ctx);
  if(instant<String(root.validFrom)||root.validUntil!=null&&instant>=String(root.validUntil))reasons.push('root-window');
  if(revoked&&instant>=String(revoked.effectiveAt))reasons.push('root-revoked');
  return {delegation:chain[0],root,chain,effective:reasons.length===0,reasons};
 });}
 pip(id:string,subject:string,ctx:CallContext){const self=this;return Effect.gen(function*(){
  const now=yield* Effect.gen(function*(){return(yield* Clock).now();}).pipe(Effect.provide(self.engine.layer));
  const state=yield* self.assurance(id,subject,now,ctx);
  return {pip:'delegation:'+id,attribute:'effective',value:state.effective,observedAt:now,expiresAt:new Date(Date.parse(now)+1000).toISOString(),...state};
 });}
 revoke(delegation:string,effectiveAt:string,reason:string,ctx:CallContext){return this.engine.call(p+'DelegationRevocation.create',{delegation,effectiveAt,reason,recordedBy:ctx.actor},ctx);}
 assurance(id:string,subject:string,at:string,ctx:CallContext){const self=this;return Effect.gen(function*(){const state=yield* self.explain(id,at,ctx);if(state.delegation.delegate!==subject)return yield* Effect.fail(err('ValidationFailed','Delegate differs from trusted principal mapping'));return {subject,scope:state.root.scope,right:state.root.right,purpose:state.delegation.purpose,effective:state.effective,chain:state.chain.map(row=>row.id),root:state.root.id,reasons:state.reasons};});}
}
