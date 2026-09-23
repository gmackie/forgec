#!/usr/bin/env node
import {createHash} from 'node:crypto';
import {readFileSync,writeFileSync} from 'node:fs';
import {pathToFileURL} from 'node:url';
import {auditMigration} from './audit-foundation-migration.mjs';
import {prepareEvaluationMigration,hashRecords} from './prepare-evaluation-migration.mjs';

const participation='@forgegraph/foundation/participation/_/';
const party='@forgegraph/foundation/party/_/Party';
const legacy=participation+'Participant';
const evaluation='@forgegraph/foundation/evaluation/_/';
const agreement='@forgegraph/foundation/agreement-catalog/_/';
const quote='@forgegraph/foundation/quotation-pricing/_/QuoteEnd';
const stable=v=>Array.isArray(v)?`[${v.map(stable).join(',')}]`:v&&typeof v==='object'?`{${Object.keys(v).sort().map(k=>`${JSON.stringify(k)}:${stable(v[k])}`).join(',')}}`:JSON.stringify(v);
export const migrationDigest=v=>createHash('sha256').update(stable(v)).digest('hex');
const equal=(a,b)=>stable(a)===stable(b);
const present=v=>typeof v==='string'&&v.trim().length>0;
const entry=records=>({records,count:records.length,hash:hashRecords(records)});
function requireThat(ok,message){if(!ok)throw new Error(message);}
function resources(bundle){
 requireThat(Array.isArray(bundle?.ir?.modules)&&present(bundle?.buildHash)&&present(bundle?.contracts?.version),'Complete compiled bundle required');
 const rows=bundle.ir.modules.flatMap(m=>m.resources??[]);
 requireThat(rows.every(r=>present(r.id)&&Array.isArray(r.fields))&&new Set(rows.map(r=>r.id)).size===rows.length,'Invalid resource declarations');
 return new Map(rows.map(r=>[r.id,r]));
}
function uniqueRows(rows,label){
 requireThat(Array.isArray(rows)&&rows.every(r=>r&&present(r.id))&&new Set(rows.map(r=>r.id)).size===rows.length,`${label}: unique record IDs required`);
}
function checkSnapshot(snapshot,bundle,declared){
 requireThat(snapshot?.version==='export/1'&&present(snapshot.tenant)&&snapshot.package===bundle.ir.package.name,'Canonical source snapshot required');
 requireThat(snapshot.manifest?.buildHash===bundle.buildHash&&snapshot.manifest?.contractsVersion===bundle.contracts.version,'Snapshot does not match source bundle');
 requireThat(Array.isArray(snapshot.manifest.resources)&&equal([...snapshot.manifest.resources].sort(),[...declared.keys()].sort())&&equal(Object.keys(snapshot.resources??{}).sort(),[...declared.keys()].sort()),'Source manifest must contain every declared source resource');
 requireThat(snapshot.excluded?.workflowInstances===0,'Drain source workflows before preparation');
 for(const [id,ex] of Object.entries(snapshot.resources)){
  uniqueRows(ex?.records,id);
  requireThat(ex.count===ex.records.length&&ex.hash===hashRecords(ex.records),`Unverified source resource ${id}`);
  requireThat(ex.records.every(r=>!Object.hasOwn(r,'tenant')||r.tenant===snapshot.tenant),`Foreign tenant row in ${id}`);
 }
}
const targetOf=field=>field.type?.base?.kind==='reference'?field.type.base.resource:null;
const nullAdditions=new Map([[agreement+'Agreement',new Map([['acceptance',agreement+'AgreementAcceptanceCommit']])],[quote,new Map([['intent',agreement+'AgreementAcceptance'],['acceptanceDigest',null]])]]);

/** Narrow legacy migration. This transforms verified records, never authorizes
 * cutover or infers identity, principal representation, or acceptance proof. */
