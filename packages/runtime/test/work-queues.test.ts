import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { D1Storage } from "../src/adapters/d1.js";
import type { SqlExecutor, SqlStatement } from "../src/adapters/sql-executor.js";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Effect } from "effect";
import { expect, it } from "vitest";
import { executionDigest } from "@forgegraph/capability-manifest";
import { WorkQueue } from "../src/work-queues.js";
import { Model, type AppBundle } from "../src/model.js";
import { MemoryStorage } from "../src/adapters/memory.js";
import { testLayer } from "../src/testing.js";
const bundle = JSON.parse(readFileSync(resolve(import.meta.dirname,"../../../conformance/fixtures/issue-numbers/app.json"),"utf8")) as AppBundle;
const model = new Model(bundle);
for(const adapter of ["memory","sqlite"] as const) it(`${adapter}: claims, fences, retries, cancellation and capability matching`,async()=>{
  const db = new DatabaseSync(":memory:");
  db.exec(readFileSync(resolve(import.meta.dirname,"../../../conformance/fixtures/issue-numbers/d1/0001_init.sql"),"utf8"));
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
  const storage = adapter === "memory" ? new MemoryStorage() : new D1Storage(executor,model);
  let now=1000;
  const definition={id:"AgentWork",execute:"Agent",leaseMs:1000,maxAttempts:2,maxTasks:32,maxRunners:8};
  const queue=new WorkQueue(storage,definition,()=>now);
  const run=<A>(e:Effect.Effect<A,import("../src/errors.js").ForgeError>)=>Effect.runPromise(e);
  await run(queue.register("t",{id:"r",capabilities:["tool.jj"],presence:"online",lastSeen:0}));
  const requirements={version:"execution-requirements/1" as const,artifactDigest:"b".repeat(64),profileDigest:"c".repeat(64),operation:"Agent",requirements:["tool.jj"],provenanceDigest:"a".repeat(64),explanations:{"tool.jj":["implementation:agent"]}};
  requirements.provenanceDigest=executionDigest(Object.fromEntries(Object.entries(requirements).filter(([k])=>k!=="provenanceDigest")));
  await run(queue.enqueue("t","first",{prompt:"test"},requirements));
  await run(queue.enqueue("t","urgent",{},requirements,10));
  const browser={...requirements,requirements:["browser.chromium"]};
  browser.provenanceDigest=executionDigest(Object.fromEntries(Object.entries(browser).filter(([k])=>k!=="provenanceDigest")));
  await run(queue.enqueue("t","browser",{},browser,100));
  const claims=await Promise.all(Array.from({length:4},()=>run(queue.claimNext("t","r"))));
  expect(claims.filter(Boolean).map(t=>t!.id).sort()).toEqual(["first","urgent"]);
  expect(claims[0]?.id).toBe("urgent");
  const urgent=claims.find(t=>t?.id==="urgent")!;
  await run(queue.start("t","urgent","r",urgent.generation));
  now=1500;await run(queue.heartbeat("t","urgent","r",urgent.generation));
  now=2100;
  expect(await run(queue.reapExpired("t"))).toBe(1);
  await expect(run(queue.complete("t","first","r",1,{}))).rejects.toThrow();
  const reclaimed=await run(queue.claimNext("t","r"));
  expect(reclaimed).toMatchObject({id:"first",generation:2,attempts:2});
  await expect(run(queue.heartbeat("t","first","r",1))).rejects.toThrow();
  await run(queue.start("t","first","r",2));
  await run(queue.fail("t","first","r",2));
  expect(await run(queue.get("t","first"))).toMatchObject({status:"failed"});
  await run(queue.cancel("t","urgent"));
  await expect(run(queue.complete("t","urgent","r",urgent.generation,{}))).rejects.toThrow();
  expect(await run(queue.claimNext("t","r"))).toBeNull();
  const restarted=new WorkQueue(storage,definition,()=>now);
  expect(await run(restarted.get("t","urgent"))).toMatchObject({status:"cancelled"});
  expect((await run(restarted.get("t","first"))).history.map(h=>h.kind)).toContain("lease-expired");
  await expect(run(restarted.get("other","first"))).rejects.toThrow();
  } finally {db.close();}
});

