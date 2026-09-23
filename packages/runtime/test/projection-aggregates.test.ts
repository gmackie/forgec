import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Effect } from "effect";
import { expect, it } from "vitest";
import { Model,type AppBundle } from "../src/model.js";
import { Engine } from "../src/engine.js";
import { featureAdapters, featureStorage, unavailable } from "./helpers/feature-storage.js";
import { testLayer } from "../src/testing.js";
const bundle = JSON.parse(readFileSync(resolve(import.meta.dirname,"../../../conformance/fixtures/project-portfolio/app.json"),"utf8")) as AppBundle;
const R="@dogfood/portfolio/_/Issue", P="@dogfood/portfolio/_/ProjectPortfolio";
const ctx={tenant:"test",actor:"operator",requestId:"test"};
for (const adapter of featureAdapters) it.skipIf(unavailable(adapter))(`${adapter}: maintains filtered counts, existence and extrema through updates, deletions and rebuild`,async()=>{
  const model=new Model(bundle);
  const {storage,close}=await featureStorage("project-portfolio",model,adapter);
  try {
  const engine=new Engine(model,testLayer(storage));
  const call=(operation:string,body:Record<string,unknown>)=>Effect.runPromise(engine.call(operation,body,ctx));
  let ordinal=0;
  const apply=(record:Record<string,unknown>)=>engine.applyProjectionEvent(P,{channel:`${R}.changes`,message:"Updated",messageId:`m${++ordinal}`,tenant:"test",opId:`o${ordinal}`,ordinal:0,payload:record,createdAt:"2026-01-01T00:00:00Z"});
  await call(`${P}.rebuild`,{});
  const a=await call(`${R}.create`,{project:"forge",estimate:2,updated:"2026-01-01T00:00:00Z"});
  const b=await call(`${R}.create`,{project:"forge",estimate:9,state:"Completed",updated:"2026-02-01T00:00:00Z"});
  await apply(a);await apply(b);
  const expected={issues:2,openIssues:1,openEstimate:2,smallest:2,largest:9,anyOpen:true,allDone:false,lastUpdate:"2026-02-01T00:00:00.000Z"};
  expect(await call(`${P}.get`,{id:"forge"})).toMatchObject(expected);
  await call(`${P}.rebuild`,{});
  expect(await call(`${P}.get`,{id:"forge"})).toMatchObject(expected);
  const changed=await call(`${R}.update`,{id:a["id"],expectedVersion:1,patch:{state:"Completed",estimate:5}});
  await apply(changed);
  expect(await call(`${P}.get`,{id:"forge"})).toMatchObject({issues:2,openIssues:0,openEstimate:0,smallest:5,largest:9,anyOpen:false,allDone:true});
  await call(`${R}.delete`,{id:b["id"],expectedVersion:1});
  await apply({id:b["id"],version:2});
  expect(await call(`${P}.get`,{id:"forge"})).toMatchObject({issues:1,smallest:5,largest:5,lastUpdate:"2026-01-01T00:00:00.000Z"});
  await apply(changed); // duplicate revision
  expect(await call(`${P}.get`,{id:"forge"})).toMatchObject({issues:1,smallest:5,largest:5});
  } finally { await close(); }
});
