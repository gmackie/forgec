import pg from "pg";
import { randomUUID } from "node:crypto";
import { PostgresStorage, rawPgExecutor } from "../../src/adapters/postgres.js";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Effect } from "effect";
import { Engine, type CallContext } from "../../src/engine.js";
import { Model, type AppBundle } from "../../src/model.js";
import { MemoryStorage } from "../../src/adapters/memory.js";
import { D1Storage } from "../../src/adapters/d1.js";
import type { SqlExecutor, SqlStatement } from "../../src/adapters/sql-executor.js";
import { MemoryObjectStore } from "../../src/adapters/memory-objects.js";
import { testLayer } from "../../src/testing.js";
export const foundationAdapters = process.env["FORGE_FOUNDATION_PG_URL"] ? ["memory", "sqlite", "postgres"] : ["memory", "sqlite"];
export async function foundation(slug: string, adapter: string, consumer = false) {
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
  let pool: pg.Pool | undefined;
  const schema = 'foundation_' + randomUUID().replaceAll('-', '');
  if (adapter === 'postgres') {
    const url = process.env["FORGE_FOUNDATION_PG_URL"];
    if (!url) throw new Error('PostgreSQL Foundation tests require FORGE_FOUNDATION_PG_URL');
    pool = new pg.Pool({connectionString:url,options:`-c search_path=${schema}`,max:6});
    try {
      await pool.query(`CREATE SCHEMA ${schema}`);
      await pool.query(readFileSync(resolve(fixture, 'postgres/0001_init.sql'), 'utf8'));
    } catch(error) { await pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); await pool.end(); db.close(); throw error; }
  }
  const storage = pool ? new PostgresStorage(rawPgExecutor(pool),model) : adapter==='memory'?new MemoryStorage():new D1Storage(executor,model);
  const engine = new Engine(model, testLayer(storage,{objects}));
  const ctx={tenant:'acme',actor:'operator',requestId:'foundation'};
  const call=(op:string,input:Record<string,unknown>,context:CallContext=ctx)=>Effect.runPromise(engine.call(op,input,context));
  return {engine,ctx,call,objects,close:async()=>{db.close();if(pool){try{await pool.query(`DROP SCHEMA ${schema} CASCADE`);}finally{await pool.end();}}}};
}
