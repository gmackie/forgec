import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { Effect } from "effect";
import { expect, it, vi } from "vitest";
import { DynamoDBDocumentClient, type TransactWriteCommandInput } from "@aws-sdk/lib-dynamodb";
import { DynamoStorage } from "../src/adapters/dynamodb.js";
import { Engine } from "../src/engine.js";
import { Model, type AppBundle } from "../src/model.js";
import { MemoryStorage } from "../src/adapters/memory.js";
import { D1Storage } from "../src/adapters/d1.js";
import type { SqlExecutor, SqlStatement } from "../src/adapters/sql-executor.js";
import { testLayer } from "../src/testing.js";
const root = resolve(import.meta.dirname,"../../../conformance/fixtures/deployment-lanes");
const bundle = JSON.parse(readFileSync(resolve(root,"app.json"),"utf8")) as AppBundle;
const model = new Model(bundle);
const resource = "@dogfood/deployments/_/Deployment";
const ctx = { tenant:"test",actor:"operator",requestId:"request" };
const inputs = {application:"forge",stage:"production",target:"cloudflare"};

for (const adapter of ["memory","sqlite"] as const) {
  it(`${adapter}: atomically claims a lane and releases it on terminal transition`,async()=>{
    const db = new DatabaseSync(":memory:");
    db.exec(readFileSync(resolve(root,"d1/0001_init.sql"),"utf8"));
    const runSql = (s:SqlStatement) => ({changes:Number(db.prepare(s.sql).run(...s.params as SQLInputValue[]).changes)});
    const executor:SqlExecutor = {
      facade:"sqlite-test",
      first:async<T>(s:SqlStatement)=> (db.prepare(s.sql).get(...s.params as SQLInputValue[]) ?? null) as T|null,
      all:async<T>(s:SqlStatement)=> db.prepare(s.sql).all(...s.params as SQLInputValue[]) as T[],
      run:async(s)=>runSql(s),
      batch:async(statements)=>{
        db.exec("BEGIN");
        try {const results=statements.map(runSql);db.exec("COMMIT");return results;}
        catch(error){db.exec("ROLLBACK");throw error;}
      },
    };
    const storage = adapter === "memory" ? new MemoryStorage() : new D1Storage(executor,model);
    const engine = new Engine(model,testLayer(storage));
    const call = (op:string, input:Record<string,unknown>,tenant="test")=>Effect.runPromise(engine.call(`${resource}.${op}`,input,{...ctx,tenant}));
    try {
      const attempts = await Promise.allSettled(Array.from({length:8},()=>call("create",inputs)));
      expect(attempts.filter(a=>a.status==="fulfilled")).toHaveLength(1);
      expect(attempts.filter(a=>a.status==="rejected")).toHaveLength(7);
      const winner = attempts.find(a=>a.status==="fulfilled") as PromiseFulfilledResult<Record<string,unknown>>;
      const first = winner.value;
      await call("create",inputs,"other-tenant");
      await call("status.fail",{id:first["id"],expectedVersion:1});
      const second = await call("create",inputs);
      expect(second["id"]).not.toBe(first["id"]);
      // A held lane remains exclusive across a matching-to-matching transition.
      await call("status.deploy",{id:second["id"],expectedVersion:1});
      await expect(call("create",inputs)).rejects.toThrow();
      // Changing the lane releases its previous key and claims the new one in the same commit.
      await call("update",{id:second["id"],expectedVersion:2,patch:{stage:"staging"}});
      await call("create",inputs);
      await expect(call("create",{...inputs,stage:"staging"})).rejects.toThrow();
    } finally {db.close();}
  });
}

it("DynamoDB acquires and releases the claim in the entity transaction",async()=>{
  const memory = new MemoryStorage();
  const layer = testLayer(memory);
  const engine = new Engine(model,layer);
  const transactions: TransactWriteCommandInput[] = [];
  const send = vi.spyOn(DynamoDBDocumentClient.prototype,"send").mockImplementation(async(command:unknown)=>{
    transactions.push((command as {input:TransactWriteCommandInput}).input);
    return {};
  });
  try {
    const dynamo = new DynamoStorage({table:"test",region:"us-east-1"},model);
    const create = await Effect.runPromise(engine.planFor(`${resource}.create`,inputs,ctx).pipe(Effect.provide(layer)));
    await Effect.runPromise(dynamo.commit(create));
    expect(transactions[0]!.TransactItems!.some(i=>i.Put?.ConditionExpression?.includes("entityId = :me"))).toBe(true);
    expect(transactions[0]!.TransactItems!.length).toBeGreaterThan(1);
    await Effect.runPromise(memory.commit(create));
    const transition = await Effect.runPromise(engine.planFor(`${resource}.status.fail`,{id:create.id,expectedVersion:1},ctx).pipe(Effect.provide(layer)));
    expect(transition.claims[0]!.before).toBeTruthy();
    expect(transition.claims[0]!.after).toBeNull();
    await Effect.runPromise(dynamo.commit(transition));
    expect(transactions[1]!.TransactItems!.some(i=>i.Delete)).toBe(true);
    expect(transactions[1]!.TransactItems!.some(i=>i.Put || i.Update)).toBe(true);
  } finally {send.mockRestore();}
});
