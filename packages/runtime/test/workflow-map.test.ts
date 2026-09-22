import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Effect } from "effect";
import { expect, it } from "vitest";
import { Engine } from "../src/engine.js";
import { Model, type AppBundle } from "../src/model.js";
import { MemoryStorage } from "../src/adapters/memory.js";
import { testLayer } from "../src/testing.js";
import { defineFunction } from "../src/functions.js";
const bundle = JSON.parse(readFileSync(resolve(import.meta.dirname,"../../../conformance/fixtures/workflow-map/app.json"),"utf8")) as AppBundle;
const model = new Model(bundle);
const prefix = "@dogfood/workflow-map/_/";
const ctx = {tenant:"test",actor:"operator",requestId:"map"};
function setup(storage = new MemoryStorage()) {
  const calls:number[]=[];
  let active=0,peak=0;
  const fn = defineFunction(prefix+"EvaluateCandidate",({input})=>Effect.promise(async()=>{
    const value = (input as Record<string,unknown>)["candidate"] as number;
    calls.push(value);active++;peak=Math.max(peak,active);
    await new Promise(r=>setTimeout(r,12-value));
    active--;
    return {score:value*2};
  }));
  const engine = new Engine(model,testLayer(storage),{functions:[fn]});
  return {engine,storage,calls,peak:()=>peak};
}

it("maps concurrently with deterministic ordering and handles empty lists",async()=>{
  const {engine,peak} = setup();
  const result = await Effect.runPromise(engine.call(prefix+"EvaluateCandidates.start",{candidates:[1,2,3,4,5,6]},ctx));
  expect(result).toMatchObject({status:"completed",output:[2,4,6,8,10,12].map(score=>({score}))});
  expect(peak()).toBe(4);
  expect(await Effect.runPromise(engine.call(prefix+"EvaluateCandidates.start",{candidates:[]},ctx))).toMatchObject({status:"completed",output:[]});
  await expect(Effect.runPromise(engine.call(prefix+"EvaluateCandidates.start",{candidates:Array(33).fill(1)},ctx))).rejects.toThrow();
  await expect(Effect.runPromise(engine.call(prefix+"EvaluateCandidates.start",{candidates:["wrong"]},ctx))).rejects.toThrow();
});

it("resumes after a driver restart without repeating completed items",async()=>{
  const first=setup();
  first.engine.workflows.faults.crashAfterStep="evaluations";
  await expect(Effect.runPromise(first.engine.call(prefix+"EvaluateCandidates.start",{candidates:[1,2,3,4,5,6]},ctx))).rejects.toThrow();
  expect(first.calls).toEqual([1,2,3,4]);
  const second=setup(first.storage);
  await Effect.runPromise(second.engine.workflows.sweep(ctx.tenant));
  expect(second.calls).toEqual([5,6]);
  const ids=await Effect.runPromise(second.engine.workflows.inflight(ctx.tenant));
  expect(ids).toEqual([]);
});

it("racing drivers share item reservations and never duplicate completed calls",async()=>{
  const first=setup();
  first.engine.workflows.faults.crashAfterStep="evaluations";
  await expect(Effect.runPromise(first.engine.call(prefix+"EvaluateCandidates.start",{candidates:[1,2,3,4,5,6,7,8]},ctx))).rejects.toThrow();
  const second=setup(first.storage),third=setup(first.storage);
  await Promise.all([Effect.runPromise(second.engine.workflows.sweep(ctx.tenant)),Effect.runPromise(third.engine.workflows.sweep(ctx.tenant))]);
  expect([...second.calls,...third.calls].sort()).toEqual([5,6,7,8]);
  expect(await Effect.runPromise(second.engine.workflows.inflight(ctx.tenant))).toEqual([]);
});

it("fails the map when one child fails and does not dispatch the next wave",async()=>{
  const {err}=await import("../src/errors.js");
  const calls:number[]=[];
  const engine=new Engine(model,testLayer(new MemoryStorage()),{functions:[defineFunction(prefix+"EvaluateCandidate",({input})=>{
    const candidate=(input as {candidate:number}).candidate;calls.push(candidate);
    return candidate===2 ? Effect.fail(err("ValidationFailed","bad candidate")) : Effect.succeed({score:candidate});
  })]});
  const result=await Effect.runPromise(engine.call(prefix+"EvaluateCandidates.start",{candidates:[1,2,3,4,5]},ctx));
  expect(result).toMatchObject({status:"failed",error:{code:"ValidationFailed"}});
  expect(calls).not.toContain(5);
});
