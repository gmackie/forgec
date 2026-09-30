import { readFileSync } from "node:fs";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { DynamoDBClient, CreateTableCommand, DeleteTableCommand } from "@aws-sdk/client-dynamodb";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { Engine } from "../src/engine.js";
import { Model, type AppBundle } from "../src/model.js";
import { MemoryStorage } from "../src/adapters/memory.js";
import { D1Storage } from "../src/adapters/d1.js";
import { PostgresStorage, rawPgExecutor } from "../src/adapters/postgres.js";
import { DynamoStorage } from "../src/adapters/dynamodb.js";
import { testLayer, jumpTestClock } from "../src/testing.js";
import { defineFunction, type FunctionImpl } from "../src/functions.js";
import type { SqlExecutor, SqlStatement } from "../src/adapters/sql-executor.js";
import type { StorageAdapter } from "../src/services.js";
import { err } from "../src/errors.js";

const bundle = JSON.parse(readFileSync(new URL("../../../conformance/fixtures/acme.app.json", import.meta.url), "utf8")) as AppBundle;
const handler = "@acme/commerce/_/FulfillOrder";
const external = "@acme/payments/_/AuthorizePayment";
const run = Effect.runPromise;
const adapters = ["memory", "sqlite", ...(process.env["FORGE_D1_HARNESS"] ? ["d1"] : []), ...(process.env["FORGE_PG_URL"] ? ["postgres"] : []), ...(process.env["FORGE_DYNAMO_ENDPOINT"] ? ["dynamo"] : [])];

async function setup(adapter: string) {
  const model = new Model(structuredClone(bundle));
  // Same subscription protocol with a handler allowed to create records and publish.
  const decl = model.function(handler)!;
  decl.uses.push({kind:"resource", resource:"@acme/commerce/_/Customer", capability:"create"}, {kind:"function", function: external} as typeof decl.uses[number]);
  decl.sends.push({channel:"@acme/commerce/_/OrderEvents", message:"OrderSubmitted"});
  let close = async () => {};
  let storage: StorageAdapter;
  if (adapter === "d1") {
    const request = async <T>(method: string, statements: SqlStatement[]): Promise<T> => {
      const response = await fetch(`${process.env["FORGE_D1_HARNESS"]}/_forge/test-sql`, {method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({method,statements})});
      const result = await response.json() as {value:T;error?:string};
      if (!response.ok) throw new Error(result.error);
      return result.value;
    };
    const executor: SqlExecutor={facade:"local-d1",first:s=>request("first",[s]),all:s=>request("all",[s]),run:s=>request("run",[s]),batch:s=>request("batch",s)};
    storage=new D1Storage(executor,model);
  } else if (adapter === "sqlite") {
    const db = new DatabaseSync(":memory:");
    db.exec(readFileSync(new URL("../../../conformance/fixtures/acme.0001_init.sql", import.meta.url), "utf8"));
    const statement = (s: {sql:string;params:unknown[]}) => ({changes:Number(db.prepare(s.sql).run(...s.params as SQLInputValue[]).changes)});
    storage = new D1Storage({facade:"sqlite-test", first:async <T>(s: {sql:string;params:unknown[]}) => (db.prepare(s.sql).get(...s.params as SQLInputValue[]) ?? null) as T|null,
      all:async <T>(s: {sql:string;params:unknown[]}) => db.prepare(s.sql).all(...s.params as SQLInputValue[]) as T[], run:async s => statement(s),
      batch:async (ss: {sql:string;params:unknown[]}[]) => {db.exec("BEGIN");try{const r=ss.map(statement);db.exec("COMMIT");return r;}catch(e){db.exec("ROLLBACK");throw e;}}}, model);
    close = async () => db.close();
  } else if (adapter === "postgres") {
    const schema = "delivery_"+randomUUID().replaceAll("-", "");
    const pool = new pg.Pool({connectionString:process.env["FORGE_PG_URL"], options:`-c search_path=${schema}`});
    await pool.query(`CREATE SCHEMA ${schema}`);
    await pool.query(readFileSync(new URL("../../../examples/acme/generated/postgres/0001_init.sql", import.meta.url), "utf8"));
    storage = new PostgresStorage(rawPgExecutor(pool), model);
    close = async () => { await pool.query(`DROP SCHEMA ${schema} CASCADE`); await pool.end(); };
  } else if (adapter === "dynamo") {
    const client = new DynamoDBClient({endpoint:process.env["FORGE_DYNAMO_ENDPOINT"]!, region:"us-east-1", credentials:{accessKeyId:"local",secretAccessKey:"local"}});
    const table = "forge-delivery-"+randomUUID();
    await client.send(new CreateTableCommand({TableName:table, BillingMode:"PAY_PER_REQUEST", GlobalSecondaryIndexes:[{IndexName:"pending-index",KeySchema:[{AttributeName:"pendingShard",KeyType:"HASH"},{AttributeName:"pendingAt",KeyType:"RANGE"}],Projection:{ProjectionType:"ALL"}}],AttributeDefinitions:[{AttributeName:"PK",AttributeType:"S"},{AttributeName:"SK",AttributeType:"S"},{AttributeName:"pendingShard",AttributeType:"S"},{AttributeName:"pendingAt",AttributeType:"N"}],KeySchema:[{AttributeName:"PK",KeyType:"HASH"},{AttributeName:"SK",KeyType:"RANGE"}]}));
    storage = new DynamoStorage({table,client}, model);
    close = async () => { await client.send(new DeleteTableCommand({TableName:table})); client.destroy(); };
  } else storage = new MemoryStorage();
  const tenant = randomUUID();
  const layer = testLayer(storage, {runId:randomUUID().slice(0,8)});
  const env = {channel:"@acme/commerce/_/OrderEvents",message:"OrderSubmitted",tenant,opId:"delivery",ordinal:0,messageId:"delivery:0",payload:{},createdAt:"t"};
  const engine = (impl: FunctionImpl, binding = async () => ({ok:true as const,value:{}})) => new Engine(model,layer,{functions:[impl],externals:{[external]:binding}});
  return {model,storage,layer,env,engine,close};
}

