import {Effect} from 'effect';
import type {Engine,CallContext} from '../engine.js';
import type {Wire} from '../decode.js';
import {err,type ForgeError} from '../errors.js';
import {Decisions} from './decision.js';
import {Evidence} from './evidence.js';
import {findTerminalFact} from './facts.js';
const p='@forgegraph/foundation/change/_/';
export class Changes {
 constructor(private readonly engine:Engine){}
 private decision(link:string,ctx:CallContext):Effect.Effect<Wire,ForgeError>{const self=this;return Effect.gen(function*(){
  const fact=yield* self.engine.call(p+'ChangeDecisionLink.get',{id:link},ctx);
  const change=yield* self.engine.call(p+'Change.get',{id:fact.change},ctx);
  const state=yield* new Decisions(self.engine).state(String(change.approvalCase),ctx);
  if(state.outcome?.id!==fact.outcome||state.terminal?.id!==fact.terminal||state.outcome?.selected!==fact.selected)return yield* Effect.fail(err('ValidationFailed','Change requires validated finalized decision'));
  return fact;
 });}
 implement(change:string,fulfillment:string,scheduledAt:string,ctx:CallContext,decision?:string):Effect.Effect<Wire,ForgeError>{const self=this;return Effect.gen(function*(){
  if(decision)yield* self.decision(decision,ctx);
  const ended=yield* findTerminalFact(self.engine,p+'ChangeEnd','change',change,ctx);
  if(ended)return yield* Effect.fail(err('InvalidTransition','Change is terminal'));
  return yield* self.engine.call(p+'ChangeImplementationLink.create',{change,fulfillment,scheduledAt,decision:decision??null},ctx);
 });}
 end(input:{change:string;outcome:'Completed'|'Failed'|'Cancelled'|'Rejected';reason:string;implementation?:string;fulfillment?:string;fulfillmentEnd?:string;verification?:string;decision?:string},ctx:CallContext):Effect.Effect<Wire,ForgeError>{const self=this;return Effect.gen(function*(){
  if(input.decision)yield* self.decision(input.decision,ctx);
  if(input.implementation){const implementation=yield* self.engine.call(p+'ChangeImplementationLink.get',{id:input.implementation},ctx);if(implementation.decision)yield* self.decision(String(implementation.decision),ctx);}
  if(input.verification){const verification=yield* self.engine.call(p+'ChangeVerificationLink.get',{id:input.verification},ctx);const seal=yield* self.engine.call('@forgegraph/foundation/evidence/_/EvidenceSeal.get',{id:verification.support},ctx);yield* new Evidence(self.engine).sealedItems(String(seal.bundle),ctx);}
  return yield* self.engine.call(p+'ChangeEnd.create',{...input,implementation:input.implementation??null,fulfillment:input.fulfillment??null,fulfillmentEnd:input.fulfillmentEnd??null,verification:input.verification??null,decision:input.decision??null},ctx);
 });}
 state(change:string,ctx:CallContext):Effect.Effect<{change:Wire;phase:string;implementation:Wire|null;ended:Wire|null;rollback:Wire|null;supersession:Wire|null},ForgeError>{const self=this;return Effect.gen(function*(){
  const record=yield* self.engine.call(p+'Change.get',{id:change},ctx);
  const implementation=yield* findTerminalFact(self.engine,p+'ChangeImplementationLink','change',change,ctx);
  if(implementation?.decision)yield* self.decision(String(implementation.decision),ctx);
  const ended=yield* findTerminalFact(self.engine,p+'ChangeEnd','change',change,ctx);
  if(ended?.decision)yield* self.decision(String(ended.decision),ctx);
  if(ended?.verification){const verification=yield* self.engine.call(p+'ChangeVerificationLink.get',{id:ended.verification},ctx);const seal=yield* self.engine.call('@forgegraph/foundation/evidence/_/EvidenceSeal.get',{id:verification.support},ctx);yield* new Evidence(self.engine).sealedItems(String(seal.bundle),ctx);}
  const rollback=yield* findTerminalFact(self.engine,p+'ChangeRollback','change',change,ctx);
  const rollbackEnd=rollback?yield* findTerminalFact(self.engine,p+'ChangeEnd','change',String(rollback.rollback),ctx):null;
  if(rollbackEnd?.implementation){const impl=yield* self.engine.call(p+'ChangeImplementationLink.get',{id:rollbackEnd.implementation},ctx);if(impl.decision)yield* self.decision(String(impl.decision),ctx);}
  const supersession=yield* findTerminalFact(self.engine,p+'ChangeSupersession','prior',change,ctx);
  return {change:record,phase:rollback?(rollbackEnd?.outcome==='Completed'?'RolledBack':'RollbackPlanned'):ended?String(ended.outcome):implementation?'Scheduled':'Proposed',implementation,ended,rollback,supersession};
 });}
}
