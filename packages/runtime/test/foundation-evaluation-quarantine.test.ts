import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import pg from "pg";
import { Effect } from "effect";
import { expect, it } from "vitest";
import { Engine,sha256,stableJson } from "../src/engine.js";
import type { Snapshot } from "../src/portability.js";
import { Model,type AppBundle } from "../src/model.js";
import { testLayer } from "../src/testing.js";
import { D1Storage } from "../src/adapters/d1.js";
import { PostgresStorage,rawPgExecutor,toPositional } from "../src/adapters/postgres.js";
import type { SqlExecutor,SqlStatement } from "../src/adapters/sql-executor.js";
import { MemoryObjectStore } from "../src/adapters/memory-objects.js";
import { Artifacts } from "../src/foundation/artifact.js";
import { Evaluations } from "../src/foundation/evaluation.js";
import { Publications } from "../src/foundation/publication.js";
import { Knowledge } from "../src/foundation/knowledge.js";
import { localAuthorizer } from "../src/gatekeeper.js";

const e="@forgegraph/foundation/evaluation/_/",p="@forgegraph/foundation/publication/_/",k="@forgegraph/foundation/knowledge/_/",a="@forgegraph/foundation/artifact/_/",s="@forgegraph/foundation/specification/_/",c="@forgegraph/foundation/classification/_/",i="@forgegraph/foundation/identifiers/_/",en="@forgegraph/foundation/entitlement/_/";
const run=Effect.runPromise;
async function database(provider:string){
 const fixture=process.env.FORGE_FOUNDATION_QUARANTINE_BUNDLE??resolve(import.meta.dirname,"../../../conformance/fixtures/knowledge-consumer");
 const model=new Model(JSON.parse(readFileSync(resolve(fixture,"app.json"),"utf8")) as AppBundle),objects=new MemoryObjectStore();
 const sqlite=new DatabaseSync(":memory:");
 let pool:pg.Pool|undefined;
 const schema="quarantine_"+randomUUID().replaceAll("-","");
 if(provider==="postgres"){
  pool=new pg.Pool({connectionString:process.env.FORGE_FOUNDATION_PG_URL,options:`-c search_path=${schema}`,max:3});
  await pool.query(`CREATE SCHEMA ${schema}`);await pool.query(readFileSync(resolve(fixture,"postgres/0001_init.sql"),"utf8"));
 }else sqlite.exec(readFileSync(resolve(fixture,"d1/0001_init.sql"),"utf8"));
 const statement=(q:SqlStatement)=>({changes:Number(sqlite.prepare(q.sql).run(...q.params as SQLInputValue[]).changes)});
 const executor:SqlExecutor={facade:"quarantine-sqlite",first:async <T>(q:SqlStatement)=>(sqlite.prepare(q.sql).get(...q.params as SQLInputValue[])??null) as T|null,all:async <T>(q:SqlStatement)=>sqlite.prepare(q.sql).all(...q.params as SQLInputValue[]) as T[],run:async q=>statement(q),batch:async queries=>{sqlite.exec("BEGIN");try{const result=queries.map(statement);sqlite.exec("COMMIT");return result;}catch(error){sqlite.exec("ROLLBACK");throw error;}}};
 const engine=new Engine(model,testLayer(pool?new PostgresStorage(rawPgExecutor(pool),model):new D1Storage(executor,model),{objects}));
 const ctx={tenant:"migration",actor:"operator",requestId:"rehearsal"};
 return{engine,ctx,objects,call:(op:string,input:Record<string,unknown>)=>run(engine.call(op,input,ctx)),sql:async(sql:string,params:unknown[]=[])=>{if(pool)await pool.query(toPositional(sql),params);else sqlite.prepare(sql).run(...params as SQLInputValue[]);},close:async()=>{sqlite.close();if(pool){try{await pool.query(`DROP SCHEMA ${schema} CASCADE`);}finally{await pool.end();}}}};
}
for(const provider of process.env.FORGE_FOUNDATION_PG_URL?["sqlite","postgres"]:["sqlite"]){
 it(`${provider}: fenced legacy timestamp backfill quarantines Publication and Knowledge authority`,async()=>{
  const f=await database(provider),{engine,ctx,call}=f;
  try{
   const evaluations=new Evaluations(engine),publications=new Publications(engine),knowledge=new Knowledge(engine);
   const repository=await call(s+"Repository.create",{key:"migration",provider:"git",locator:"https://example.test/migration"});
   const pin=await call(s+"SpecificationPin.create",{repository:repository.id,anchor:"release",revision:"a".repeat(40)});
   const artifact=await call(a+"Artifact.create",{key:"guide",label:"Guide"}),content=await call(a+"ArtifactContent.create",{});
   const upload=await call(a+"ArtifactContent.beginUpload",{id:content.id,expectedVersion:1,mediaType:"text/plain",byteCount:4});
   await f.objects.simulateUpload((upload.upload as {url:string}).url,new TextEncoder().encode("body"),"text/plain");
   const sealed=await call(a+"ArtifactContent.finalizeUpload",{id:content.id,expectedVersion:2});
   const revision=await run(new Artifacts(engine).publish({artifact:String(artifact.id),content:String(content.id),digest:String(sealed.digest),specificationPin:String(pin.id)},ctx));
   const series=await call(p+"PublicationSeries.create",{key:"guide",label:"Guide"}),audience=await call("@forgegraph/foundation/participation/_/ParticipationSet.create",{label:"Readers"});
   const channel=await call(p+"PublicationChannel.create",{series:series.id,name:"stable",audience:audience.id});
   const plain=await run(publications.register({series:String(series.id),version:"unassessed",specification:String(pin.id),artifact:String(revision.id),policy:"None"},ctx));
   await run(publications.qualify(String(plain.id),{},ctx));await run(publications.publish(String(plain.id),String(channel.id),ctx));
   const promoted=(await run(publications.state(String(series.id),ctx))).events[0]!;
   const audienceLink=await run(publications.audience(String(promoted.id),ctx));
   const identifiers=await call(i+"IdentifierSet.create",{label:"Taxonomy"}),conceptIds=await call(i+"IdentifierSet.create",{label:"Concept"});
   const taxonomy=await call(c+"Taxonomy.create",{key:"guide",identifiers:identifiers.id}),concept=await call(c+"Concept.create",{taxonomy:taxonomy.id,ordinal:1,identifiers:conceptIds.id,parent:null});
   const meaning=await call(c+"ConceptRevision.create",{concept:concept.id,taxonomy:taxonomy.id,ordinal:1,revision:1,label:"Guide",definition:"Guidance"});
   const classifications=await call(c+"ClassificationSet.create",{label:"Guide"}),assignment=await call(c+"ClassificationAssignment.create",{classifications:classifications.id,meaning:meaning.id,recordedAt:"2025-01-01T00:00:00Z"});
   const scope=await call(en+"EntitlementScope.create",{label:"Library"}),right=await call(en+"RightDefinition.create",{namespace:"guide",name:"read"});
   const item=await call(k+"KnowledgeItem.create",{key:"guide",title:"Guide",accessRight:right.id,scope:scope.id});
   const knowledgeRevision=await run(knowledge.createRevision({item:String(item.id),specification:String(pin.id),content:String(revision.id),classifications:[String(assignment.id)],assessmentDefinition:String(pin.id)},ctx));
   const edition=await run(knowledge.publish(String(knowledgeRevision.id),String(audienceLink.id),ctx));
   const set=await call(e+"EvaluationSet.create",{label:"Legacy assessments"}),executor=await call(e+"EvaluationExecutor.create",{key:"legacy",label:"Legacy"});
   const legacy=await run(evaluations.create({evaluationSet:String(set.id),definition:String(pin.id),executor:String(executor.id)},ctx));
   const legacyStart=await run(evaluations.start(String(legacy.id),"2025-12-01T00:00:00Z",ctx));
   const finish=await run(evaluations.finish(String(legacy.id),"Completed","2025-12-02T00:00:00Z","Historical result",ctx));
   const candidate=await run(publications.register({series:String(series.id),version:"legacy",specification:String(pin.id),artifact:String(revision.id),policy:"EvaluationCompleted",evaluationDefinition:String(pin.id)},ctx));
   const binding=await call(p+"CandidateEvaluation.create",{candidate:candidate.id,run:legacy.id});
   const feedback=await call(k+"KnowledgeFeedback.create",{edition:edition.id,revision:knowledgeRevision.id,run:legacy.id});
   const fence="@fixture/knowledge-consumer/_/admin.fence";
   await call(fence,{on:true});
   await expect(call(e+"EvaluationSet.create",{label:"Blocked during migration"})).rejects.toMatchObject({code:"WriteFenced"});
   // Rehearse a legacy table without server timestamps, then a plausible but
   // historically meaningless migration-time backfill. Direct SQL is confined
   // to this isolated fenced migration; ordinary Engine mutations stay fenced.
   await f.sql('ALTER TABLE evaluation_start DROP COLUMN created_at');
   await f.sql('ALTER TABLE evaluation_start DROP COLUMN updated_at');
   const backfilled="2026-01-02T00:00:00.000Z";
   await f.sql("ALTER TABLE evaluation_start ADD COLUMN created_at TEXT NOT NULL DEFAULT '2026-01-02T00:00:00.000Z'");
   await f.sql("ALTER TABLE evaluation_start ADD COLUMN updated_at TEXT NOT NULL DEFAULT '2026-01-02T00:00:00.000Z'");
   const digest=await sha256(stableJson({run:legacy,finish,startedAt:legacyStart.startedAt}));
   await f.sql('INSERT INTO evaluation_quarantine (tenant,id,run,source_digest,reason,recorded_by,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)',[ctx.tenant,"quarantined-legacy",legacy.id,digest,"Legacy start has no trustworthy server chronology",ctx.actor,backfilled,backfilled]);
   await expect(f.sql('INSERT INTO evaluation_quarantine (tenant,id,run,source_digest,reason,recorded_by,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)',[ctx.tenant,"duplicate-legacy",legacy.id,digest,"Duplicate",ctx.actor,backfilled,backfilled])).rejects.toThrow();
   await call(fence,{on:false});
   const restored=await call(e+"EvaluationStart.get",{id:legacyStart.id});
   expect(Date.parse(String(restored.createdAt))).toBeGreaterThan(Date.parse(String(binding.createdAt)));
   expect(Date.parse(String(restored.createdAt))).toBeGreaterThan(Date.parse(String(feedback.createdAt)));
   expect(await call(e+"EvaluationFinish.get",{id:finish.id})).toEqual(finish);
   expect(await run(evaluations.phase(String(legacy.id),ctx))).toBe("Completed");
   const quarantined={code:"ValidationFailed",detail:"Evaluation is quarantined; execute a new run with fresh bindings"};
   await expect(run(publications.qualify(String(candidate.id),{evaluation:String(finish.id)},ctx))).rejects.toMatchObject(quarantined);
   await call(p+"CandidateQualification.create",{candidate:candidate.id,policy:"EvaluationCompleted",evaluation:finish.id,decision:null});
   await expect(run(publications.publish(String(candidate.id),String(channel.id),ctx))).rejects.toMatchObject(quarantined);
   await expect(run(knowledge.finishFeedback(String(feedback.id),String(finish.id),ctx))).rejects.toMatchObject(quarantined);
   await expect(call(e+"EvaluationQuarantine.delete",{id:"quarantined-legacy"})).rejects.toThrow();
   const hidden=new Engine(engine.model,engine.layer);
   hidden.gatekeeper.authorizer=localAuthorizer({policies:engine.model.resources.filter(r=>r.id!==e+"EvaluationQuarantine").map(r=>({id:r.id,actions:[r.id+".*"],requires:[],where:[]})),pips:[],epoch:1,knownObligations:[]});
   await expect(run(new Evaluations(hidden).result(String(finish.id),ctx))).rejects.toMatchObject({code:"NotFound"});
   const fresh=await run(evaluations.create({evaluationSet:String(set.id),definition:String(pin.id),executor:String(executor.id),parent:String(legacy.id)},ctx));
   const freshCandidate=await run(publications.register({series:String(series.id),version:"reevaluated",specification:String(pin.id),artifact:String(revision.id),policy:"EvaluationCompleted",evaluationDefinition:String(pin.id)},ctx));
   await run(publications.attachEvaluation(String(freshCandidate.id),String(fresh.id),ctx));
   const freshFeedback=await run(knowledge.feedback(String(edition.id),String(fresh.id),ctx));
   await run(evaluations.start(String(fresh.id),"2026-01-03T00:00:00Z",ctx));
   const freshFinish=await run(evaluations.finish(String(fresh.id),"Completed","2026-01-04T00:00:00Z","Fresh execution",ctx));
   await run(publications.qualify(String(freshCandidate.id),{evaluation:String(freshFinish.id)},ctx));
   expect((await run(publications.publish(String(freshCandidate.id),String(channel.id),ctx))).candidate).toBe(freshCandidate.id);
   expect((await run(knowledge.finishFeedback(String(freshFeedback.id),String(freshFinish.id),ctx))).finish).toBe(freshFinish.id);
  }finally{await f.close();}
 });
}

