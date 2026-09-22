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
import { AesGcmSecretAdapter } from "../src/credentials.js";
const bundle = JSON.parse(readFileSync(resolve(import.meta.dirname,"../../../conformance/fixtures/credentials/app.json"),"utf8")) as AppBundle;
const model = new Model(bundle);
const resource=model.resources.find(r=>r.name==="Integration")!;
for(const adapter of ["memory","sqlite"] as const) it(`${adapter}: seals credentials, exposes presence, rotates and audits authorized use`,async()=>{
  const db = new DatabaseSync(":memory:");
  db.exec(readFileSync(resolve(import.meta.dirname,"../../../conformance/fixtures/credentials/d1/0001_init.sql"),"utf8"));
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
  const storage=adapter === "memory" ? new MemoryStorage() : new D1Storage(executor,model);
  const key=await crypto.subtle.generateKey({name:"AES-GCM",length:256},false,["encrypt","decrypt"]);
  const audits:unknown[]=[];
  const vault=new AesGcmSecretAdapter("key1",new Map([["key1",key]]),async context=>context.purpose==="deploy",async event=>{audits.push(event);});
  const engine = new Engine(model,testLayer(storage),{secrets:vault});
  const ctx={tenant:"tenant",actor:"operator",requestId:"credential",idempotencyKey:"create"};
  const plaintext="highly-sensitive-token";
  const created=await Effect.runPromise(engine.call(resource.id+".create",{provider:"github",accessToken:plaintext},ctx));
  expect(created).toMatchObject({accessTokenPresent:true,refreshTokenPresent:false});
  expect(created).not.toHaveProperty("accessToken");
  const stored=await Effect.runPromise(storage.get(ctx.tenant,resource,created["id"]));
  expect(JSON.stringify(stored)).not.toContain(plaintext);
  expect(stored?.["accessToken"]).toMatch(/^sealed\.v1\.key1\./);
  const context={tenant:ctx.tenant,resource:resource.id,record:created["id"],field:"accessToken",actor:"runner",purpose:"deploy"};
  expect(await vault.use(context,String(stored?.["accessToken"]),async value=>value===plaintext)).toBe(true);
  expect(JSON.stringify(audits)).not.toContain(plaintext);
  await expect(vault.use({...context,purpose:"read"},String(stored?.["accessToken"]),async value=>value)).rejects.toThrow();
  await expect(vault.use({...context,tenant:"other"},String(stored?.["accessToken"]),async value=>value)).rejects.toThrow();
  const updated=await Effect.runPromise(engine.call(resource.id+".update",{id:created["id"],expectedVersion:1,patch:{accessToken:"rotated-token"}},{...ctx,idempotencyKey:"rotate"}));
  expect(JSON.stringify(updated)).not.toContain("rotated-token");
  const rotated=await Effect.runPromise(storage.get(ctx.tenant,resource,created["id"]));
  expect(rotated?.["accessToken"]).not.toEqual(stored?.["accessToken"]);
  expect(await vault.use(context,String(rotated?.["accessToken"]),async value=>value)).toBe("rotated-token");
  const receipt=await Effect.runPromise(storage.getReceipt(ctx.tenant,resource.id+".create","create"));
  expect(JSON.stringify(receipt)).not.toContain(plaintext);
  const read=await Effect.runPromise(engine.call(resource.id+".get",{id:created["id"]},ctx));
  expect(read).not.toHaveProperty("accessToken");
  await expect(Effect.runPromise(engine.call("@dogfood/credentials/admin.export",{},ctx))).rejects.toThrow();
  const withoutVault=new Engine(model,testLayer(storage));
  await expect(Effect.runPromise(withoutVault.call(resource.id+".create",{provider:"github",accessToken:plaintext},{...ctx,idempotencyKey:"missing"}))).rejects.toThrow();
  } finally {db.close();}
});