it("enqueue derives and stores an immutable snapshot from pinned execution manifests",async()=>{
 const {pinExecutionManifest}=await import("@forgegraph/capability-manifest");
 const pin=pinExecutionManifest({version:"execution-manifest/1",kind:"implementation",id:"agent",requires:["tool.jj"]});
 const artifact={modules:[{resources:[],functions:[{id:"Agent",uses:[]}]}]};
 const source={artifact,artifactDigest:executionDigest(artifact),operation:"Agent",profile:{id:"local",bindings:{Agent:pin.digest},providers:[]},manifests:[pin]};
 const queue=new WorkQueue(new MemoryStorage(),{id:"AgentWork",execute:"Agent",leaseMs:90000,maxAttempts:3,maxTasks:16,maxRunners:8});
 await Effect.runPromise(queue.enqueueDerived("t","task",{prompt:"implement"},source));
 pin.manifest.requires.push("tool.git");
 const stored=await Effect.runPromise(queue.get("t","task"));
 expect(stored.requirements.requirements).toEqual(["tool.jj"]);
 expect(stored.requirements.explanations["tool.jj"]?.[0]).toContain("operation:Agent");
 await expect(Effect.runPromise(queue.enqueueDerived("t","tampered",{},source))).rejects.toThrow();
});

it("queues compiled map activities with immutable workflow provenance and capability matching",async()=>{
 const {pinExecutionManifest}=await import("@forgegraph/capability-manifest");
 const compiled=JSON.parse(readFileSync(resolve(import.meta.dirname,"../../../conformance/fixtures/workflow-map/app.json"),"utf8")) as AppBundle;
 const workflow=compiled.ir.modules.flatMap(m=>m.workflows??[]).find(w=>w.name==="EvaluateCandidates")!;
 const step=workflow.steps.find(s=>s.kind==="map")!;
 if(step.kind!=="map" || step.call.target.kind!=="function") throw Error("expected fixture map");
 const operation=step.call.target.function;
 const pin=pinExecutionManifest({version:"execution-manifest/1",kind:"implementation",id:"evaluator",requires:["tool.evaluator"]});
 const source={artifact:compiled.ir,artifactDigest:executionDigest(compiled.ir),workflow:workflow.id,step:step.id,profile:{id:"local",bindings:{[operation]:pin.digest},providers:[]},manifests:[pin]};
 const storage=new MemoryStorage();
 const definition={id:"EvaluationWork",execute:operation,leaseMs:90000,maxAttempts:3,maxTasks:16,maxRunners:8};
 const queue=new WorkQueue(storage,definition);
 await Effect.runPromise(queue.enqueueWorkflowStep("t","instance:map:0",{candidate:1},source));
 await Effect.runPromise(queue.enqueueWorkflowStep("t","instance:map:1",{candidate:2},source));
 const snapshot=(await Effect.runPromise(queue.get("t","instance:map:0"))).requirements;
 expect(snapshot.workflowStep).toEqual({workflow:workflow.id,step:step.id,version:workflow.version,graphHash:workflow.graphHash});
 expect(snapshot.requirements).toEqual(["tool.evaluator"]);
 await Effect.runPromise(queue.register("t",{id:"unqualified",capabilities:[],presence:"online",lastSeen:0}));
 expect(await Effect.runPromise(queue.claimNext("t","unqualified"))).toBeNull();
 const restarted=new WorkQueue(storage,definition);
 await Effect.runPromise(restarted.register("t",{id:"evaluator",capabilities:["tool.evaluator"],presence:"online",lastSeen:0}));
 expect(await Effect.runPromise(restarted.claimNext("t","evaluator"))).toMatchObject({id:"instance:map:0",requirements:snapshot});
 workflow.graphHash="b".repeat(64);
 workflow.version++;
 await expect(Effect.runPromise(queue.enqueueWorkflowStep("t","tampered",{},source))).rejects.toThrow();
 expect((await Effect.runPromise(restarted.get("t","instance:map:1"))).requirements).toEqual(snapshot);
 const wrong=new WorkQueue(storage,{...definition,id:"Wrong",execute:"Different"});
 await expect(Effect.runPromise(wrong.enqueueWorkflowStep("t","mismatch",{},{...source,artifactDigest:executionDigest(compiled.ir)}))).rejects.toThrow();
});
