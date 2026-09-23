import {Effect} from 'effect';
import type {Engine,CallContext} from '../engine.js';
import type {Wire} from '../decode.js';
import {err,type ForgeError} from '../errors.js';
import {Storage} from '../services.js';
import {Evidence} from './evidence.js';
const p='@forgegraph/foundation/reconciliation/_/';
export class Reconciliations {
 constructor(private readonly engine:Engine){}
 /** Read complete serialized history; hidden journal entries never imply end. */
 state(scope:string,ctx:CallContext):Effect.Effect<{events:Wire[];latest:Wire|null},ForgeError>{const self=this;return Effect.gen(function*(){
  yield* self.engine.call(p+'ReconciliationScope.get',{id:scope},ctx);
  const resource=self.engine.model.resource(p+'ReconciliationEvent'),unique=resource.uniques.find(u=>u.fields.includes('ordinal'))!;
  const storage=yield* Storage,events:Wire[]=[];
  for(let ordinal=1;ordinal<=128;ordinal++){
   const values={scope,ordinal},key=self.engine.claimKey(resource,unique,values)!;
   const row=yield* storage.findUnique(ctx.tenant,resource,unique,key,values);
   if(!row)break;
   events.push(yield* self.engine.call(resource.id+'.get',{id:row.id},ctx));
  }
  return {events,latest:events.at(-1)??null};
 }).pipe(Effect.provide(self.engine.layer));}
 publish(scope:string,desired:string,kind:'Desired'|'Attempt'|'Result',expectedPrevious:string|null,ctx:CallContext,attempt?:string,result?:string):Effect.Effect<Wire,ForgeError>{const self=this;return Effect.gen(function*(){
  const revision=yield* self.engine.call(p+'DesiredRevision.get',{id:desired},ctx);
  yield* self.engine.call('@forgegraph/foundation/specification/_/SpecificationPin.get',{id:revision.pin},ctx);
  const previous=expectedPrevious?yield* self.engine.call(p+'ReconciliationEvent.get',{id:expectedPrevious},ctx):null;
  return yield* self.engine.call(p+'ReconciliationEvent.create',{scope,desired,desiredSequence:revision.sequence,kind,previous:expectedPrevious,ordinal:previous?Number(previous.ordinal)+1:1,attempt:attempt??null,result:result??null},ctx);
 });}
 recordResult(attempt:string,outcome:'Converged'|'Failed'|'Uncertain',support:string,detail:string,ctx:CallContext):Effect.Effect<Wire,ForgeError>{const self=this;return Effect.gen(function*(){
  const run=yield* self.engine.call(p+'ReconciliationAttempt.get',{id:attempt},ctx);
  const seal=yield* self.engine.call('@forgegraph/foundation/evidence/_/EvidenceSeal.get',{id:support},ctx);
  yield* new Evidence(self.engine).sealedItems(String(seal.bundle),ctx);
  return yield* self.engine.call(p+'ReconciliationResult.create',{attempt,desired:run.desired,outcome,support,detail},ctx);
 });}
 /** Must be called again immediately before a provider operation. A local fence
  * cannot undo an external side effect; providers require their own revision fence. */
 assertCurrent(scope:string,desired:string,expectedEvent:string,ctx:CallContext):Effect.Effect<void,ForgeError>{const self=this;return Effect.gen(function*(){
  const state=yield* self.state(scope,ctx);
  if(state.latest?.id!==expectedEvent||state.latest.desired!==desired)return yield* Effect.fail(err('VersionConflict','Controller observed a stale desired revision or journal fence'));
 });}
}
