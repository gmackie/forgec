import {Effect} from 'effect';
import type {Engine,CallContext} from '../engine.js';
import type {Wire} from '../decode.js';
import {err,type ForgeError} from '../errors.js';
import {Allocations} from './allocation.js';
import {Usage,type UsageInput} from './usage.js';
import {Evidence} from './evidence.js';
import {findTerminalFact} from './facts.js';
const p='@forgegraph/foundation/operations/_/';
export class Operations {
 constructor(private readonly engine:Engine){}
 private chain(name:'PlannedAllocationLink'|'ActualAllocationLink',head:unknown,ctx:CallContext):Effect.Effect<Wire[],ForgeError>{const self=this;return Effect.gen(function*(){const rows:Wire[]=[];while(head!=null){if(rows.length>=16)return yield* Effect.fail(err('ValidationFailed','Operation allocation chain exceeds 16'));const row=yield* self.engine.call(p+name+'.get',{id:head},ctx);rows.push(row);head=row.previous;}return rows;});}
 start(run:string,actual:string|null,ctx:CallContext):Effect.Effect<Wire,ForgeError>{const self=this;return Effect.gen(function*(){
  const record=yield* self.engine.call(p+'OperationRun.get',{id:run},ctx),plans=yield* self.chain('PlannedAllocationLink',record.plans,ctx),grants=yield* self.chain('ActualAllocationLink',actual,ctx);
  for(const plan of plans)yield* self.engine.call(p+'OperationReservationClaim.create',{run,operation:record.operation,planned:plan.id},{...ctx,idempotencyKey:'operation-claim:'+run+':'+plan.id});
  for(const link of grants){if(!plans.some(p=>p.id===link.planned))return yield* Effect.fail(err('ValidationFailed','Actual allocation is outside sealed plan'));const reservation=yield* self.engine.call('@forgegraph/foundation/allocation/_/AllocationReservation.get',{id:link.reservation},ctx);const state=yield* new Allocations(self.engine).inspect(String(reservation.pool),String(reservation.from),ctx);if(!state.claims.some(c=>c.reservation===link.reservation&&c.phase==='allocated'))return yield* Effect.fail(err('InvalidTransition','Actual resource is not allocated'));}
  return yield* self.engine.call(p+'OperationStart.create',{run,actual},ctx);
 });}
 usage(run:string,input:UsageInput,ctx:CallContext):Effect.Effect<Wire,ForgeError>{const self=this;return Effect.gen(function*(){const record=yield* self.engine.call(p+'OperationRun.get',{id:run},ctx);if(record.usageStream!==input.stream||record.usageSource!==input.source)return yield* Effect.fail(err('ValidationFailed','Usage source or stream differs from run'));const event=yield* new Usage(self.engine).ingest(input,ctx);return yield* self.engine.call(p+'OperationUsageLink.create',{run,event:event.id},{...ctx,idempotencyKey:JSON.stringify(['operation-usage',run,event.id])});});}
 end(run:string,outcome:'Completed'|'Failed'|'Cancelled',reason:string,ctx:CallContext,evaluation?:string):Effect.Effect<Wire,ForgeError>{const self=this;return Effect.gen(function*(){
  yield* self.state(run,ctx);
  const start=yield* findTerminalFact(self.engine,p+'OperationStart','run',run,ctx);if(!start)return yield* Effect.fail(err('InvalidTransition','Run must start before ending'));
  if(evaluation){const link=yield* self.engine.call(p+'OperationEvaluationLink.get',{id:evaluation},ctx),seal=yield* self.engine.call('@forgegraph/foundation/evidence/_/EvidenceSeal.get',{id:link.support},ctx);yield* new Evidence(self.engine).sealedItems(String(seal.bundle),ctx);}
  const ended=yield* self.engine.call(p+'OperationEnd.create',{run,start:start.id,outcome,evaluation:evaluation??null,reason},ctx);
  yield* self.cleanup(String(ended.id),ctx);return ended;
 });}
 cleanup(ended:string,ctx:CallContext):Effect.Effect<Wire,ForgeError>{const self=this;return Effect.gen(function*(){
  const end=yield* self.engine.call(p+'OperationEnd.get',{id:ended},ctx),record=yield* self.engine.call(p+'OperationRun.get',{id:end.run},ctx),plans=yield* self.chain('PlannedAllocationLink',record.plans,ctx),allocations=new Allocations(self.engine);
  const existing=yield* findTerminalFact(self.engine,p+'OperationCleanup','ended',ended,ctx);
  for(const plan of plans){const owner=yield* findTerminalFact(self.engine,p+'OperationReservationClaim','planned',plan.id,ctx);if(owner?.run!==end.run)return yield* Effect.fail(err('ValidationFailed','Reservation is not claimed by this run'));const reservation=yield* self.engine.call('@forgegraph/foundation/allocation/_/AllocationReservation.get',{id:plan.reservation},ctx),snapshot=yield* allocations.inspect(String(reservation.pool),String(reservation.from),ctx),claim=snapshot.claims.find(c=>c.reservation===plan.reservation);if(claim)yield* allocations.act(String(plan.reservation),claim.phase==='allocated'?'release':'cancel',{...ctx,idempotencyKey:'operation-release:'+plan.reservation});}
  if(existing)return existing;
  return yield* self.engine.call(p+'OperationCleanup.create',{ended,reason:'Selected plan reservations released or inactive'},{...ctx,idempotencyKey:'operation-cleanup:'+ended});
 });}
 state(run:string,ctx:CallContext):Effect.Effect<{phase:string;cleanupPending:boolean},ForgeError>{const self=this;return Effect.gen(function*(){
  const record=yield* self.engine.call(p+'OperationRun.get',{id:run},ctx),start=yield* findTerminalFact(self.engine,p+'OperationStart','run',run,ctx),plans=yield* self.chain('PlannedAllocationLink',record.plans,ctx);
  const ended=yield* findTerminalFact(self.engine,p+'OperationEnd','run',run,ctx);let active=false;
  if(start){
   for(const plan of plans){const owner=yield* findTerminalFact(self.engine,p+'OperationReservationClaim','planned',plan.id,ctx);if(owner?.run!==run)return yield* Effect.fail(err('ValidationFailed','Run lacks exclusive plan ownership'));const reservation=yield* self.engine.call('@forgegraph/foundation/allocation/_/AllocationReservation.get',{id:plan.reservation},ctx),snapshot=yield* new Allocations(self.engine).inspect(String(reservation.pool),String(reservation.from),ctx);active ||= snapshot.claims.some(c=>c.reservation===plan.reservation);}
   for(const actual of yield* self.chain('ActualAllocationLink',start.actual,ctx)){if(!plans.some(p=>p.id===actual.planned))return yield* Effect.fail(err('ValidationFailed','Actual grant outside sealed plan'));yield* self.engine.call('@forgegraph/foundation/allocation/_/AllocationJournal.get',{id:actual.grant},ctx);}
  }
  if(ended){if(ended.evaluation){const evaluation=yield* self.engine.call(p+'OperationEvaluationLink.get',{id:ended.evaluation},ctx),seal=yield* self.engine.call('@forgegraph/foundation/evidence/_/EvidenceSeal.get',{id:evaluation.support},ctx);yield* new Evidence(self.engine).sealedItems(String(seal.bundle),ctx);}return {phase:String(ended.outcome),cleanupPending:active||!(yield* findTerminalFact(self.engine,p+'OperationCleanup','ended',ended.id,ctx))};}
  return {phase:start?'Running':'Planned',cleanupPending:false};
 });}
}
