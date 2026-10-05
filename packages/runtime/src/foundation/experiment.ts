import {Effect} from 'effect';
import {sha256,type Engine,type CallContext} from '../engine.js';
import type {Wire} from '../decode.js';
import {err,type ForgeError} from '../errors.js';
import {Storage} from '../services.js';
import {Allocations} from './allocation.js';
const p='@forgegraph/foundation/experiment/_/';
function valid(condition:unknown,detail:string){return condition?Effect.void:Effect.fail(err('ValidationFailed',detail));}
export class Experiments {
 constructor(private readonly engine:Engine){}
 private find(name:string,values:Wire,ctx:CallContext):Effect.Effect<Wire|null,ForgeError>{const self=this;return Effect.gen(function*(){
  const resource=self.engine.model.resource(p+name),unique=resource.uniques.find(u=>u.fields.length===Object.keys(values).length&&u.fields.every(f=>Object.hasOwn(values,f)))!;
  const row=yield* (yield* Storage).findUnique(ctx.tenant,resource,unique,self.engine.claimKey(resource,unique,values)!,values);
  return row?yield* self.engine.call(p+name+'.get',{id:row.id},ctx):null;
 }).pipe(Effect.provide(self.engine.layer));}
 state(experiment:string,ctx:CallContext):Effect.Effect<{experiment:Wire;variants:Wire[];events:Wire[];assignments:Wire[];closed:boolean},ForgeError>{const self=this;return Effect.gen(function*(){
  const record=yield* self.engine.call(p+'Experiment.get',{id:experiment},ctx),variants:Wire[]=[],events:Wire[]=[],assignments:Wire[]=[];
  for(let ordinal=0;ordinal<Number(record.variantCount);ordinal++){const variant=yield* self.find('ExperimentVariant',{experiment,ordinal},ctx);yield* valid(variant,'Variant set is incomplete');variants.push(variant!);}
  for(let ordinal=1;ordinal<=128;ordinal++){
   const event=yield* self.find('ExperimentEvent',{experiment,ordinal},ctx);if(!event)break;
   if(event.assignment){const assignment=yield* self.engine.call(p+'ExperimentAssignment.get',{id:event.assignment},ctx);
    if(record.method==='SeededHash'){const digest=yield* Effect.promise(()=>sha256(JSON.stringify([record.seed,assignment.subjectKey])));yield* valid(assignment.variant===variants[parseInt(digest.slice(0,8),16)%variants.length]!.id,'Assignment violates pinned seeded method');}
    if(event.grant){const reservation=yield* self.engine.call('@forgegraph/foundation/allocation/_/AllocationReservation.get',{id:event.reservation},ctx);yield* new Allocations(self.engine).inspect(String(reservation.pool),String(reservation.from),ctx);yield* self.engine.call('@forgegraph/foundation/allocation/_/AllocationJournal.get',{id:event.grant},ctx);}
    assignments.push(assignment);
   }events.push(event);
  }
  return {experiment:record,variants,events,assignments,closed:events.some(e=>e.kind!=='Assigned')};
 });}
 assign(input:{experiment:string;subjectKey:string;provenance:string;variant?:string;participant?:string;reservation?:string},ctx:CallContext):Effect.Effect<Wire,ForgeError>{const self=this;return Effect.gen(function*(){
  let state=yield* self.state(input.experiment,ctx);
  let variant=input.variant;
  if(state.experiment.method==='SeededHash'){const digest=yield* Effect.promise(()=>sha256(JSON.stringify([state.experiment.seed,input.subjectKey])));const selected=String(state.variants[parseInt(digest.slice(0,8),16)%state.variants.length]!.id);yield* valid(!variant||variant===selected,'Requested variant conflicts with seeded method');variant=selected;}
  yield* valid(variant,'Manual assignment requires variant');
  let candidate=yield* self.find('ExperimentAssignment',{experiment:input.experiment,subjectKey:input.subjectKey},ctx);
  if(candidate){yield* valid(candidate.variant===variant&&candidate.provenance===input.provenance&&(candidate.participant??null)===(input.participant??null)&&(candidate.reservation??null)===(input.reservation??null),'Assignment identity reused with different input');if(state.assignments.some(a=>a.id===candidate!.id))return candidate;}
  yield* valid(!state.closed,'Experiment is closed');
  if(!candidate){const created=yield* self.engine.call(p+'ExperimentAssignment.create',{experiment:input.experiment,subjectKey:input.subjectKey,variant,method:state.experiment.method,seed:state.experiment.seed,provenance:input.provenance,participant:input.participant??null,reservation:input.reservation??null},ctx).pipe(Effect.catch(error=>error.code==='UniqueConflict'?self.find('ExperimentAssignment',{experiment:input.experiment,subjectKey:input.subjectKey},ctx):Effect.fail(error)));candidate=created;yield* valid(candidate&&candidate.variant===variant&&candidate.provenance===input.provenance&&(candidate.reservation??null)===(input.reservation??null)&&(candidate.participant??null)===(input.participant??null),'Concurrent assignment differs');}
  let grant:Wire|null=null;
  if(candidate!.reservation){const allocations=new Allocations(self.engine);yield* allocations.act(String(candidate!.reservation),'reserve',{...ctx,idempotencyKey:'experiment-reserve:'+candidate!.id});grant=yield* allocations.act(String(candidate!.reservation),'allocate',{...ctx,idempotencyKey:'experiment-allocate:'+candidate!.id});const reservation=yield* self.engine.call('@forgegraph/foundation/allocation/_/AllocationReservation.get',{id:candidate!.reservation},ctx);const snapshot=yield* allocations.inspect(String(reservation.pool),String(reservation.from),ctx);yield* valid(snapshot.claims.some(c=>c.reservation===candidate!.reservation&&c.phase==='allocated'),'Assignment has no current allocation');}
  for(let retry=0;retry<16;retry++){
   state=yield* self.state(input.experiment,ctx);
   if(state.assignments.some(a=>a.id===candidate!.id))return candidate!;
   yield* valid(!state.closed,'Experiment closed during assignment; allocation remains pending explicit release');
   const {idempotencyKey:_,...commitCtx}=ctx;
   const published=yield* self.engine.call(p+'ExperimentEvent.create',{experiment:input.experiment,ordinal:state.events.length+1,previous:state.events.at(-1)?.id??null,kind:'Assigned',assignment:candidate!.id,reservation:candidate!.reservation??null,grant:grant?.id??null},commitCtx).pipe(Effect.map(()=>true),Effect.catch(error=>error.code==='UniqueConflict'?Effect.succeed(false):Effect.fail(error)));
   if(published)return candidate!;
  }return yield* Effect.fail(err('TransientConflict','Experiment assignment contention'));
 });}
 close(experiment:string,cancelled:boolean,ctx:CallContext):Effect.Effect<Wire,ForgeError>{const self=this;return Effect.gen(function*(){const state=yield* self.state(experiment,ctx);if(state.closed){yield* valid(state.events.at(-1)!.kind===(cancelled?'Cancelled':'Closed'),'Experiment closed with different outcome');return state.events.at(-1)!;}return yield* self.engine.call(p+'ExperimentEvent.create',{experiment,ordinal:state.events.length+1,previous:state.events.at(-1)?.id??null,kind:cancelled?'Cancelled':'Closed',assignment:null,reservation:null,grant:null},ctx);});}
}
