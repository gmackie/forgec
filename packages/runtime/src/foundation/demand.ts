import { Effect } from 'effect';
import type { Engine,CallContext,AtomicMutation } from '../engine.js';
import type { Wire } from '../decode.js';
import { err,type ForgeError } from '../errors.js';
import { formatMinor,toMinor } from '../codecs.js';
import { findTerminalFact } from './facts.js';
import { Allocations } from './allocation.js';
import { Scheduling } from './scheduling.js';
const p='@forgegraph/foundation/demand/_/',sp='@forgegraph/foundation/specification/_/',f='@forgegraph/foundation/fulfillment/_/';
export interface DemandInput {key:string;requester:string;specification:string;constraints:string;origin:'explicit'|'inferred';quantity:string;unit:string;place?:string;from:string;until:string;priority:number;priorityPolicy:string;source:string;support?:string}
export class Demands {
 constructor(private readonly engine:Engine){}
 private call(op:string,input:Wire,ctx:CallContext){return this.engine.call(p+op,input,ctx);}
 private dependencies(row:Wire,ctx:CallContext){const self=this;return Effect.gen(function*(){
  yield* self.engine.call('@forgegraph/foundation/party/_/Party.get',{id:row.requester},ctx);
  for(const id of [row.specification,row.constraints,row.priorityPolicy])yield* self.engine.call(sp+'SpecificationPin.get',{id},ctx);
  if(row.support)yield* self.engine.call('@forgegraph/foundation/evidence/_/EvidenceSeal.get',{id:row.support},ctx);
  if(row.place)yield* self.engine.call('@forgegraph/foundation/place/_/Place.get',{id:row.place},ctx);
 });}
 record(input:DemandInput,ctx:CallContext){const self=this;return Effect.gen(function*(){yield* self.dependencies({...input},ctx);return yield* self.call('Demand.create',{...input,place:input.place??null,support:input.support??null},ctx);});}
 state(demand:string,ctx:CallContext){const self=this;return Effect.gen(function*(){
  const row=yield* self.call('Demand.get',{id:demand},ctx);yield* self.dependencies(row,ctx);
  const resolution=yield* findTerminalFact(self.engine,p+'DemandResolution','demand',demand,ctx);
  return {row,resolution,phase:resolution?String(resolution.outcome):'open'};
 });}
 resolve(demand:string,outcome:'cancelled'|'superseded'|'converted',target:string|null,at:string,reason:string,ctx:CallContext){const self=this;return Effect.gen(function*(){
  const state=yield* self.state(demand,ctx);if(state.resolution)return yield* Effect.fail(err('InvalidTransition','Demand is already resolved'));
  if(outcome==='superseded'&&target)yield* self.state(target,ctx);
  if(outcome==='converted'&&target)yield* self.engine.call(f+'Fulfillment.get',{id:target},ctx);
  return yield* self.call('DemandResolution.create',{demand,outcome,replacement:outcome==='superseded'?target:null,fulfillment:outcome==='converted'?target:null,at,reason,recordedBy:ctx.actor},ctx);
 });}
 /** A group is a view over the original demands, never a new source of quantity. */
 aggregate(group:string,ctx:CallContext):Effect.Effect<{group:Wire;open:Wire[];quantity:string;resolved:Wire[]},ForgeError>{const self=this;return Effect.gen(function*(){
  const row=yield* self.call('DemandGroup.get',{id:group},ctx),open:Wire[]=[],resolved:Wire[]=[];
  let cursor:string|undefined;const seen=new Set<string>();
  do{const page=yield* self.call('DemandGroupMember.list.byGroup',{params:{group},limit:16,...(cursor?{cursor}:{})},ctx);
   for(const member of page.items as Wire[]){if(seen.size>=16)return yield* Effect.fail(err('BudgetExceeded','Demand aggregation supports at most 16 members'));
    const state=yield* self.state(String(member.demand),ctx);if(seen.has(String(state.row.id)))return yield* Effect.fail(err('ValidationFailed','Duplicate demand group member'));seen.add(String(state.row.id));
    for(const field of ['specification','constraints','unit','place','from','until'])if(state.row[field]!==row[field])return yield* Effect.fail(err('ValidationFailed','Incompatible demand aggregation'));
    (state.resolution?resolved:open).push(state.row);
   }cursor=page.next as string|undefined;
  }while(cursor);
  if(seen.size!==row.memberCount)return yield* Effect.fail(err('ValidationFailed','Demand group is incomplete or contains unreadable members'));
  open.sort((a,b)=>Number(b.priority)-Number(a.priority)||String(a.id).localeCompare(String(b.id)));
  return {group:row,open,resolved,quantity:formatMinor(open.reduce((n,r)=>n+toMinor(String(r.quantity),6),0n),6)};
 });}
 /** Publish every selected conversion together; cancellation racing any member aborts all. */
 convertGroup(group:string,targets:ReadonlyArray<{demand:string;fulfillment:string}>,at:string,ctx:CallContext){const self=this;return Effect.gen(function*(){
  const aggregate=yield* self.aggregate(group,ctx);
  if(!targets.length||targets.length!==aggregate.open.length||new Set(targets.map(t=>t.demand)).size!==targets.length||new Set(targets.map(t=>t.fulfillment)).size!==targets.length||targets.some(t=>!aggregate.open.some(r=>r.id===t.demand)))return yield* Effect.fail(err('ValidationFailed','Conversion must cover each open member exactly once'));
  const mutations:AtomicMutation[]=[];
  for(const target of targets){yield* self.engine.call(f+'Fulfillment.get',{id:target.fulfillment},ctx);mutations.push({operation:p+'DemandResolution.create',input:{...target,outcome:'converted',replacement:null,at,reason:'Group conversion',recordedBy:ctx.actor}});}
  return yield* self.engine.atomic(mutations,ctx);
 });}
 allocation(link:string,ctx:CallContext){const self=this;return Effect.gen(function*(){
  const row=yield* self.call('DemandAllocation.get',{id:link},ctx),demand=yield* self.state(String(row.demand),ctx),allocation=yield* new Allocations(self.engine).reservation(String(row.reservation),ctx);
  if(demand.phase==='cancelled'||demand.phase==='superseded')return yield* Effect.fail(err('InvalidTransition','Demand is not fulfillable'));
  return {demand,allocation};
 });}
 schedule(link:string,ctx:CallContext){const self=this;return Effect.gen(function*(){
  const row=yield* self.call('DemandSchedule.get',{id:link},ctx),demand=yield* self.state(String(row.demand),ctx);
  if(demand.resolution?.id!==row.resolution||demand.phase!=='converted')return yield* Effect.fail(err('InvalidTransition','Scheduling requires converted demand'));
  return {demand,appointment:yield* new Scheduling(self.engine).inspect(String(row.appointment),ctx)};
 });}
 route(link:string,ctx:CallContext){const self=this;return Effect.gen(function*(){
  const row=yield* self.call('DemandRoute.get',{id:link},ctx),demand=yield* self.state(String(row.demand),ctx);
  if(demand.resolution?.id!==row.resolution||demand.phase!=='converted')return yield* Effect.fail(err('InvalidTransition','Routing requires converted demand'));
  const request=yield* self.engine.call('@forgegraph/foundation/routing/_/RoutingRequest.get',{id:row.request},ctx);
  return {demand,request};
 });}
}
