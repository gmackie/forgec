import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { D1Storage } from "../src/adapters/d1.js";
import type { SqlExecutor, SqlStatement } from "../src/adapters/sql-executor.js";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Effect } from "effect";
import { expect, it } from "vitest";
import { ActorHost, DurableObjectActorStore, type ActorReducer, type DurableActorStorage } from "../src/actors.js";
import { Model, type AppBundle } from "../src/model.js";
import { MemoryStorage } from "../src/adapters/memory.js";
import { testLayer } from "../src/testing.js";
const bundle = JSON.parse(readFileSync(resolve(import.meta.dirname,"../../../conformance/fixtures/actors/app.json"),"utf8")) as AppBundle;
const model = new Model(bundle);
const definition=model.bundle.ir.modules[0]!.actors!.find(a=>a.id.endsWith("/GameSession"))!;
for(const adapter of ["memory","sqlite","durable-object-facade"] as const) it(`${adapter}: actor concurrency, duplicate messages, alarms and stale writers`,async()=>{
  const db = new DatabaseSync(":memory:");
  db.exec(readFileSync(resolve(import.meta.dirname,"../../../conformance/fixtures/actors/d1/0001_init.sql"),"utf8"));
  const run = (s:SqlStatement)=>({changes:Number(db.prepare(s.sql).run(...s.params as SQLInputValue[]).changes)});
  const executor:SqlExecutor = {
    facade:"sqlite-test",
    first:async<T>(s:SqlStatement)=>(db.prepare(s.sql).get(...s.params as SQLInputValue[]) ?? null) as T|null,
    all:async<T>(s:SqlStatement)=>db.prepare(s.sql).all(...s.params as SQLInputValue[]) as T[],
    run:async(s)=>run(s),
    batch:async(statements)=>{
      db.exec("BEGIN");
      try {const results=statements.map(run);db.exec("COMMIT");return results;}
      catch(error){db.exec("ROLLBACK");throw error;}
    },
  };
  try {
  const docs=new Map<string,unknown>();
  let tail=Promise.resolve();
  let scheduledAt:number|null=null;
  const durable:DurableActorStorage={
    setAlarm:async at=>{scheduledAt=at;},deleteAlarm:async()=>{scheduledAt=null;},
    get:async<T>(key:string)=>structuredClone(docs.get(key)) as T|undefined,
    put:async<T>(key:string,value:T)=>{docs.set(key,structuredClone(value));},
    transaction:<T>(body:(tx:DurableActorStorage)=>Promise<T>)=>{
      const result=tail.then(()=>body(durable));tail=result.then(()=>undefined,()=>undefined);return result;
    },
  };
  const storage=adapter === "memory" ? new MemoryStorage() : adapter === "sqlite" ? new D1Storage(executor,model) : new DurableObjectActorStore(durable);
  let now=1000;
  const reducer:ActorReducer=(state,message)=>({state:{score:Number(state["score"])+Number(message["points"])},effects:[{kind:"score.changed",payload:{points:message["points"]}}]});
  const host=new ActorHost(model,storage,definition,{Action:reducer},()=>now);
  await Effect.runPromise(host.initialize("t","game",{score:0}));
  await Promise.all(Array.from({length:12},(_,i)=>Effect.runPromise(host.command("t","game",`m${i}`,"Action",{points:1},1))));
  expect(await Effect.runPromise(host.load("t","game"))).toMatchObject({state:{score:12},revision:12,generation:1});
  expect(await Effect.runPromise(host.command("t","game","m0","Action",{points:1},1))).toMatchObject({duplicate:true});
  await expect(Effect.runPromise(host.command("t","game","m0","Action",{points:2},1))).rejects.toThrow();
  const generation=await Effect.runPromise(host.takeover("t","game",1));
  expect(generation).toBe(2);
  await expect(Effect.runPromise(host.command("t","game","stale","Action",{points:1},1))).rejects.toThrow();
  const scheduled=new ActorHost(model,storage,definition,{Action:(state,message)=>({...reducer(state,message),alarms:message["points"]===0?[{name:"timeout",at:2000,command:"Action",payload:{points:3}}]:[]})},()=>now);
  await Effect.runPromise(scheduled.command("t","game","schedule","Action",{points:0},2));
  if(adapter==="durable-object-facade") expect(scheduledAt).toBe(2000);
  now=2100;
  expect(await Effect.runPromise(scheduled.fireDue("t","game",2))).toBe(1);
  expect(await Effect.runPromise(scheduled.fireDue("t","game",2))).toBe(0);
  if(adapter==="durable-object-facade") expect(scheduledAt).toBeNull();
  const recovered=await Effect.runPromise(new ActorHost(model,storage,definition,{Action:reducer}).load("t","game"));
  expect(recovered.state).toEqual({score:15});
  expect(recovered.effects).toHaveLength(14);
  await expect(Effect.runPromise(host.load("other","game"))).rejects.toThrow();
  await expect(Effect.runPromise(host.command("t","game","invalid","Action",{points:"bad"},2))).rejects.toThrow();
  } finally {db.close();}
});
