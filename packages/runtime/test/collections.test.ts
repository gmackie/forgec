import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { D1Storage } from "../src/adapters/d1.js";
import type { SqlExecutor, SqlStatement } from "../src/adapters/sql-executor.js";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Effect } from "effect";
import { expect, it } from "vitest";
import { decodeValue } from "../src/decode.js";
import { Engine } from "../src/engine.js";
import { Model, type AppBundle } from "../src/model.js";
import { MemoryStorage } from "../src/adapters/memory.js";
import { testLayer } from "../src/testing.js";
const bundle = JSON.parse(readFileSync(resolve(import.meta.dirname,"../../../conformance/fixtures/collections/app.json"),"utf8")) as AppBundle;
const model = new Model(bundle);
const resource = model.bundle.ir.modules.flatMap(m=>m.resources).find(r=>r.name==="LevelDefinition")!;
const decode = (name:string,value:unknown)=>decodeValue(model,resource.fields.find(f=>f.name===name)!.type,value);

it("canonicalizes sets and maps while retaining list order",()=>{
  expect(decode("tags",["z","a"])).toEqual(["a","z"]);
  expect(JSON.stringify(decode("metadata",{z:"last",a:"first"}))).toBe('{"a":"first","z":"last"}');
  expect(decode("grid",[[3,1],[2]])).toEqual([[3,1],[2]]);
  expect(()=>decode("tags",["a","a"])).toThrow();
  expect(()=>decode("grid",[["1"]])).toThrow();
  expect(()=>decode("metadata",{["x".repeat(257)]:"value"})).toThrow();
});

it("validates shape members and collection bounds",()=>{
  expect(decode("objectives",[{score:2,title:"Win"}])).toEqual([{score:2,title:"Win"}]);
  for (const value of [[],[{title:"Win",score:-1}],[{title:"Win",score:2,extra:true}]]) {
    expect(()=>decode("objectives",value)).toThrow();
  }
  expect(()=>decode("tags",Array.from({length:33},(_,i)=>String(i)))).toThrow();
  expect(()=>decode("metadata",{large:"x".repeat(256*1024)})).toThrow();
});

for (const adapter of ["memory", "sqlite"] as const) it(`${adapter}: round trips canonical collections and checks combined record size`,async()=>{
  const db = new DatabaseSync(":memory:");
  db.exec(readFileSync(resolve(import.meta.dirname,"../../../conformance/fixtures/collections/d1/0001_init.sql"),"utf8"));
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
  const engine = new Engine(model,testLayer(adapter === "memory" ? new MemoryStorage() : new D1Storage(executor,model)));
  const ctx = {tenant:"test",actor:"operator",requestId:"collections"};
  const input = {objectives:[{title:"Win",score:1}],tags:["z","a"],metadata:{a:"one"},grid:[[1,2]]};
  const created = await Effect.runPromise(engine.call(`${resource.id}.create`,input,ctx));
  expect(created).toMatchObject({...input,tags:["a","z"]});
  const got = await Effect.runPromise(engine.call(`${resource.id}.get`,{id:created["id"]},ctx));
  expect(got).toMatchObject({...input,tags:["a","z"]});
  await expect(Effect.runPromise(engine.call(`${resource.id}.create`,{...input,tags:["x".repeat(140000)],metadata:{a:"y".repeat(140000)}},ctx))).rejects.toThrow();
  } finally { db.close(); }
});
