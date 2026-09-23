import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Effect } from "effect";
import { Engine } from "../../src/engine.js";
import { Model, type AppBundle } from "../../src/model.js";
import { MemoryStorage } from "../../src/adapters/memory.js";
import { D1Storage } from "../../src/adapters/d1.js";
import type { SqlExecutor, SqlStatement } from "../../src/adapters/sql-executor.js";
import { MemoryObjectStore } from "../../src/adapters/memory-objects.js";
import { testLayer } from "../../src/testing.js";
export function foundation(slug: string, adapter: string, consumer = false) {
  const fixture = process.env[consumer ? "FORGE_FOUNDATION_CONSUMER" : "FORGE_FOUNDATION_FIXTURE"] ?? resolve(import.meta.dirname, `../../../../conformance/fixtures/${slug}${consumer ? '-consumer' : ''}`);
  const model = new Model(JSON.parse(readFileSync(resolve(fixture, 'app.json'), 'utf8')) as AppBundle);
  const db = new DatabaseSync(':memory:'); db.exec(readFileSync(resolve(fixture, 'd1/0001_init.sql'), 'utf8'));
  const statement = (s: SqlStatement) => ({changes: Number(db.prepare(s.sql).run(...s.params as SQLInputValue[]).changes)});
  const executor: SqlExecutor = {
    facade:'sqlite-test', first:async <T>(s:SqlStatement)=>(db.prepare(s.sql).get(...s.params as SQLInputValue[])??null) as T|null,
    all:async <T>(s:SqlStatement)=>db.prepare(s.sql).all(...s.params as SQLInputValue[]) as T[], run:async s=>statement(s),
    batch:async statements=>{db.exec('BEGIN');try{const result=statements.map(statement);db.exec('COMMIT');return result;}catch(e){db.exec('ROLLBACK');throw e;}}
  };
  const objects=new MemoryObjectStore();
  const engine = new Engine(model, testLayer(adapter==='memory'?new MemoryStorage():new D1Storage(executor,model),{objects}));
  const ctx={tenant:'acme',actor:'operator',requestId:'foundation'};
  const call=(op:string,input:Record<string,unknown>,context=ctx)=>Effect.runPromise(engine.call(op,input,context));
  return {engine,ctx,call,objects,close:()=>db.close()};
}
