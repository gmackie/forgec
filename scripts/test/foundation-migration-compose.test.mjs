import {test} from 'node:test';
import assert from 'node:assert/strict';
import {composeFoundationMigration,migrationDigest} from '../foundation-migration-compose.mjs';
import {hashRecords} from '../prepare-evaluation-migration.mjs';
import {mkdtempSync,writeFileSync,readFileSync,rmSync,statSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const p='@forgegraph/foundation/participation/_/',e='@forgegraph/foundation/evaluation/_/',a='@forgegraph/foundation/agreement-catalog/_/',q='@forgegraph/foundation/quotation-pricing/_/QuoteEnd',party='@forgegraph/foundation/party/_/Party';
const time='2026-01-01T00:00:00.000Z';
const field=(name,base='text',optional=false)=>({name,type:{base:base.includes('/')?{kind:'reference',resource:base}:{kind:'scalar',name:base,args:[]},optional,normalizers:[],constraints:[]}});
const resource=(id,fields)=>({id,fields:[field('id','id'),...fields]});
const entry=records=>({records,count:records.length,hash:hashRecords(records)});
function bind(f){f.review.sourceDigest=migrationDigest(f.snapshot);f.review.sourceBundleDigest=migrationDigest(f.source);f.review.targetBundleDigest=migrationDigest(f.target);return f;}
export function fixture(){
 const declarations=[
  resource(p+'Participant',[field('label')]),resource(p+'PrincipalParticipant',[field('participant',p+'Participant'),field('principal')]),
  resource(p+'ParticipationSet',[field('label')]),resource(p+'ParticipationRole',[field('name')]),
  resource(p+'Participation',[field('participant',p+'Participant'),field('participationSet',p+'ParticipationSet'),field('role',p+'ParticipationRole'),field('validFrom','datetime'),field('validUntil','datetime',true),field('recordedBy'),field('reason'),field('createdAt','datetime')]),
  resource(p+'ParticipationEnd',[field('participation',p+'Participation'),field('effectiveAt','datetime'),field('revoked','boolean'),field('recordedBy'),field('reason'),field('createdAt','datetime')]),
  resource(e+'EvaluationRun',[]),resource(e+'EvaluationStart',[field('run',e+'EvaluationRun'),field('startedAt','datetime')]),resource(e+'EvaluationFinish',[field('run',e+'EvaluationRun'),field('start',e+'EvaluationStart',true),field('outcome')]),
  resource(a+'Agreement',[field('supplier',p+'Participant'),field('customer',p+'Participant'),field('createdAt','datetime')]),
  resource(q,[field('outcome'),field('createdAt','datetime')]),
  resource('@app/_/MembershipDetail',[field('member',p+'Participant'),field('nativeKey')]),
 ];
 const source={ir:{package:{name:'@app/migration'},modules:[{resources:declarations}]},buildHash:'legacy-build',contracts:{version:'contracts/1'}};
 const target=structuredClone(source);target.buildHash='target-build';
 target.ir.modules[0].resources=target.ir.modules[0].resources.filter(r=>![p+'Participant',p+'PrincipalParticipant'].includes(r.id));
 for(const r of target.ir.modules[0].resources)for(const f of r.fields)if(f.type.base.resource===p+'Participant')f.type.base.resource=party;
 const tr=id=>target.ir.modules[0].resources.find(r=>r.id===id);
 tr(e+'EvaluationStart').fields.push(field('createdAt','datetime'),field('updatedAt','datetime'));
 tr(a+'Agreement').fields.push(field('acceptance',a+'AgreementAcceptanceCommit',true));
 tr(q).fields.push(field('intent',a+'AgreementAcceptance',true),field('acceptanceDigest','text',true));
 target.ir.modules[0].resources.push(resource(party,[field('label'),field('identifiers','id',true),field('createdAt','datetime'),field('updatedAt','datetime')]),resource(a+'AgreementAcceptance',[]),resource(a+'AgreementAcceptanceCommit',[]),resource(e+'EvaluationQuarantine',[field('run',e+'EvaluationRun'),field('sourceDigest'),field('reason'),field('recordedBy'),field('createdAt','datetime'),field('updatedAt','datetime')]));
 const resources=Object.fromEntries(declarations.map(r=>[r.id,entry([])]));
 resources[p+'Participant']=entry([{id:'supplier-old',label:'Supplier'},{id:'customer-old',label:'Customer'}]);
 resources[p+'ParticipationSet']=entry([{id:'set',label:'Signers'}]);resources[p+'ParticipationRole']=entry([{id:'role',name:'signer'}]);
 resources[p+'Participation']=entry([{id:'member',participant:'supplier-old',participationSet:'set',role:'role',validFrom:time,validUntil:null,recordedBy:'admin',reason:'Signer',createdAt:time}]);
 resources[p+'ParticipationEnd']=entry([{id:'ended',participation:'member',effectiveAt:'2026-02-01T00:00:00.000Z',revoked:true,reason:'Revoked',recordedBy:'admin',createdAt:'2026-02-02T00:00:00.000Z'}]);
 resources[e+'EvaluationRun']=entry([{id:'run'},{id:'cancelled-run'}]);resources[e+'EvaluationStart']=entry([{id:'start',run:'run',startedAt:time}]);
 resources[e+'EvaluationFinish']=entry([{id:'finish',run:'run',start:'start',outcome:'Completed'},{id:'cancelled',run:'cancelled-run',start:null,outcome:'Cancelled'}]);
 resources[a+'Agreement']=entry([{id:'contract',supplier:'supplier-old',customer:'customer-old',createdAt:time}]);resources[q]=entry([{id:'rejected',outcome:'Rejected',createdAt:time}]);
 resources['@app/_/MembershipDetail']=entry([{id:'detail',member:'supplier-old',nativeKey:'native-123'}]);
 const snapshot={version:'export/1',tenant:'tenant',package:source.ir.package.name,manifest:{buildHash:source.buildHash,contractsVersion:source.contracts.version,resources:Object.keys(resources)},resources,excluded:{workflowInstances:0}};
 const review={version:1,tenant:'tenant',sourceBuildHash:source.buildHash,targetBuildHash:target.buildHash,reviewedBy:'migration-operator',recordedAt:'2026-09-23T00:00:00Z',legacyAcceptedQuotes:'block',ordinaryAgreements:'preserve-without-acceptance',emptyTargetResources:[a+'AgreementAcceptance',a+'AgreementAcceptanceCommit'],identity:{mapping:[{tenant:'tenant',participant:'supplier-old',party:'supplier-new'},{tenant:'tenant',participant:'customer-old',party:'customer-new'}],parties:[{tenant:'tenant',id:'supplier-new',label:'Supplier',identifiers:null,createdAt:time,updatedAt:time},{tenant:'tenant',id:'customer-new',label:'Customer',identifiers:null,createdAt:time,updatedAt:time}],referenceFields:[{resource:p+'Participation',field:'participant'},{resource:a+'Agreement',field:'supplier'},{resource:a+'Agreement',field:'customer'},{resource:'@app/_/MembershipDetail',field:'member'}]}};
 return bind({snapshot,source,target,review});
}
const prepare=f=>composeFoundationMigration(f.snapshot,f.source,f.target,f.review);
test('composes explicit Party/satellite remapping, preserved history and quarantine without acceptance fabrication',()=>{
 const f=fixture(),before=JSON.stringify(f),result=prepare(f),out=result.snapshot;
 assert.equal(JSON.stringify(f),before);assert.equal(result.report.status,'prepared-for-fenced-rehearsal');assert.equal(result.report.deploymentAuthorized,false);
 assert.equal(out.resources[p+'Participant'],undefined);assert.equal(out.resources[p+'Participation'].records[0].participant,'supplier-new');
 assert.deepEqual(out.resources[p+'ParticipationEnd'],f.snapshot.resources[p+'ParticipationEnd']);
 assert.deepEqual(out.resources['@app/_/MembershipDetail'].records,[{id:'detail',member:'supplier-new',nativeKey:'native-123'}]);
 assert.deepEqual(out.resources[a+'Agreement'].records,[{id:'contract',supplier:'supplier-new',customer:'customer-new',createdAt:time,acceptance:null}]);
 assert.deepEqual(out.resources[e+'EvaluationFinish'],f.snapshot.resources[e+'EvaluationFinish']);
 assert.equal(out.resources[e+'EvaluationQuarantine'].records.length,1);assert.equal(out.resources[e+'EvaluationQuarantine'].records[0].sourceDigest,migrationDigest(f.snapshot));
 assert.equal(out.resources[a+'AgreementAcceptance'].count,0);assert.equal(out.resources[a+'AgreementAcceptanceCommit'].count,0);
 assert.equal(out.manifest.buildHash,f.target.buildHash);
 for(const ex of Object.values(out.resources))assert.equal(ex.hash,hashRecords(ex.records));
});
test('legacy Accepted quote produces explicit unresolved report and no import snapshot',()=>{
 const f=fixture();f.snapshot.resources[q]=entry([{id:'accepted-legacy',outcome:'Accepted',createdAt:time}]);bind(f);
 const result=prepare(f);assert.equal(result.snapshot,null);assert.equal(result.report.status,'blocked');assert.equal(result.report.unresolved[0].id,'accepted-legacy');
});
test('source and review hashes detect drift even when exported record hashes are recomputed',()=>{
 for(const change of [f=>f.snapshot.resources[p+'Participant']=entry([{id:'supplier-old',label:'Changed'}]),f=>f.source.ir.modules[0].resources[0].fields.push(field('extra')),f=>f.target.ir.modules[0].resources[0].fields.push(field('extra')),f=>f.review.tenant='other']){const f=fixture();change(f);assert.throws(()=>prepare(f));}
});
test('requires full declared source manifest rather than accepting self-consistent omissions',()=>{
 const f=fixture();delete f.snapshot.resources[p+'ParticipationEnd'];f.snapshot.manifest.resources=f.snapshot.manifest.resources.filter(id=>id!==p+'ParticipationEnd');bind(f);assert.throws(()=>prepare(f),/every declared source resource/);
});
test('rejects missing, foreign-tenant, duplicate and many-to-one identity reviews',()=>{
 for(const change of [f=>f.review.identity.mapping.pop(),f=>f.review.identity.mapping[0].tenant='other',f=>f.review.identity.mapping.push(f.review.identity.mapping[0]),f=>f.review.identity.mapping[1].party='supplier-new',f=>f.review.identity.parties[0].tenant='other']){const f=fixture();change(f);assert.throws(()=>prepare(f));}
});
test('principal and removed domain satellites require separate explicit migration',()=>{
 const f=fixture();f.snapshot.resources[p+'PrincipalParticipant']=entry([{id:'representation',participant:'supplier-old',principal:'user'}]);bind(f);assert.throws(()=>prepare(f),/Unresolved removed resource/);
});
test('requires exact reviewed identity reference fields and empty target resources',()=>{
 for(const change of [f=>f.review.identity.referenceFields.pop(),f=>f.review.identity.referenceFields.push(f.review.identity.referenceFields[0]),f=>f.review.emptyTargetResources.pop()]){const f=fixture();change(f);assert.throws(()=>prepare(f),/Review must/);}
});
test('rejects incompatible retained field schemas despite matching review hashes',()=>{
 const f=fixture();f.target.ir.modules[0].resources.find(r=>r.id==='@app/_/MembershipDetail').fields.find(v=>v.name==='nativeKey').type.base.name='integer';bind(f);assert.throws(()=>prepare(f),/Unsupported field type change/);
});
test('rejects missing reference data, retained row fields and fabricated acceptance',()=>{
 for(const change of [f=>{f.snapshot.resources[p+'Participation'].records[0].participant='unknown';},f=>{delete f.snapshot.resources[a+'Agreement'].records[0].createdAt;},f=>{f.snapshot.resources[a+'Agreement'].records[0].acceptance='fabricated';}]){
  const f=fixture();change(f);for(const [id,ex] of Object.entries(f.snapshot.resources))f.snapshot.resources[id]=entry(ex.records);bind(f);assert.throws(()=>prepare(f));
 }
});
test('rejects principal invention and malformed proposed Party chronology',()=>{
 for(const change of [r=>r.principal='inferred-user',r=>r.createdAt='yesterday',r=>r.label='',r=>delete r.identifiers,r=>r.updatedAt='2025-01-01T00:00:00.000Z']){const f=fixture();change(f.review.identity.parties[0]);assert.throws(()=>prepare(f),/Party/);}
});
test('CLI writes an exclusive private candidate and reports blocked acceptance without a snapshot',t=>{
 const directory=mkdtempSync(join(tmpdir(),'foundation-migration-'));t.after(()=>rmSync(directory,{recursive:true,force:true}));
 const script=fileURLToPath(new URL('../foundation-migration-compose.mjs',import.meta.url));
 const f=fixture(),paths=['snapshot','source','target','review'].map(key=>{const path=join(directory,key+'.json');writeFileSync(path,JSON.stringify(f[key]));return path;});
 const output=join(directory,'candidate.json');
 let result=spawnSync(process.execPath,[script,...paths,output],{encoding:'utf8'});assert.equal(result.status,0,result.stderr);
 const original=readFileSync(output,'utf8');assert.equal(JSON.parse(original).report.status,'prepared-for-fenced-rehearsal');assert.equal(statSync(output).mode&0o777,0o600);
 result=spawnSync(process.execPath,[script,...paths,output],{encoding:'utf8'});assert.equal(result.status,1);assert.equal(readFileSync(output,'utf8'),original);
 f.snapshot.resources[q]=entry([{id:'accepted',outcome:'Accepted',createdAt:time}]);bind(f);
 writeFileSync(paths[0],JSON.stringify(f.snapshot));writeFileSync(paths[3],JSON.stringify(f.review));
 const blocked=join(directory,'blocked.json');result=spawnSync(process.execPath,[script,...paths,blocked],{encoding:'utf8'});assert.equal(result.status,1);assert.equal(JSON.parse(readFileSync(blocked,'utf8')).snapshot,null);
});
