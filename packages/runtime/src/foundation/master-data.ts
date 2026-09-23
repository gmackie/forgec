import { Effect } from 'effect';
import type { Engine, CallContext } from '../engine.js';
import type { Wire } from '../decode.js';
import { err, type ForgeError } from '../errors.js';
import { Storage } from '../services.js';
import { Decisions } from './decision.js';
const p = '@forgegraph/foundation/master-data/_/';
function valid(condition: unknown, detail: string) { return condition ? Effect.void : Effect.fail(err('ValidationFailed', detail)); }
/** Source-scoped immutable mapping journal. Only validated state() is authoritative. */
export class MasterData {
 constructor(private readonly engine: Engine) {}
 private validateSurvivorship(id: string, ctx: CallContext): Effect.Effect<void, ForgeError> {
  const self = this;
  return Effect.gen(function* () {
   const fact = yield* self.engine.call(p+'SurvivorshipDecision.get',{id},ctx);
   const resolution = yield* self.engine.call(p+'ResolutionCase.get',{id:fact.resolution},ctx);
   const state = yield* new Decisions(self.engine).state(String(fact.decision),ctx);
   yield* valid(state.outcome?.id===fact.outcome && state.terminal?.id===fact.terminal && state.outcome?.selected===fact.option,'Survivorship requires the validated finalized decision');
   yield* valid(state.decisionCase.evaluation===resolution.finish,'Decision must assess the pinned matching evaluation');
   yield* self.engine.call('@forgegraph/foundation/lineage/_/LineageRelation.get',{id:fact.lineage},ctx);
  });
 }
 state(source: string, ctx: CallContext): Effect.Effect<{history: Wire[]; current: Wire|null},ForgeError> {
  const self=this;
  return Effect.gen(function* () {
   yield* self.engine.call(p+'SourceRecord.get',{id:source},ctx);
   const model=self.engine.model.resource(p+'CanonicalLink'),unique=model.uniques.find(u=>u.fields.includes('ordinal'))!;
   const storage=yield* Storage,history:Wire[]=[];
   for(let ordinal=1;ordinal<=128;ordinal++) {
    const values={source,ordinal},key=self.engine.claimKey(model,unique,values)!;
    const row=yield* storage.findUnique(ctx.tenant,model,unique,key,values);
    if(!row)break;
    const link=yield* self.engine.call(p+'CanonicalLink.get',{id:row.id},ctx);
    yield* self.engine.call(p+'CanonicalRecord.get',{id:link.canonical},ctx);
    if(link.survivorship!=null)yield* self.validateSurvivorship(String(link.survivorship),ctx);
    history.push(link);
   }
   return {history,current:history.at(-1)??null};
  }).pipe(Effect.provide(self.engine.layer));
 }
 initialize(source:string,canonical:string,ctx:CallContext) {
  return this.engine.call(p+'CanonicalLink.create',{source,canonical,ordinal:1,previous:null,from:null,kind:'Initial',survivorship:null},ctx);
 }
 merge(source:string,survivorship:string,previous:string,ctx:CallContext):Effect.Effect<Wire,ForgeError> {
  const self=this;
  return Effect.gen(function* () {
   yield* self.validateSurvivorship(survivorship,ctx);
   const fact=yield* self.engine.call(p+'SurvivorshipDecision.get',{id:survivorship},ctx);
   const before=yield* self.engine.call(p+'CanonicalLink.get',{id:previous},ctx);
   return yield* self.engine.call(p+'CanonicalLink.create',{source,canonical:fact.canonical,ordinal:Number(before.ordinal)+1,previous,from:before.canonical,kind:'Merge',survivorship},ctx);
  });
 }
 unmerge(source:string,previous:string,ctx:CallContext):Effect.Effect<Wire,ForgeError> {
  const self=this;
  return Effect.gen(function* () {
   const before=yield* self.engine.call(p+'CanonicalLink.get',{id:previous},ctx);
   yield* valid(before.kind==='Merge','Unmerge requires the current merge event');
   return yield* self.engine.call(p+'CanonicalLink.create',{source,canonical:before.from,ordinal:Number(before.ordinal)+1,previous,from:before.canonical,kind:'Unmerge',survivorship:null},ctx);
  });
 }
}
