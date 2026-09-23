import { Effect } from "effect";
import { expect, it } from "vitest";
import { foundation, foundationAdapters } from "./helpers/foundation.js";
import { Routing } from "../src/foundation/routing.js";
import { Availability } from "../src/foundation/availability.js";
import { Qualifications } from "../src/foundation/qualification.js";
import { Allocations } from "../src/foundation/allocation.js";
import { Engine } from "../src/engine.js";
import { localAuthorizer } from "../src/gatekeeper.js";
const p="@forgegraph/foundation/routing/_/",q="@forgegraph/foundation/qualification/_/",a="@forgegraph/foundation/allocation/_/",f="@forgegraph/foundation/fulfillment/_/",party="@forgegraph/foundation/party/_/",part="@forgegraph/foundation/participation/_/",spec="@forgegraph/foundation/specification/_/";
for(const adapter of foundationAdapters)it(`${adapter}: explainable eligibility, atomic offers, revocation race and repair`,async()=>{
 const h=await foundation("routing",adapter,true),run=Effect.runPromise;try{
  const {engine,ctx,call}=h,service=new Routing(engine),qualifications=new Qualifications(engine),availability=new Availability(engine),allocations=new Allocations(engine);
  const repository=await call(spec+"Repository.create",{key:"requirements",provider:"git",locator:"https://example.test/spec"});
  const pin=await call(spec+"SpecificationPin.create",{repository:repository.id,anchor:"skill",revision:"a".repeat(40)});
  const definition=await call(q+"QualificationDefinition.create",{key:"skill",pin:pin.id,label:"Skill"});
  const requirement=await call(q+"QualificationRequirement.create",{definition:definition.id,minimumLevel:null});
  const issuer=await call(party+"Party.create",{label:"Issuer"}),participants=await call(part+"ParticipationSet.create",{label:"Resources"});
  const role=await call(part+"ParticipationRole.create",{namespace:"routing",name:"assignee"});
  const calendar=await run(availability.createCalendar("Office",ctx));
  const revision=await run(availability.createRevision({calendar:String(calendar.id),timezone:"America/New_York",weekly:[{weekday:5,startMinute:9*60,endMinute:17*60}]},ctx));
  const from="2026-01-02T14:00:00.000Z",until="2026-01-02T15:00:00.000Z";
  const resources=[];
  for(const name of ["SupportAgent","Technician","Reviewer","BobRunner"]){
   const subject=await call(q+"QualificationSubject.create",{label:name}),owner=await call(party+"Party.create",{label:name});
   const executor=await call(f+"FulfillmentExecutor.create",{key:name});
   const pool=await call(a+"AllocationPool.create",{key:name,mode:"exclusive",capacity:"1",unit:"slot"});
   const member=await call(part+"Participation.create",{participationSet:participants.id,participant:owner.id,role:role.id,validFrom:"2026-01-01T00:00:00Z",validUntil:null,recordedBy:ctx.actor,reason:"Eligible resource"});
   const resource=await call(p+"RoutingResource.create",{key:name,subject:subject.id,party:owner.id,executor:executor.id,pool:pool.id,calendar:revision.id});
   await call("@foundation-probe/routing-consumers/_/"+name+".create",{resource:resource.id});
   const award=await run(qualifications.award({subject:String(subject.id),definition:String(definition.id),issuer:String(issuer.id),issuerRecord:name,issuedAt:"2026-01-01T00:00:00Z",expiresAt:"2026-02-01T00:00:00Z"},ctx));
   resources.push({resource,member,award,pool,executor});
  }
  const newRequest=async(key:string)=>{const set=await call(f+"FulfillmentSet.create",{label:key});return call(p+"RoutingRequest.create",{key,requirement:requirement.id,participants:participants.id,fulfillment:set.id,from,until,quantity:"1",unit:"slot"});};
  const request=await newRequest("support"),first=resources[0]!;
  const candidate=await run(service.evaluate({request:String(request.id),resource:String(first.resource.id),participant:String(first.member.id),rank:1,rationale:"Pinned skill, matching office window and dedicated pool"},ctx));
  expect(candidate.qualification).toBe(first.award.id);
  const offer=await run(service.offer(String(candidate.id),"2026-01-01T12:00:00Z",ctx));
  const accepted=await Promise.allSettled(Array.from({length:3},()=>run(service.accept(String(offer.id),ctx))));
  expect(accepted.filter(r=>r.status==="fulfilled"),JSON.stringify(accepted)).toHaveLength(3);
  const assignment=(accepted[0] as PromiseFulfilledResult<Record<string,unknown>>).value;
  expect((await run(allocations.inspect(String(first.pool.id),from,ctx))).available).toBe("0.000000");
  const execution=await call(f+"Fulfillment.create",{fulfillmentSet:request.fulfillment,ordinal:1,executor:first.executor.id,specificationPin:null,requestedAt:from,evidence:null});
  await run(service.attachExecution(String(assignment.id),String(execution.id),ctx));
  const rivalRequest=await newRequest("rival"),rival=await run(service.evaluate({request:String(rivalRequest.id),resource:String(first.resource.id),rank:0,rationale:"Same pool"},ctx));
  const rivalOffer=await run(service.offer(String(rival.id),"2026-01-01T12:00:00Z",ctx));
  await expect(run(service.accept(String(rivalOffer.id),ctx))).rejects.toThrow();
  await run(service.closeOffer(String(rivalOffer.id),"declined","Already busy",ctx));
  await expect(run(service.accept(String(rivalOffer.id),ctx))).rejects.toThrow();
  const restarted=new Routing(new Engine(engine.model,engine.layer));expect((await run(restarted.consume(String(assignment.id),ctx))).id).toBe(assignment.id);
  const releases=await Promise.allSettled(Array.from({length:3},()=>run(service.release(String(assignment.id),"Complete",ctx))));expect(releases.filter(r=>r.status==="fulfilled"),JSON.stringify(releases)).toHaveLength(3);
  // Distinct offers for one request cannot accept twice, even with distinct pools.
  const compete=await newRequest("compete"),offers=[];
  for(const resource of resources.slice(1,3)){const c=await run(service.evaluate({request:String(compete.id),resource:String(resource.resource.id),rank:1,rationale:"Qualified candidate"},ctx));offers.push(await run(service.offer(String(c.id),"2026-01-01T12:00:00Z",ctx)));}
  const raced=await Promise.allSettled(offers.map(o=>run(service.accept(String(o.id),ctx))));expect(raced.filter(r=>r.status==="fulfilled")).toHaveLength(1);
  const winner=(raced.find(r=>r.status==="fulfilled") as PromiseFulfilledResult<Record<string,unknown>>).value;await run(service.release(String(winner.id),"Done",ctx));
  for(const resource of resources.slice(1,3))expect((await run(allocations.inspect(String(resource.pool.id),from,ctx))).available).toBe("1.000000");
  // Revocation between validation and commit is not concealed: consumption fails,
  // and a separate durable release repairs reserved capacity without eligibility.
  const runner=resources[3]!,runnerRequest=await newRequest("runner"),runnerCandidate=await run(service.evaluate({request:String(runnerRequest.id),resource:String(runner.resource.id),rank:1,rationale:"Bob Runner capability evidence"},ctx));
  const runnerOffer=await run(service.offer(String(runnerCandidate.id),"2026-01-01T12:00:00Z",ctx));
  const atomic=engine.atomic.bind(engine);let revoked=false;
  engine.atomic=(mutations,context)=>Effect.gen(function*(){if(!revoked){revoked=true;yield* qualifications.revoke(String(runner.award.id),"2026-01-01T00:00:00Z","Revoked during accept",ctx);}return yield* atomic(mutations,context);});
  await expect(run(service.accept(String(runnerOffer.id),ctx))).rejects.toThrow();engine.atomic=atomic;
  const stale=await call(p+"Assignment.find.byOffer",{params:{offer:runnerOffer.id}});
  await expect(run(service.consume(String(stale.id),ctx))).rejects.toThrow();
  expect((await run(allocations.inspect(String(runner.pool.id),from,ctx))).available).toBe("0.000000");
  await run(service.release(String(stale.id),"Eligibility invalidated",ctx));
  expect((await run(allocations.inspect(String(runner.pool.id),from,ctx))).available).toBe("1.000000");
  await expect(run(service.evaluate({request:String(runnerRequest.id),resource:String(runner.resource.id),rank:1,rationale:"Stale"},ctx))).rejects.toThrow();
  const expiryRequest=await newRequest("expiry"),expiryCandidate=await run(service.evaluate({request:String(expiryRequest.id),resource:String(first.resource.id),rank:1,rationale:"Fresh"},ctx));
  const expired=await run(service.offer(String(expiryCandidate.id),"2026-01-01T00:05:00Z",ctx));
  await expect(run(service.closeOffer(String(expired.id),"expired","Too soon",ctx))).rejects.toThrow();
  engine.atomic=(mutations,context)=>Effect.gen(function*(){engine.testClockJump(10*60*1000);yield* service.closeOffer(String(expired.id),"expired","Expired during acceptance",ctx);return yield* atomic(mutations,context);});
  await expect(run(service.accept(String(expired.id),ctx))).rejects.toThrow();engine.atomic=atomic;
  expect((await run(allocations.inspect(String(first.pool.id),from,ctx))).available).toBe("1.000000");
  await expect(run(service.accept(String(expired.id),ctx))).rejects.toThrow();
  const hidden=new Engine(engine.model,engine.layer);hidden.gatekeeper.authorizer=localAuthorizer({policies:engine.model.resources.filter(r=>r.id!==q+"QualificationRevocation").map(r=>({id:r.id,actions:[r.id+".*"],requires:[],where:[]})),pips:[],epoch:1,knownObligations:[]});
  await expect(run(new Routing(hidden).evaluate({request:String(runnerRequest.id),resource:String(runner.resource.id),rank:1,rationale:"Hidden revocation"},ctx))).rejects.toThrow();
  await expect(run(service.consume(String(assignment.id),{...ctx,tenant:"foreign"}))).rejects.toThrow();
 }finally{await h.close();}
});
