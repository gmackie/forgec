#!/usr/bin/env node
import {createHash} from 'node:crypto';
import {readFileSync,writeFileSync} from 'node:fs';
import {pathToFileURL} from 'node:url';
const p='@forgegraph/foundation/evaluation/_/';
const stable=v=>Array.isArray(v)?`[${v.map(stable).join(',')}]`:v&&typeof v==='object'?`{${Object.keys(v).sort().map(k=>`${JSON.stringify(k)}:${stable(v[k])}`).join(',')}}`:JSON.stringify(v);
const hash=v=>createHash('sha256').update(stable(v)).digest('hex');
export const hashRecords=records=>hash([...records].sort((a,b)=>String(a.id).localeCompare(String(b.id))));
/** Read-only migration candidate for a complete, explicitly legacy export. Every
 * started legacy run is quarantined before import, regardless of timestamp values. */
export function prepareEvaluationMigration(snapshot,bundle,{recordedBy,recordedAt}={}){
 if(snapshot?.version!=='export/1'||!snapshot.tenant||!snapshot.resources||!bundle?.ir?.modules||snapshot.package!==bundle.ir.package.name)throw new Error('Matching canonical snapshot and target bundle required');
 if(typeof recordedBy!=='string'||!recordedBy.trim()||recordedBy.length>128||typeof recordedAt!=='string'||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(recordedAt)||!Number.isFinite(Date.parse(recordedAt))||new Date(recordedAt).toISOString()!==recordedAt.replace(/(?<=:\d{2})Z$/,'.000Z'))throw new Error('Explicit migration actor and recording time required');
 if(snapshot.excluded?.workflowInstances!==0)throw new Error('Drain in-flight workflows before migration');
 const declared=bundle.ir.modules.flatMap(m=>m.resources??[]).map(r=>r.id);
 if(!declared.includes(p+'EvaluationQuarantine'))throw new Error('Target bundle lacks EvaluationQuarantine');
 const manifest=snapshot.manifest?.resources;
 if(!Array.isArray(manifest)||new Set(manifest).size!==manifest.length||Object.keys(snapshot.resources).length!==manifest.length)throw new Error('Incomplete source resource manifest');
 for(const [id,ex] of Object.entries(snapshot.resources)){
  if(!manifest.includes(id)||!declared.includes(id)||!Array.isArray(ex.records)||ex.count!==ex.records.length||ex.hash!==hashRecords(ex.records))throw new Error(`Unverified or unmapped source resource ${id}`);
  if(new Set(ex.records.map(r=>r.id)).size!==ex.records.length||ex.records.some(r=>typeof r?.id!=='string'||!r.id))throw new Error(`Duplicate or missing record identity ${id}`);
 }
 const starts=snapshot.resources[p+'EvaluationStart']?.records,runs=snapshot.resources[p+'EvaluationRun']?.records;
 if(!starts||!runs)throw new Error('Complete legacy EvaluationStart and EvaluationRun exports required');
 const runIds=new Set(runs.map(r=>r.id));const sourceDigest=hash(snapshot),out=structuredClone(snapshot),at=new Date(recordedAt).toISOString();
 const quarantines=[...(out.resources[p+'EvaluationQuarantine']?.records??[])],seen=new Set(quarantines.map(r=>r.run)),startedRuns=new Set();
 if(seen.size!==quarantines.length||quarantines.some(q=>!runIds.has(q.run)))throw new Error('Existing quarantine has missing or duplicate run');
 const finishes=out.resources[p+'EvaluationFinish']?.records;
 if(!finishes)throw new Error('Complete legacy EvaluationFinish export required');
 const startById=new Map(starts.map(start=>[start.id,start]));
 if(finishes.some(f=>!runIds.has(f.run)||(f.start==null?f.outcome!=='Cancelled':startById.get(f.start)?.run!==f.run)))throw new Error('Legacy finish has missing or mismatched start/run');
 for(const start of starts){
  if(!runIds.has(start.run)||startedRuns.has(start.run))throw new Error('Legacy start has missing or duplicate run');startedRuns.add(start.run);
  if(!seen.has(start.run))quarantines.push({id:'migration_eval_'+hash([snapshot.tenant,start.run]).slice(0,32),run:start.run,sourceDigest,reason:'Legacy evaluation chronology requires fresh execution',recordedBy,createdAt:at,updatedAt:at});
 }
 // Add storage timestamps only where the target requires them; quarantine denies
 // all authority regardless of plausible pre-existing or newly recorded dates.
 let timestamped=0;
 for(const start of out.resources[p+'EvaluationStart'].records){if(start.createdAt==null){start.createdAt=at;timestamped++;}if(start.updatedAt==null)start.updatedAt=at;}
 out.resources[p+'EvaluationQuarantine']={records:quarantines,count:quarantines.length,hash:hashRecords(quarantines)};
 const changed=out.resources[p+'EvaluationStart'];changed.hash=hashRecords(changed.records);
 for(const id of declared)if(!out.resources[id])out.resources[id]={records:[],count:0,hash:hashRecords([])};
 out.manifest={contractsVersion:bundle.contracts.version,buildHash:bundle.buildHash,resources:declared};
 return{snapshot:out,report:{version:1,sourceDigest,targetBuildHash:bundle.buildHash,tenant:snapshot.tenant,legacyStarts:starts.length,quarantinedRuns:startedRuns.size,storageTimestampsAdded:timestamped,recordedBy,recordedAt:at,status:'prepared-for-fenced-rehearsal',productionMigrationExecuted:false}};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 try{const [source,target,output,actor,at]=process.argv.slice(2);if(!source||!target||!output||!actor||!at)throw new Error('Usage: prepare-evaluation-migration.mjs source.json target-app.json output.json actor recordedAt');const result=prepareEvaluationMigration(JSON.parse(readFileSync(source)),JSON.parse(readFileSync(target)),{recordedBy:actor,recordedAt:at});writeFileSync(output,JSON.stringify(result,null,2)+'\n',{flag:'wx'});console.log(JSON.stringify(result.report));}catch(e){console.error(e.message);process.exitCode=1;}
}
