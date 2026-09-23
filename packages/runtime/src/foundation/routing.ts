import { Effect } from "effect";
import type { Engine, CallContext } from "../engine.js";
import type { Wire } from "../decode.js";
import { err, type ForgeError } from "../errors.js";
import { Clock } from "../services.js";
import { decodeDatetime } from "../codecs.js";
import { Allocations } from "./allocation.js";
import { Availability } from "./availability.js";
import { Qualifications } from "./qualification.js";
import { findTerminalFact } from "./facts.js";
const p="@forgegraph/foundation/routing/_/",a="@forgegraph/foundation/allocation/_/",f="@forgegraph/foundation/fulfillment/_/",part="@forgegraph/foundation/participation/_/";
const bad=(message:string)=>Effect.fail(err("ValidationFailed",message));
/** Explainable business assignments. Eligibility snapshots are revalidated, never
 * authorization grants; capacity and accepted publication share one transaction. */
export class Routing {
  private readonly allocation:Allocations; private readonly availability:Availability; private readonly qualifications:Qualifications;
  constructor(private readonly engine:Engine){this.allocation=new Allocations(engine);this.availability=new Availability(engine);this.qualifications=new Qualifications(engine);}
  private call(op:string,input:Wire,ctx:CallContext):Effect.Effect<Wire,ForgeError>{return this.engine.call(p+op,input,ctx);}
  private clean(ctx:CallContext){const {idempotencyKey:_receipt,...rest}=ctx;return rest;}
  private now(){return Effect.gen(function*(){return (yield* Clock).now();}).pipe(Effect.provide(this.engine.layer));}
  private facts(candidate:string,ctx:CallContext){const self=this;return Effect.gen(function*(){
    const fact=yield* self.call("RoutingCandidate.get",{id:candidate},ctx),request=yield* self.call("RoutingRequest.get",{id:fact.request},ctx),resource=yield* self.call("RoutingResource.get",{id:fact.resource},ctx);
    yield* self.engine.call(part+"ParticipationSet.get",{id:request.participants},ctx);
    yield* self.engine.call(f+"FulfillmentSet.get",{id:request.fulfillment},ctx);
    yield* self.engine.call(f+"FulfillmentExecutor.get",{id:resource.executor},ctx);
    if(resource.party!=null)yield* self.engine.call("@forgegraph/foundation/party/_/Party.get",{id:resource.party},ctx);
    return {candidate:fact,request,resource};
  });}
  private eligible(request:Wire,resource:Wire,participant:unknown,at:string,ctx:CallContext):Effect.Effect<string,ForgeError>{const self=this;return Effect.gen(function*(){
    if(String(request.until)<=at)return yield* bad("Routing interval has ended");
    const first=yield* self.qualifications.satisfies(String(resource.subject),String(request.requirement),at,ctx);
    const atStart=yield* self.qualifications.satisfies(String(resource.subject),String(request.requirement),String(request.from),ctx);
    const atEnd=yield* self.qualifications.satisfies(String(resource.subject),String(request.requirement),new Date(Date.parse(String(request.until))-1).toISOString(),ctx);
    if(!first.qualified||!atStart.qualified||!atEnd.qualified||first.qualification!==atStart.qualification||first.qualification!==atEnd.qualification)return yield* bad("Candidate is not qualified through the entire requested interval");
    const windows=yield* self.availability.effectiveWindows(String(resource.calendar),String(request.from),String(request.until),ctx);
    if(!windows.windows.some(w=>w.from<=String(request.from)&&w.until>=String(request.until)))return yield* bad("Candidate calendar does not cover requested interval");
    const pool=yield* self.engine.call(a+"AllocationPool.get",{id:resource.pool},ctx);
    if(pool.unit!==request.unit)return yield* bad("Routing pool unit mismatch");
    if(participant!=null){
      const member=yield* self.engine.call(part+"Participation.get",{id:participant},ctx);
      yield* self.engine.call(part+"ParticipationRole.get",{id:member.role},ctx);
      if(member.participationSet!==request.participants||member.participant!==resource.party||String(member.validFrom)>String(request.from)||member.validUntil!=null&&String(member.validUntil)<String(request.until))return yield* bad("Routing participant identity or interval mismatch");
      const end=yield* findTerminalFact(self.engine,part+"ParticipationEnd","participation",member.id,ctx);
      if(end&&String(end.effectiveAt)<String(request.until))return yield* bad("Routing participation ended");
    }
    return first.qualification!;
  });}
  evaluate(input:{request:string;resource:string;participant?:string;rank:number;rationale:string},ctx:CallContext):Effect.Effect<Wire,ForgeError>{const self=this;return Effect.gen(function*(){
    const request=yield* self.call("RoutingRequest.get",{id:input.request},ctx),resource=yield* self.call("RoutingResource.get",{id:input.resource},ctx),at=yield* self.now();
    yield* self.engine.call(part+"ParticipationSet.get",{id:request.participants},ctx);
    yield* self.engine.call(f+"FulfillmentSet.get",{id:request.fulfillment},ctx);
    yield* self.engine.call(f+"FulfillmentExecutor.get",{id:resource.executor},ctx);
    if(resource.party!=null)yield* self.engine.call("@forgegraph/foundation/party/_/Party.get",{id:resource.party},ctx);
    const qualification=yield* self.eligible(request,resource,input.participant??null,at,ctx);
    return yield* self.call("RoutingCandidate.create",{...input,participant:input.participant??null,qualification,evaluatedAt:at},self.clean(ctx));
  });}
  offer(candidate:string,expiresAt:string,ctx:CallContext):Effect.Effect<Wire,ForgeError>{const self=this;return Effect.gen(function*(){
    const facts=yield* self.facts(candidate,ctx),at=yield* self.now();
    if((yield* self.eligible(facts.request,facts.resource,facts.candidate.participant,at,ctx))!==facts.candidate.qualification)return yield* bad("Eligibility snapshot changed");
    const expiry=yield* Effect.try({try:()=>decodeDatetime(expiresAt),catch:()=>err("ValidationFailed","Invalid offer expiry")});
    if(expiry<=at||expiry>String(facts.request.until))return yield* bad("Invalid offer interval");
    return yield* self.call("AssignmentOffer.create",{candidate,offeredAt:at,expiresAt:expiry},self.clean(ctx));
  });}
  accept(offer:string,ctx:CallContext):Effect.Effect<Wire,ForgeError>{const self=this;return Effect.gen(function*(){
    const offered=yield* self.call("AssignmentOffer.get",{id:offer},ctx),facts=yield* self.facts(String(offered.candidate),ctx);
    for(let retry=0;retry<16;retry++){
      const existing=yield* findTerminalFact(self.engine,p+"Assignment","offer",offer,ctx);
      if(existing){yield* self.consume(String(existing.id),ctx);return existing;}
      if(yield* findTerminalFact(self.engine,p+"AssignmentOfferEnd","offer",offer,ctx))return yield* bad("Offer already ended");
      const at=yield* self.now();
      if(String(offered.expiresAt)<=at)return yield* bad("Offer expired");
      if((yield* self.eligible(facts.request,facts.resource,facts.candidate.participant,at,ctx))!==facts.candidate.qualification)return yield* bad("Eligibility snapshot changed");
      // Terminal facts are append-only. Existing future-effective facts cannot
      // change; absent facts need commit-time guards against concurrent insertion.
      const qualificationResource="@forgegraph/foundation/qualification/_/QualificationRevocation";
      const revoked=yield* findTerminalFact(self.engine,qualificationResource,"qualification",facts.candidate.qualification,ctx);
      if(revoked&&(String(revoked.effectiveAt)<=at||String(revoked.effectiveAt)<String(facts.request.until)))return yield* bad("Qualification revoked during acceptance");
      const absent: {resource:string;unique:string;values:Wire}[]=revoked?[]:[{resource:qualificationResource,unique:"qualification",values:{qualification:facts.candidate.qualification}}];
      if(facts.candidate.participant!=null){
        const ended=yield* findTerminalFact(self.engine,part+"ParticipationEnd","participation",facts.candidate.participant,ctx);
        if(ended&&String(ended.effectiveAt)<String(facts.request.until))return yield* bad("Participation ended during acceptance");
        if(!ended)absent.push({resource:part+"ParticipationEnd",unique:"participation",values:{participation:facts.candidate.participant}});
      }
      const key="routing:"+offer;
      const reservation:Wire=yield* self.engine.call(a+"AllocationReservation.create",{pool:facts.resource.pool,key,quantity:facts.request.quantity,unit:facts.request.unit,from:facts.request.from,until:facts.request.until,holdUntil:facts.request.until},self.clean(ctx)).pipe(Effect.catch(error=>error.code==="UniqueConflict"?self.engine.call(a+"AllocationReservation.find.byPoolKey",{params:{pool:facts.resource.pool,key}},ctx):Effect.fail(error)));
      if(reservation.quantity!==facts.request.quantity||reservation.unit!==facts.request.unit||reservation.from!==facts.request.from||reservation.until!==facts.request.until)return yield* bad("Conflicting routing reservation");
      const batch=yield* self.allocation.prepare([{reservation:String(reservation.id),action:"book",commandKey:key}],ctx);
      if(batch.existing.length)continue;
      const result=yield* self.engine.atomic([...batch.mutations,{operation:p+"AssignmentOfferEnd.create",input:{offer,outcome:"accepted",at,reason:"Accepted"}},{operation:p+"Assignment.create",input:{request:facts.request.id,offer,reservation:reservation.id,acceptedAt:at}}],self.clean(ctx),{absent}).pipe(Effect.map(rows=>rows.at(-1)!),Effect.catch(error=>error.code==="UniqueConflict"?Effect.succeed(null):Effect.fail(error)));
      if(result){yield* self.consume(String(result.id),ctx);return result;}
    }
    return yield* Effect.fail(err("TransientConflict","Routing acceptance contention"));
  }).pipe(Effect.catch(error=>{if(!["UniqueConflict","ValidationFailed","TransientConflict"].includes(error.code))return Effect.fail(error);return Effect.gen(function*(){const assignment=yield* findTerminalFact(self.engine,p+"Assignment","offer",offer,ctx);if(!assignment)return yield* Effect.fail(error);yield* self.consume(String(assignment.id),ctx);return assignment;});}));}
  closeOffer(offer:string,outcome:"declined"|"expired",reason:string,ctx:CallContext):Effect.Effect<Wire,ForgeError>{const self=this;return Effect.gen(function*(){
    const row=yield* self.call("AssignmentOffer.get",{id:offer},ctx);yield* self.facts(String(row.candidate),ctx);const at=yield* self.now();
    if(outcome==="expired"&&at<String(row.expiresAt))return yield* bad("Offer is not expired");
    return yield* self.call("AssignmentOfferEnd.create",{offer,outcome,at,reason},self.clean(ctx));
  });}
  private assignment(id:string,ctx:CallContext){const self=this;return Effect.gen(function*(){
    const row=yield* self.call("Assignment.get",{id},ctx),offer=yield* self.call("AssignmentOffer.get",{id:row.offer},ctx),facts=yield* self.facts(String(offer.candidate),ctx);
    const end=yield* findTerminalFact(self.engine,p+"AssignmentOfferEnd","offer",offer.id,ctx),released=yield* findTerminalFact(self.engine,p+"AssignmentEnd","assignment",id,ctx);
    const allocation=yield* self.allocation.reservation(String(row.reservation),ctx);
    if(row.request!==facts.request.id||!end||end.outcome!=="accepted"||String(row.acceptedAt)>=String(offer.expiresAt)||row.acceptedAt!==end.at||allocation.row.pool!==facts.resource.pool||allocation.row.quantity!==facts.request.quantity||allocation.row.from!==facts.request.from||allocation.row.until!==facts.request.until||!allocation.history.some(e=>e.action==="book"&&e.commandKey==="routing:"+offer.id))return yield* bad("Invalid assignment publication");
    if(allocation.phase!==(released?"released":"allocated"))return yield* bad("Assignment disagrees with allocation lifecycle");
    if(released&&!allocation.history.some(e=>e.action==="release"&&e.commandKey==="routing-release:"+id))return yield* bad("Assignment release lacks pool evidence");
    return {row,offer,facts,released};
  });}
  consume(assignment:string,ctx:CallContext):Effect.Effect<Wire,ForgeError>{const self=this;return Effect.gen(function*(){
    const state=yield* self.assignment(assignment,ctx);if(state.released)return yield* bad("Assignment released");
    if((yield* self.eligible(state.facts.request,state.facts.resource,state.facts.candidate.participant,yield* self.now(),ctx))!==state.facts.candidate.qualification)return yield* bad("Assignment eligibility changed");
    return state.row;
  });}
  release(assignment:string,reason:string,ctx:CallContext):Effect.Effect<Wire,ForgeError>{const self=this;return Effect.gen(function*(){
    for(let retry=0;retry<16;retry++){
      const state=yield* self.assignment(assignment,ctx);
      if(state.released)return state.released.reason===reason?state.released:yield* Effect.fail(err("IdempotencyMismatch","Release reason differs"));
      const batch=yield* self.allocation.prepare([{reservation:String(state.row.reservation),action:"release",commandKey:"routing-release:"+assignment}],ctx);if(batch.existing.length)continue;
      const rows=yield* self.engine.atomic([...batch.mutations,{operation:p+"AssignmentEnd.create",input:{assignment,reason,at:yield* self.now()}}],self.clean(ctx)).pipe(Effect.map(rows=>rows.at(-1)!),Effect.catch(error=>error.code==="UniqueConflict"?Effect.succeed(null):Effect.fail(error)));if(rows)return rows;
    }
    return yield* Effect.fail(err("TransientConflict","Routing release contention"));
  }).pipe(Effect.catch(error=>{if(!["ValidationFailed","UniqueConflict","TransientConflict"].includes(error.code))return Effect.fail(error);return Effect.gen(function*(){const state=yield* self.assignment(assignment,ctx);return state.released&&state.released.reason===reason?state.released:yield* Effect.fail(error);});}));}
  attachExecution(assignment:string,fulfillment:string,ctx:CallContext):Effect.Effect<Wire,ForgeError>{const self=this;return Effect.gen(function*(){
    yield* self.consume(assignment,ctx);const state=yield* self.assignment(assignment,ctx),execution=yield* self.engine.call(f+"Fulfillment.get",{id:fulfillment},ctx);
    if(execution.fulfillmentSet!==state.facts.request.fulfillment||execution.executor!==state.facts.resource.executor)return yield* bad("Fulfillment executor or set differs from assignment");
    return yield* self.call("AssignmentExecution.create",{assignment,fulfillment},self.clean(ctx));
  });}
}