for(const provider of process.env.FORGE_FOUNDATION_PG_URL?["sqlite","postgres"]:["sqlite"]){
 it(`${provider}: prepared legacy export imports quarantine before reopening writes`,async()=>{
  const source=await database(provider),target=await database(provider);
  try{
   const repository=await source.call(s+"Repository.create",{key:"legacy-export",provider:"git",locator:"https://example.test/legacy"});
   const definition=await source.call(s+"SpecificationPin.create",{repository:repository.id,anchor:"evaluation",revision:"c".repeat(40)});
   const set=await source.call(e+"EvaluationSet.create",{label:"Legacy"}),executor=await source.call(e+"EvaluationExecutor.create",{key:"legacy-export",label:"Legacy"});
   const evaluations=new Evaluations(source.engine);
   const legacy=await run(evaluations.create({evaluationSet:String(set.id),definition:String(definition.id),executor:String(executor.id)},source.ctx));
   const start=await run(evaluations.start(String(legacy.id),"2025-01-01T00:00:00Z",source.ctx));
   const finish=await run(evaluations.finish(String(legacy.id),"Completed","2025-01-02T00:00:00Z","Historical completed assessment",source.ctx));
   const admin="@fixture/knowledge-consumer/_/admin.";
   await source.call(admin+"fence",{on:true});
   const exported=await source.call(admin+"export",{});
   const {prepareEvaluationMigration,hashRecords}=await import(resolve(import.meta.dirname,"../../../scripts/prepare-evaluation-migration.mjs"));
   const snapshot=structuredClone(exported) as unknown as Snapshot;
   for(const row of snapshot.resources[e+"EvaluationStart"]!.records){delete row.createdAt;delete row.updatedAt;}
   snapshot.resources[e+"EvaluationStart"]!.hash=hashRecords(snapshot.resources[e+"EvaluationStart"]!.records);
   delete snapshot.resources[e+"EvaluationQuarantine"];
   snapshot.manifest.resources=snapshot.manifest.resources.filter((id:string)=>id!==e+"EvaluationQuarantine");
   const prepared=prepareEvaluationMigration(snapshot,target.engine.model.bundle,{recordedBy:"migration-operator",recordedAt:"2026-09-23T00:00:00Z"});
   expect(prepared.report).toMatchObject({quarantinedRuns:1,storageTimestampsAdded:1,productionMigrationExecuted:false});
   expect(prepared.snapshot.resources[e+"EvaluationFinish"]).toEqual(snapshot.resources[e+"EvaluationFinish"]);
   await target.call(admin+"fence",{on:true});
   await expect(target.call(e+"EvaluationSet.create",{label:"Premature traffic"})).rejects.toMatchObject({code:"WriteFenced"});
   const imported=await target.call(admin+"import",{snapshot:prepared.snapshot});
   expect((imported.imported as Record<string,number>)[e+"EvaluationQuarantine"]).toBe(1);
   expect(await target.call(admin+"verify",{snapshot:prepared.snapshot})).toMatchObject({ok:true});
   const repeated=await target.call(admin+"import",{snapshot:prepared.snapshot});
   expect((repeated.skipped as Record<string,number>)[e+"EvaluationQuarantine"]).toBe(1);
   expect((await target.call(e+"EvaluationStart.get",{id:start.id})).createdAt).toBe("2026-09-23T00:00:00.000Z");
   await expect(run(new Evaluations(target.engine).result(String(finish.id),target.ctx))).rejects.toMatchObject({detail:"Evaluation is quarantined; execute a new run with fresh bindings"});
   await target.call(admin+"fence",{on:false});
   expect(await target.call(e+"EvaluationFinish.get",{id:finish.id})).toEqual(finish);
   expect(await run(new Evaluations(target.engine).phase(String(legacy.id),target.ctx))).toBe("Completed");
   await expect(run(new Evaluations(target.engine).result(String(finish.id),target.ctx))).rejects.toMatchObject({code:"ValidationFailed"});
  }finally{await source.close();await target.close();}
 });
}