for (const adapter of adapters) describe(adapter, () => {
  it("excludes concurrent handlers and recovers an expired claim; stale writes are fenced", async () => {
    const f = await setup(adapter);
    try {
      let started!: () => void, release!: () => void;
      const entered = new Promise<void>(r => started=r), gate = new Promise<void>(r => release=r);
      const slow = f.engine(defineFunction(handler, d => Effect.gen(function* () {
        yield* d.resources.Customer!.create({code:"STALE",name:"Stale"});
        yield* Effect.promise(() => {started();return gate;});
      })));
      const first = slow.consume("fulfill-order", f.env);
      const rejected = expect(first).rejects.toMatchObject({code:"VersionConflict"});
      await entered;
      let attempts = 0;
      const replacement = f.engine(defineFunction(handler, () => Effect.sync(() => {attempts++;})));
      await expect(replacement.consume("fulfill-order",f.env)).rejects.toMatchObject({code:"TransientConflict"});
      expect(attempts).toBe(0);
      jumpTestClock(f.layer,61_000);
      expect(await replacement.consume("fulfill-order",f.env)).toBe("processed");
      release(); await rejected;
      expect(await replacement.consume("fulfill-order",f.env)).toBe("duplicate");
      await expect(run(replacement.call("@acme/commerce/_/Customer.find.byCode",{params:{code:"STALE"}},{tenant:f.env.tenant,actor:"test",requestId:"get"}))).rejects.toMatchObject({code:"NotFound"});
      expect(attempts).toBe(1);
    } finally {await f.close();}
  });

  it("commits writes and completion together even when the commit response is lost", async () => {
    const f = await setup(adapter);
    try {
      const original = f.storage.commitAll.bind(f.storage);
      let lose = true, attempts = 0;
      f.storage.commitAll = (plans, absent) => original(plans,absent).pipe(Effect.flatMap(() => {
        if (lose) {lose=false;return Effect.fail(err("StorageUnavailable","response lost"));}
        return Effect.void;
      }));
      const e = f.engine(defineFunction(handler,d=>Effect.gen(function*(){attempts++;return yield* d.resources.Customer!.create({code:"ONCE",name:"Once"});})));
      await expect(e.consume("fulfill-order",f.env)).rejects.toMatchObject({code:"StorageUnavailable"});
      expect(await e.consume("fulfill-order",f.env)).toBe("duplicate");
      expect(attempts).toBe(1);
      expect(await run(e.call("@acme/commerce/_/Customer.find.byCode",{params:{code:"ONCE"}},{tenant:f.env.tenant,actor:"test",requestId:"get"}))).toMatchObject({code:"ONCE"});
    } finally {await f.close();}
  });

  it("retries failures before commit and atomically deduplicates publication-only handlers", async () => {
    const f=await setup(adapter);
    try {
      const original=f.storage.commitAll.bind(f.storage);
      let fail=true, attempts=0;
      f.storage.commitAll=(plans, absent)=>Effect.suspend(()=>{
        if(fail){fail=false;return Effect.fail(err("StorageUnavailable","before commit"));}
        return original(plans,absent);
      });
      const e=f.engine(defineFunction(handler,d=>Effect.gen(function*(){
        attempts++;
        yield* d.send("OrderEvents","OrderSubmitted",{order:"o",customer:"c",revision:2});
      })));
      await expect(e.consume("fulfill-order",f.env)).rejects.toMatchObject({code:"StorageUnavailable"});
      expect(await run(f.storage.outboxSweep(f.env.tenant,Date.now(),10))).toHaveLength(0);
      expect(await e.consume("fulfill-order",f.env)).toBe("processed");
      expect(await e.consume("fulfill-order",f.env)).toBe("duplicate");
      expect(attempts).toBe(2);
      expect(await run(f.storage.outboxSweep(f.env.tenant,Date.now(),10))).toHaveLength(1);
    } finally {await f.close();}
  });

  it("completes a successful external-only handler and rejects identity reuse", async () => {
    const f=await setup(adapter);
    try {
      let calls=0;
      const e=f.engine(defineFunction(handler,d=>Effect.gen(function*(){yield* d.external(external,{});})),async()=>{calls++;return {ok:true,value:{}};});
      expect(await e.consume("fulfill-order",f.env)).toBe("processed");
      expect(await e.consume("fulfill-order",f.env)).toBe("duplicate");
      await expect(e.consume("fulfill-order",{...f.env,payload:{changed:true}})).rejects.toMatchObject({code:"IdempotencyMismatch"});
      expect(calls).toBe(1);
    } finally {await f.close();}
  });

  it("shares durable intent when a handler starts external calls concurrently", async () => {
    const f=await setup(adapter);
    try {
      let calls=0;
      const e=f.engine(defineFunction(handler,d=>Effect.gen(function*(){
        yield* Effect.all([d.external(external,{call:1}),d.external(external,{call:2})],{concurrency:"unbounded"});
      })),async()=>{calls++;return {ok:true,value:{}};});
      expect(await e.consume("fulfill-order",f.env)).toBe("processed");
      expect(calls).toBe(2);
    } finally {await f.close();}
  });

  it("parks ambiguous external effects across engine restarts and lease expiry", async () => {
    const f = await setup(adapter);
    try {
      let calls = 0;
      const impl = defineFunction(handler,d => Effect.gen(function*(){yield* d.external(external,{});}));
      const binding = async () => {calls++;throw new Error("connection lost after vendor accepted write");};
      await expect(f.engine(impl,binding).consume("fulfill-order",f.env)).rejects.toMatchObject({code:"DeliveryOutcomeUnknown"});
      jumpTestClock(f.layer,61_000);
      await expect(f.engine(impl,binding).consume("fulfill-order",f.env)).rejects.toMatchObject({code:"DeliveryOutcomeUnknown"});
      expect(calls).toBe(1);
    } finally {await f.close();}
  });

  it("does not start an external effect after its claim lease expires", async () => {
    const f = await setup(adapter);
    try {
      let calls=0;
      const e=f.engine(defineFunction(handler,d=>Effect.gen(function*(){
        jumpTestClock(f.layer,61_000);
        yield* d.external(external,{});
      })),async()=>{calls++;return {ok:true,value:{}};});
      await expect(e.consume("fulfill-order",f.env)).rejects.toMatchObject({code:"TransientConflict"});
      expect(calls).toBe(0);
    } finally {await f.close();}
  });

  it("retains legacy deduplication and isolates tenant identities", async () => {
    const f = await setup(adapter);
    try {
      await run(f.storage.markProcessed(f.env.tenant,"fulfill-order",f.env.messageId));
      let attempts=0;
      const e=f.engine(defineFunction(handler,()=>Effect.sync(()=>{attempts++;})));
      expect(await e.consume("fulfill-order",f.env)).toBe("duplicate");
      expect(await e.consume("fulfill-order",{...f.env,tenant:randomUUID()})).toBe("processed");
      expect(attempts).toBe(1);
    } finally {await f.close();}
  });
});
