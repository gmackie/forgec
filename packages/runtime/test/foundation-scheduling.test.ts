import { Effect } from "effect";
import { expect, it } from "vitest";
import { foundation, foundationAdapters } from "./helpers/foundation.js";
import { Scheduling } from "../src/foundation/scheduling.js";
import { Availability } from "../src/foundation/availability.js";
import { Allocations } from "../src/foundation/allocation.js";
import { Fulfillments } from "../src/foundation/fulfillment.js";
import { err } from "../src/errors.js";
import { Engine } from "../src/engine.js";
import { localAuthorizer } from "../src/gatekeeper.js";
const p = "@forgegraph/foundation/scheduling/_/", a = "@forgegraph/foundation/allocation/_/";
for (const adapter of foundationAdapters) it(`${adapter}: calendar intersection and atomic multi-pool booking/reschedule/cancel`, async () => {
  const f = await foundation("scheduling", adapter, true), run = Effect.runPromise;
  try {
    const {engine,ctx,call}=f, service=new Scheduling(engine), availability=new Availability(engine), allocations=new Allocations(engine);
    const participants=await call("@forgegraph/foundation/participation/_/ParticipationSet.create",{label:"Attendees"});
    const party=await call("@forgegraph/foundation/party/_/Party.create",{label:"Technician"});
    const role=await call("@forgegraph/foundation/participation/_/ParticipationRole.create",{namespace:"service",name:"technician"});
    const membership=await call("@forgegraph/foundation/participation/_/Participation.create",{participationSet:participants.id,participant:party.id,role:role.id,validFrom:"2026-01-01T00:00:00Z",validUntil:null,recordedBy:ctx.actor,reason:"Assigned"});
    const ids=await call("@forgegraph/foundation/identifiers/_/IdentifierSet.create",{label:"Room"});
    const place=await call("@forgegraph/foundation/place/_/Place.create",{identifiers:ids.id,name:"Room"});
    const fulfillment=await call("@forgegraph/foundation/fulfillment/_/FulfillmentSet.create",{label:"Visit delivery"});
    const pool=async(key:string)=>call(a+"AllocationPool.create",{key,mode:"exclusive",capacity:"1",unit:"slot"});
    const person=await pool("person"),room=await pool("room"),lab=await pool("lab");
    const calendar=async(label:string,timezone:string,startMinute:number,endMinute:number)=>{
      const c=await run(availability.createCalendar(label,ctx));
      return run(availability.createRevision({calendar:String(c.id),timezone,weekly:[{weekday:5,startMinute,endMinute}]},ctx));
    };
    const eastern=await calendar("Technician","America/New_York",9*60,17*60),utc=await calendar("Room","UTC",14*60,18*60);
    const requirement=await run(service.requirement({key:"visit",durationMinutes:60,participants:String(participants.id),place:String(place.id),needs:[{pool:String(person.id),calendar:String(eastern.id),quantity:"1",participant:String(membership.id)},{pool:String(room.id),calendar:String(utc.id),quantity:"1"}]},ctx));
    const windows=await run(service.search(String(requirement.id),"2026-01-02T00:00:00Z","2026-01-03T00:00:00Z",ctx));
    expect(windows).toEqual([{from:"2026-01-02T14:00:00.000Z",until:"2026-01-02T18:00:00.000Z"}]);
    await expect(run(service.slot(String(requirement.id),"2026-01-02T13:00:00Z",ctx))).rejects.toThrow();
    const slot=await run(service.slot(String(requirement.id),"2026-01-02T14:00:00Z",ctx));
    // Crash before publication leaves an inert durable intent, safely resumable.
    const intent=await call(p+"Appointment.create",{key:"visit-a",slot:slot.id,fulfillment:fulfillment.id,predecessor:null});
    expect((await run(service.inspect(String(intent.id),ctx))).commit).toBeNull();
    expect((await run(allocations.inspect(String(room.id),String(slot.from),ctx))).available).toBe("1.000000");
    const sameKey = await Promise.allSettled(Array.from({length:4},()=>run(service.book({key:"visit-a",slot:String(slot.id),fulfillment:String(fulfillment.id)},ctx))));
    expect(sameKey.filter(r=>r.status==="fulfilled"), JSON.stringify(sameKey.filter(r=>r.status==="rejected"))).toHaveLength(4);
    const first=(sameKey[0] as PromiseFulfilledResult<Record<string,unknown>>).value;
    expect(first.id).toBe(intent.id);
    expect((await run(service.book({key:"visit-a",slot:String(slot.id),fulfillment:String(fulfillment.id)},ctx))).id).toBe(first.id);
    expect((await run(allocations.inspect(String(person.id),String(slot.from),ctx))).available).toBe("0.000000");
    // Failed last-pool claim never acquires an earlier independent pool.
    const labRequirement=await run(service.requirement({key:"lab",durationMinutes:60,participants:String(participants.id),place:String(place.id),needs:[{pool:String(lab.id),calendar:String(utc.id),quantity:"1"},{pool:String(room.id),calendar:String(utc.id),quantity:"1"}]},ctx));
    const labSlot=await run(service.slot(String(labRequirement.id),String(slot.from),ctx));
    await expect(run(service.book({key:"conflict",slot:String(labSlot.id),fulfillment:String(fulfillment.id)},ctx))).rejects.toThrow();
    expect((await run(allocations.inspect(String(lab.id),String(slot.from),ctx))).available).toBe("1.000000");
    // A competing booking makes reschedule fail, retaining both original pools.
    const later=await run(service.slot(String(requirement.id),"2026-01-02T15:00:00Z",ctx));
    const other=await run(service.book({key:"other",slot:String(later.id),fulfillment:String(fulfillment.id)},ctx));
    await expect(run(service.book({key:"move-fail",slot:String(later.id),fulfillment:String(fulfillment.id),predecessor:String(first.id)},ctx))).rejects.toThrow();
    expect((await run(service.inspect(String(first.id),ctx))).end).toBeNull();
    expect((await run(allocations.inspect(String(person.id),String(slot.from),ctx))).available).toBe("0.000000");
    await run(service.cancel(String(other.id),"Free slot",ctx));
    const moved=await run(service.book({key:"move",slot:String(later.id),fulfillment:String(fulfillment.id),predecessor:String(first.id)},ctx));
    expect((await run(service.inspect(String(first.id),ctx))).end?.replacement).toBe(moved.id);
    expect((await run(allocations.inspect(String(person.id),String(slot.from),ctx))).available).toBe("1.000000");
    expect((await run(allocations.inspect(String(room.id),String(later.from),ctx))).available).toBe("0.000000");
    const restarted=new Scheduling(new Engine(engine.model,engine.layer));
    expect((await run(restarted.book({key:"move",slot:String(later.id),fulfillment:String(fulfillment.id),predecessor:String(first.id)},ctx))).id).toBe(moved.id);
    for(const name of ["FieldVisit","LabBooking","ClassroomBooking"]) await call("@foundation-probe/scheduling-consumers/_/"+name+".create",{appointment:moved.id});
    const executor=await call("@forgegraph/foundation/fulfillment/_/FulfillmentExecutor.create",{key:"technician"});
    const execution=await call("@forgegraph/foundation/fulfillment/_/Fulfillment.create",{fulfillmentSet:fulfillment.id,ordinal:1,specificationPin:null,executor:executor.id,requestedAt:"2026-01-02T15:00:00Z",evidence:null});
    const executions=new Fulfillments(engine);
    await run(executions.start(String(execution.id),"2026-01-02T15:00:00Z",ctx));
    await run(executions.finish(String(execution.id),"completed","complete","2026-01-02T16:00:00Z","Delivered visit",ctx));
    const cancelled=await run(restarted.cancel(String(moved.id),"Cancelled",ctx));
    expect((await run(restarted.cancel(String(moved.id),"Cancelled",ctx))).id).toBe(cancelled.id);
    expect((await run(allocations.inspect(String(room.id),String(later.from),ctx))).available).toBe("1.000000");
    // Commit succeeds but response is lost; retry resumes from durable publication.
    const crashSlot=await run(service.slot(String(requirement.id),"2026-01-02T16:00:00Z",ctx));
    const atomic=engine.atomic.bind(engine);
    engine.atomic=(mutations,context)=>atomic(mutations,context).pipe(Effect.flatMap(()=>Effect.fail(err("StorageUnavailable","simulated lost response"))));
    await expect(run(service.book({key:"lost-response",slot:String(crashSlot.id),fulfillment:String(fulfillment.id)},ctx))).rejects.toMatchObject({code:"StorageUnavailable"});
    engine.atomic=atomic;
    const recovered=await run(restarted.book({key:"lost-response",slot:String(crashSlot.id),fulfillment:String(fulfillment.id)},ctx));
    expect((await run(restarted.inspect(String(recovered.id),ctx))).reservations).toHaveLength(2);
    const releases=await Promise.allSettled(Array.from({length:3},()=>run(restarted.cancel(String(recovered.id),"Recovered",ctx))));
    expect(releases.filter(r=>r.status==="fulfilled"), JSON.stringify(releases.filter(r=>r.status==="rejected"))).toHaveLength(3);
    // Competing appointments sharing a pool: exactly one full group wins.
    const race=await Promise.allSettled([run(service.book({key:"race-a",slot:String(slot.id),fulfillment:String(fulfillment.id)},ctx)),run(service.book({key:"race-b",slot:String(labSlot.id),fulfillment:String(fulfillment.id)},ctx))]);
    expect(race.filter(r=>r.status==="fulfilled")).toHaveLength(1);
    const winner=(race.find(r=>r.status==="fulfilled") as PromiseFulfilledResult<Record<string,unknown>>).value;
    const projected=await run(service.inspect(String(winner.id),ctx));expect(projected.reservations).toHaveLength(2);
    const denied=new Engine(engine.model,engine.layer);
    denied.gatekeeper.authorizer=localAuthorizer({policies:[],pips:[],epoch:1,knownObligations:[]});
    await expect(run(new Scheduling(denied).cancel(String(winner.id),"Denied",ctx))).rejects.toThrow();
    await expect(run(service.inspect(String(winner.id),{...ctx,tenant:"other"}))).rejects.toThrow();
    const hidden=new Engine(engine.model,engine.layer);
    hidden.gatekeeper.authorizer=localAuthorizer({policies:engine.model.resources.filter(r=>r.id!==p+"AppointmentEnd").map(r=>({id:r.id,actions:[r.id+".*"],requires:[],where:[]})),pips:[],epoch:1,knownObligations:[]});
    await expect(run(new Scheduling(hidden).inspect(String(moved.id),ctx))).rejects.toMatchObject({code:"NotFound"});
    await call("@forgegraph/foundation/participation/_/ParticipationEnd.create",{participation:membership.id,effectiveAt:"2026-01-02T00:00:00Z",revoked:true,recordedBy:ctx.actor,reason:"Unavailable"});
    await expect(run(service.slot(String(requirement.id),"2026-01-02T16:00:00Z",ctx))).rejects.toThrow();
    // A raw seal cannot adopt another appointment's allocation.
    const malicious=await call(p+"Appointment.create",{key:"malicious",slot:winner.slot,fulfillment:fulfillment.id,predecessor:null});
    let head:string|null=null;
    for(const reservation of projected.reservations){ const node=await call(p+"AppointmentReservation.create",{appointment:malicious.id,reservation:reservation.id,next:head});head=String(node.id); }
    await call(p+"AppointmentCommit.create",{appointment:malicious.id,head});
    await expect(run(service.inspect(String(malicious.id),ctx))).rejects.toMatchObject({code:"ValidationFailed"});
  } finally {await f.close();}
});
