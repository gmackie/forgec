import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { D1Storage } from "../src/adapters/d1.js";
import type { SqlExecutor, SqlStatement } from "../src/adapters/sql-executor.js";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Effect } from "effect";
import { expect, it } from "vitest";
import { Engine } from "../src/engine.js";
import { Model, type AppBundle } from "../src/model.js";
import { MemoryStorage } from "../src/adapters/memory.js";
import { testLayer } from "../src/testing.js";
const bundle = JSON.parse(readFileSync(resolve(import.meta.dirname,"../../../conformance/fixtures/search/app.json"),"utf8")) as AppBundle;
const model = new Model(bundle);
const prefix = "@dogfood/search/_/Issue";
for(const adapter of ["memory","sqlite"] as const) it(`${adapter}: exact indexed search normalizes values, pages and binds cursors`,async()=>{
  const db = new DatabaseSync(":memory:");
  db.exec(readFileSync(resolve(import.meta.dirname,"../../../conformance/fixtures/search/d1/0001_init.sql"),"utf8"));
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
  const ctx={tenant:"search",actor:"operator",requestId:"search"};
  const rows=[];
  for(let i=0;i<5;i++) rows.push(await Effect.runPromise(engine.call(prefix+".create",{project:"P",title:"  Login Bug  "},ctx)));
  await Effect.runPromise(engine.call(prefix+".create",{project:"P",title:"Login Bug Other"},ctx));
  await Effect.runPromise(engine.call(prefix+".create",{project:"Q",title:"Login Bug"},ctx));
  const search=(params:Record<string,unknown>,cursor?:string)=>Effect.runPromise(engine.call(prefix+".list.search_byProjectTitle",{params,limit:2,...(cursor?{cursor}:{})},ctx));
  const first=await search({project:"P",title:"LOGIN BUG"});
  expect(first.items).toHaveLength(2);
  const second=await search({project:"P",title:"login bug"},first.next);
  const third=await search({project:"P",title:"login bug"},second.next);
  expect([...first.items,...second.items,...third.items].map((r:Record<string,unknown>)=>r.id)).toEqual(rows.map(r=>r.id));
  expect(third.next).toBeNull();
  await expect(search({project:"Q",title:"login bug"},first.next)).rejects.toThrow();
  expect((await search({project:"P",title:"login"})).items).toEqual([]);
  await Effect.runPromise(engine.call(prefix+".update",{id:rows[0]!.id,expectedVersion:1,patch:{title:"Fixed"}},ctx));
  expect((await search({project:"P",title:"fixed"})).items[0].id).toBe(rows[0]!.id);
  } finally {db.close();}
});