export function composeFoundationMigration(snapshot,sourceBundle,targetBundle,review){
 const source=resources(sourceBundle),target=resources(targetBundle);
 checkSnapshot(snapshot,sourceBundle,source);
 requireThat(sourceBundle.ir.package.name===targetBundle.ir.package.name,'Source and target package mismatch');
 const sourceDigest=migrationDigest(snapshot);
 requireThat(review?.version===1&&review.tenant===snapshot.tenant&&review.sourceDigest===sourceDigest&&review.sourceBuildHash===sourceBundle.buildHash&&review.targetBuildHash===targetBundle.buildHash&&review.sourceBundleDigest===migrationDigest(sourceBundle)&&review.targetBundleDigest===migrationDigest(targetBundle),'Review manifest is not bound to these exact inputs');
 requireThat(present(review.reviewedBy)&&present(review.recordedAt),'Explicit reviewer and recording time required');
 requireThat(review.legacyAcceptedQuotes==='block'&&review.ordinaryAgreements==='preserve-without-acceptance','Explicit legacy acceptance treatment required');
 requireThat(source.has(legacy)&&target.has(party)&&!target.has(legacy),'Expected Participant to Party schema transition');
 const out=structuredClone(snapshot),unresolved=[];
 const mappings=review.identity?.mapping,parties=review.identity?.parties;
 uniqueRows(parties,'Proposed Party rows');
 requireThat(Array.isArray(mappings),'Explicit identity mapping required');
 requireThat(parties.every(r=>r.tenant===snapshot.tenant),'Proposed Parties require the source tenant');
 for(const row of parties){
  requireThat(Object.keys(row).every(key=>['tenant','id','label','identifiers','createdAt','updatedAt'].includes(key))&&present(row.label)&&row.label.length<=200&&Object.hasOwn(row,'identifiers')&&(row.identifiers===null||present(row.identifiers)),'Proposed Party requires explicit label/identifiers and no inferred domain fields');
  for(const name of ['createdAt','updatedAt'])requireThat(typeof row[name]==='string'&&Number.isFinite(Date.parse(row[name]))&&new Date(row[name]).toISOString()===row[name],`Proposed Party requires canonical explicit ${name}`);
  requireThat(row.updatedAt>=row.createdAt,'Invalid proposed Party chronology');
 }
 const oldRows=snapshot.resources[legacy].records;
 const byOld=new Map(),used=new Set(),partyIds=new Set(parties.map(r=>r.id));
 for(const m of mappings){
  requireThat(m?.tenant===snapshot.tenant&&present(m.participant)&&present(m.party)&&!byOld.has(m.participant)&&!used.has(m.party),'Invalid, foreign-tenant or many-to-one identity mapping');
  requireThat(oldRows.some(r=>r.id===m.participant)&&partyIds.has(m.party),'Mapping must reference source Participant and proposed Party');
  byOld.set(m.participant,m.party);used.add(m.party);
 }
 requireThat(byOld.size===oldRows.length&&used.size===parties.length,'Every legacy identity and proposed Party requires exactly one mapping');
 const oldParties=snapshot.resources[party]?.records??[];
 requireThat(!oldParties.some(r=>partyIds.has(r.id)),'Proposed Party collides with retained identity');
 out.resources[party]=entry([...oldParties,...parties.map(({tenant,...record})=>record)]);
 const referenceFields=[];
 for(const [id,resource] of source){
  if(id===legacy){delete out.resources[id];continue;}
  if(!target.has(id)){
   requireThat(snapshot.resources[id].records.length===0,`Unresolved removed resource ${id}; explicit satellite/representation migration required`);
   delete out.resources[id];continue;
  }
  const to=target.get(id),nextFields=new Map(to.fields.map(f=>[f.name,f]));
  for(const field of resource.fields){
   const next=nextFields.get(field.name);
   requireThat(next,`Unsupported removed field ${id}.${field.name}`);
   if(targetOf(field)===legacy){
    requireThat(targetOf(next)===party,`Identity reference must target Party: ${id}.${field.name}`);
    const expected=structuredClone(field.type);expected.base.resource=party;
    requireThat(equal(expected,next.type),`Unsupported identity field shape change ${id}.${field.name}`);
    referenceFields.push({resource:id,field:field.name});
    for(const row of out.resources[id].records){
     if(row[field.name]==null){requireThat(field.type.optional,`Missing identity reference ${id}/${row.id}`);continue;}
     requireThat(byOld.has(row[field.name]),`Unmapped identity reference ${id}/${row.id}.${field.name}`);
     row[field.name]=byOld.get(row[field.name]);
    }
   }else requireThat(equal(field.type,next.type),`Unsupported field type change ${id}.${field.name}`);
  }
  const oldFields=new Set(resource.fields.map(f=>f.name));
  for(const field of to.fields.filter(f=>!oldFields.has(f.name))){
   const timestamp=id===evaluation+'EvaluationStart'&&['createdAt','updatedAt'].includes(field.name)&&field.type.base.kind==='scalar'&&field.type.base.name==='datetime';
   const nullable=nullAdditions.get(id)?.has(field.name)&&field.type.optional&&targetOf(field)===nullAdditions.get(id).get(field.name)&&(field.name!=='acceptanceDigest'||field.type.base.kind==='scalar'&&field.type.base.name==='text');
   requireThat(timestamp||nullable,`Unsupported added field ${id}.${field.name}`);
   if(nullable)for(const row of out.resources[id].records){requireThat(row[field.name]==null,`Unexpected legacy acceptance value ${id}/${row.id}`);row[field.name]=null;}
  }
 }
 const refKey=x=>`${x.resource}.${x.field}`;
 requireThat(Array.isArray(review.identity.referenceFields)&&equal(review.identity.referenceFields.map(refKey).sort(),referenceFields.map(refKey).sort()),'Review must enumerate every typed Participant reference field exactly once');
 const additions=[...target.keys()].filter(id=>!source.has(id)&&id!==party&&id!==evaluation+'EvaluationQuarantine').sort();
 requireThat(Array.isArray(review.emptyTargetResources)&&equal([...review.emptyTargetResources].sort(),additions),'Review must explicitly list every other new empty target resource');
 for(const id of [agreement+'AgreementAcceptance',agreement+'AgreementAcceptanceCommit'])
  requireThat(!(snapshot.resources[id]?.records.length),'Existing acceptance proofs require a separate current-schema migration profile');
 for(const row of out.resources[quote]?.records??[]){
  if(row.outcome==='Accepted')unresolved.push({resource:quote,id:row.id,reason:'Legacy Accepted quote lacks reviewed durable intent/commit; operator resolution required'});
 }
 for(const row of out.resources[agreement+'Agreement']?.records??[])
  requireThat(row.acceptance==null,'Legacy Agreement must not acquire synthesized acceptance proof');
 const tenantRows=id=>(snapshot.resources[id]?.records??[]).map(r=>({...r,tenant:snapshot.tenant}));
 const audit=auditMigration({version:1,legacyParticipants:tenantRows(legacy),parties:[...oldParties.map(r=>({...r,tenant:snapshot.tenant})),...parties],mapping:mappings,before:{participations:tenantRows(participation+'Participation'),ends:tenantRows(participation+'ParticipationEnd')},after:{participations:(out.resources[participation+'Participation']?.records??[]).map(r=>({...r,tenant:snapshot.tenant})),ends:tenantRows(participation+'ParticipationEnd')},legacyEvaluationStarts:tenantRows(evaluation+'EvaluationStart')});
 requireThat(audit.status==='ready-for-review',`Party history audit failed: ${audit.errors.join('; ')}`);
 for(const [id,ex] of Object.entries(out.resources))out.resources[id]=entry(ex.records);
 out.manifest.resources=Object.keys(out.resources);
 const prepared=prepareEvaluationMigration(out,targetBundle,{recordedBy:review.reviewedBy,recordedAt:review.recordedAt});
 // The composer, not its intermediate identity-transformed snapshot, is the
 // provenance boundary for newly introduced quarantine records.
 const prior=new Set((snapshot.resources[evaluation+'EvaluationQuarantine']?.records??[]).map(r=>r.id));
 const quarantine=prepared.snapshot.resources[evaluation+'EvaluationQuarantine'];
 for(const row of quarantine.records)if(!prior.has(row.id))row.sourceDigest=sourceDigest;
 prepared.snapshot.resources[evaluation+'EvaluationQuarantine']=entry(quarantine.records);
 validateReferences(prepared.snapshot,target);
 const report={version:1,status:unresolved.length?'blocked':'prepared-for-fenced-rehearsal',sourceDigest,reviewDigest:migrationDigest(review),sourceBuildHash:sourceBundle.buildHash,targetBuildHash:targetBundle.buildHash,tenant:snapshot.tenant,reviewedBy:review.reviewedBy,recordedAt:review.recordedAt,identityCount:mappings.length,referenceFields,unresolved,evaluation:{...prepared.report,intermediateSourceDigest:prepared.report.sourceDigest,sourceDigest},sourceCompletenessProven:false,deploymentAuthorized:false};
 return{snapshot:unresolved.length?null:prepared.snapshot,report};
}
function validateReferences(snapshot,target){
 for(const [id,r] of target){
  const records=snapshot.resources[id].records;
  uniqueRows(records,id);
  for(const row of records)for(const field of r.fields){
   requireThat(row[field.name]!=null||field.type.optional,`Missing target field ${id}/${row.id}.${field.name}`);
   const ref=targetOf(field);
   if(ref&&row[field.name]!=null)requireThat(snapshot.resources[ref]?.records.some(record=>record.id===row[field.name]),`Dangling target reference ${id}/${row.id}.${field.name}`);
  }
 }
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 try{
  const [source,sourceBundle,targetBundle,review,output,...extra]=process.argv.slice(2);
  requireThat(source&&sourceBundle&&targetBundle&&review&&output&&!extra.length,'Usage: foundation-migration-compose.mjs source.json source-app.json target-app.json review.json output.json');
  const read=path=>JSON.parse(readFileSync(path,'utf8'));
  const result=composeFoundationMigration(read(source),read(sourceBundle),read(targetBundle),read(review));
  writeFileSync(output,JSON.stringify(result,null,2)+'\n',{flag:'wx',mode:0o600});
  console.log(JSON.stringify(result.report));if(result.report.status==='blocked')process.exitCode=1;
 }catch(error){console.error(error.message);process.exitCode=1;}
}
