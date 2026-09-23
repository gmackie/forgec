import { Effect } from "effect";
import { expect, it } from "vitest";
import { foundation, foundationAdapters } from "./helpers/foundation.js";
import { Engine } from "../src/engine.js";
import { localAuthorizer } from "../src/gatekeeper.js";
const p = "@forgegraph/foundation/allocation/_/";
for (const adapter of foundationAdapters) it(`${adapter}: authorized atomic last-plan unique conflict rolls back all pool journals`, async () => {
  const f = await foundation("allocation", adapter, true), run = Effect.runPromise;
  try {
    const {engine, ctx, call} = f;
    const pool = (key: string) => call(p + "AllocationPool.create", {key, mode:"exclusive",capacity:"1",unit:"slot"});
    const a = await pool("a"), b = await pool("b");
    const reservation = (pool: unknown,key:string) => call(p+"AllocationReservation.create",{pool,key,quantity:"1",unit:"slot",from:"2026-01-02T00:00:00Z",until:"2026-01-03T00:00:00Z",holdUntil:"2026-01-01T12:00:00Z"});
    const ar = await reservation(a.id,"a"), br = await reservation(b.id,"b");
    const journal = (pool:unknown,reservation:unknown,commandKey:string) => ({operation:p+"AllocationJournal.create",input:{pool,reservation,commandKey,ordinal:1,previous:null,action:"reserve",at:"2026-01-01T00:00:00Z"}});
    const results = await Promise.allSettled([run(engine.atomic([journal(a.id,ar.id,"A"),journal(b.id,br.id,"A")],ctx)),run(engine.atomic([journal(a.id,ar.id,"B"),journal(b.id,br.id,"B")],ctx))]);
    expect(results.filter(r=>r.status === "fulfilled")).toHaveLength(1);
    expect((await call(p+"AllocationJournal.list.byPool",{params:{pool:a.id}})).items).toHaveLength(1);
    const c=await pool("c"), cr=await reservation(c.id,"c");
    await expect(run(engine.atomic([journal(c.id,cr.id,"C"),journal(b.id,br.id,"conflict")],ctx))).rejects.toThrow();
    expect((await call(p+"AllocationJournal.list.byPool",{params:{pool:c.id}})).items).toHaveLength(0);
    await call(p+"AllocationJournal.create",journal(c.id,cr.id,"C").input);
    const denied = new Engine(engine.model,engine.layer);
    denied.gatekeeper.authorizer=localAuthorizer({policies:[],pips:[],epoch:1,knownObligations:[]});
    await expect(run(denied.atomic([{operation:p+"AllocationPool.create",input:{key:"denied",mode:"exclusive",capacity:"1",unit:"slot"}}],ctx))).rejects.toThrow();
    await expect(run(engine.atomic([{operation:p+"AllocationPool.delete",input:{id:a.id}}],ctx))).rejects.toThrow();
    await expect(run(engine.atomic([journal(c.id,cr.id,"receipt")],{...ctx,idempotencyKey:"unsupported"}))).rejects.toThrow();
  } finally {await f.close();}
});

// Actual purpose-scoped application bundle exercises the same attenuation as call().
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Model, type AppBundle } from "../src/model.js";
import { MemoryStorage } from "../src/adapters/memory.js";
import { testLayer } from "../src/testing.js";
it("atomic preserves purpose projection, write fence, suppression and budget before commit", async () => {
  const bundle=JSON.parse(readFileSync(resolve(import.meta.dirname,"../../../conformance/fixtures/acme-next.app.json"),"utf8")) as AppBundle;
  const storage=new MemoryStorage(),engine=new Engine(new Model(bundle),testLayer(storage)),run=Effect.runPromise;
  const n="@acme/commerce-next/_/",g="@acme/governance/_/",ctx={tenant:"t",actor:"operator",requestId:"atomic"},seed={...ctx,maintenance:true};
  const customer=await run(engine.call(n+"Customer.create",{code:"CUS",name:"Customer"},seed));
  const contact=await run(engine.call(n+"Contact.create",{customer:customer.id,name:"A",email:"a@example.com",supportNotes:"secret"},seed));
  await expect(run(engine.atomic([{operation:n+"Contact.update",input:{id:contact.id,expectedVersion:1,patch:{supportNotes:"changed"}}}],{...ctx,purpose:g+"ParentCommunication"}))).rejects.toMatchObject({code:"NotPermitted"});
  const result=await run(engine.atomic([{operation:n+"Contact.update",input:{id:contact.id,expectedVersion:1,patch:{email:"b@example.com"}}}],{...ctx,purpose:g+"CustomerSupport"}));
  expect(result[0]).toMatchObject({email:"b@example.com"});
  expect(Object.keys(result[0]!).sort()).toEqual(["customer","email","id","name","supportNotes","version"]);
  await run(storage.putDocument(ctx.tenant,"admin","fence",{on:true},null));
  await expect(run(engine.atomic([{operation:n+"Contact.update",input:{id:contact.id,expectedVersion:2,patch:{name:"Fenced"}}}],seed))).rejects.toMatchObject({code:"WriteFenced"});
  await run(storage.putDocument(ctx.tenant,"admin","fence",{on:false},1));
  const before=await storage.dump(ctx.tenant);
  const budget=storage.budget.bind(storage);storage.budget=()=>({actions:101,limit:100});
  await expect(run(engine.atomic([{operation:n+"Contact.update",input:{id:contact.id,expectedVersion:2,patch:{name:"Over budget"}}}],seed))).rejects.toMatchObject({code:"BudgetExceeded"});
  expect(await storage.dump(ctx.tenant)).toEqual(before);storage.budget=budget;
  const subject=engine.suppression.subjectOf(engine.model.resource(n+"Contact"),contact);
  expect(subject).not.toBeNull();
  await run(engine.suppression.record(ctx.tenant,subject!,{kind:"restricted",reason:"Privacy",at:"2026-01-01T00:00:00Z",epoch:1}).pipe(Effect.provide(engine.layer)));
  await expect(run(engine.atomic([{operation:n+"Contact.update",input:{id:contact.id,expectedVersion:2,patch:{name:"Suppressed"}}}],seed))).rejects.toMatchObject({code:"Suppressed"});
});
