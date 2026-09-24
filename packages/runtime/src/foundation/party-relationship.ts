import { Effect } from 'effect';
import type { Engine, CallContext } from '../engine.js';
import type { Wire } from '../decode.js';
import { err, type ForgeError } from '../errors.js';
import { decodeDatetime } from '../codecs.js';
import { findTerminalFact } from './facts.js';
const p='@forgegraph/foundation/party-relationship/_/';
/** A Party profile over ConceptIR's typed Relationship carrier; this grants no authority. */
export class PartyRelationships {
 constructor(private readonly engine:Engine) {}
 private call(op:string,input:Wire,ctx:CallContext){return this.engine.call(p+op,input,ctx);}
 private dependencies(row:Wire,ctx:CallContext){const self=this;return Effect.gen(function*(){
  const definition=yield* self.call('PartyRelationshipDefinition.get',{id:row.definition},ctx);
  yield* self.engine.call('@forgegraph/foundation/specification/_/SpecificationPin.get',{id:definition.pin},ctx);
  for(const id of [row.fromParty,row.toParty])yield* self.engine.call('@forgegraph/foundation/party/_/Party.get',{id},ctx);
  if(row.scope)yield* self.call('PartyRelationshipScope.get',{id:row.scope},ctx);
  if(row.support)yield* self.engine.call('@forgegraph/foundation/evidence/_/EvidenceSeal.get',{id:row.support},ctx);
  return definition;
 });}
 record(input:{definition:string;fromParty:string;toParty:string;scope?:string;validFrom:string;validUntil?:string;source:string;support?:string},ctx:CallContext){const self=this;return Effect.gen(function*(){
  yield* self.dependencies(input,ctx);
  return yield* self.call('PartyRelationship.create',{...input,scope:input.scope??null,validUntil:input.validUntil??null,support:input.support??null},ctx);
 });}
 end(relationship:string,effectiveAt:string,reason:string,ctx:CallContext,replacement?:string){const self=this;return Effect.gen(function*(){
  const row=yield* self.call('PartyRelationship.get',{id:relationship},ctx);yield* self.dependencies(row,ctx);
  if(replacement){const next=yield* self.call('PartyRelationship.get',{id:replacement},ctx);yield* self.dependencies(next,ctx);}
  return yield* self.call('PartyRelationshipEnd.create',{relationship,replacement:replacement??null,effectiveAt,reason,recordedBy:ctx.actor},ctx);
 });}
 current(id:string,at:string,ctx:CallContext):Effect.Effect<Wire|null,ForgeError>{const self=this;return Effect.gen(function*(){
  const instant=yield* Effect.try({try:()=>Date.parse(decodeDatetime(at)),catch:()=>err('ValidationFailed','Invalid relationship instant')});
  const row=yield* self.call('PartyRelationship.get',{id},ctx);yield* self.dependencies(row,ctx);
  const end=yield* findTerminalFact(self.engine,p+'PartyRelationshipEnd','relationship',id,ctx);
  return instant<Date.parse(String(row.validFrom))||row.validUntil!=null&&instant>=Date.parse(String(row.validUntil))||end&&instant>=Date.parse(String(end.effectiveAt))?null:row;
 });}
 /** Inverse perspectives return the same authoritative relationship ID. Exhaust every cursor. */
 listAt(party:string,perspective:'forward'|'inverse',at:string,ctx:CallContext,page:{cursor?:string;limit?:number}={}):Effect.Effect<{items:Wire[];next:string|null},ForgeError>{const self=this;return Effect.gen(function*(){
  yield* Effect.try({try:()=>decodeDatetime(at),catch:()=>err('ValidationFailed','Invalid relationship instant')});
  yield* self.engine.call('@forgegraph/foundation/party/_/Party.get',{id:party},ctx);
  const records=yield* self.call(perspective==='forward'?'PartyRelationship.list.byFromParty':'PartyRelationship.list.byToParty',{params:{[perspective==='forward'?'fromParty':'toParty']:party},...page},ctx);
  const items:Wire[]=[];
  for(const row of records.items as Wire[]){const current=yield* self.current(String(row.id),at,ctx);if(!current)continue;
   const definition=yield* self.call('PartyRelationshipDefinition.get',{id:row.definition},ctx);
   items.push({...current,label:perspective==='forward'?definition.forwardLabel:definition.inverseLabel,otherParty:perspective==='forward'?row.toParty:row.fromParty});
  }
  return {items,next:records.next as string|null};
 });}
}
