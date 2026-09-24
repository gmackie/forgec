import { featureAdapters, featureStorage, unavailable } from "./helpers/feature-storage.js";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Effect } from "effect";
import { expect, it } from "vitest";
import { Engine } from "../src/engine.js";
import { Model, type AppBundle } from "../src/model.js";
import { MemoryStorage } from "../src/adapters/memory.js";
import { testLayer } from "../src/testing.js";
const bundle = JSON.parse(readFileSync(resolve(import.meta.dirname,"../../../conformance/fixtures/issue-numbers/app.json"),"utf8")) as AppBundle;
const model = new Model(bundle);
const prefix = "@dogfood/issues/_/";
for (const adapter of featureAdapters) it.skipIf(unavailable(adapter))(`${adapter}: reserves unique partition numbers and keeps committed values immutable`,async()=>{
  const {storage, close} = await featureStorage("issue-numbers",model,adapter);
  try {
  const engine = new Engine(model,testLayer(storage));
  const ctx={tenant:"tenant",actor:"operator",requestId:"sequence"};
  const create=(project:string,tenant="tenant",key?:string)=>Effect.runPromise(engine.call(prefix+"Issue.create",{project,title:"Task"},{...ctx,tenant,...(key?{idempotencyKey:key}:{})}));
  const issues=await Promise.all(Array.from({length:24},()=>create("FORGE")));
  expect(issues.map(i=>i["number"]).sort((a,b)=>Number(a)-Number(b))).toEqual(Array.from({length:24},(_,i)=>i+1));
  expect(await create("OTHER")).toMatchObject({number:1});
  expect(await create("FORGE","other-tenant")).toMatchObject({number:1});
  const before=await create("FORGE","tenant","retry-key");
  const replay=await create("FORGE","tenant","retry-key");
  expect(replay).toEqual(before);
  await expect(Effect.runPromise(engine.call(prefix+"Issue.update",{id:before["id"],expectedVersion:1,patch:{number:999}},ctx))).rejects.toThrow();
  await expect(Effect.runPromise(engine.call(prefix+"Issue.update",{id:before["id"],expectedVersion:1,patch:{project:"OTHER"}},ctx))).rejects.toThrow();
  for(let number=100;number<=102;number++) expect(await Effect.runPromise(engine.call(prefix+"Ticket.create",{title:"Ticket"},ctx))).toMatchObject({number});
  await expect(Effect.runPromise(engine.call(prefix+"Ticket.create",{title:"Overflow"},ctx))).rejects.toThrow();
  } finally { await close(); }
});

it("previewing a sequence create does not consume numbers",async()=>{
 const engine=new Engine(model,testLayer(new MemoryStorage()));
 const ctx={tenant:"preview",actor:"operator",requestId:"preview"};
 await expect(Effect.runPromise(engine.planFor(prefix+"Issue.create",{project:"P",title:"Title"},ctx,true).pipe(Effect.provide(engine.layer)))).rejects.toThrow();
 expect(await Effect.runPromise(engine.call(prefix+"Issue.create",{project:"P",title:"Title"},ctx))).toMatchObject({number:1});
});
