import { Effect } from 'effect';
import { expect,it } from 'vitest';
import { foundation,foundationAdapters } from './helpers/foundation.js';
import { Records } from '../src/foundation/records.js';
import { Artifacts } from '../src/foundation/artifact.js';
import { Evidence } from '../src/foundation/evidence.js';
import { localAuthorizer } from '../src/gatekeeper.js';
const p='@forgegraph/foundation/records/_/',d='@fixture/records-consumer/_/',e='@forgegraph/foundation/evidence/_/';
const start='2026-01-01T00:00:00Z',due='2026-01-31T00:00:00Z';
for(const adapter of foundationAdapters)it(`${adapter}: retention, overlapping holds, disposition races and retained history`,async()=>{
 const f=await foundation('records',adapter,true);const {call,engine,ctx}=f;const service=new Records(engine);
 try{
  const bundle=await call(e+'EvidenceBundle.create',{key:'retention',label:'Records authority'});
  const seal=await Effect.runPromise(new Evidence(engine).seal(String(bundle.id),null,ctx));
  const ci='@forgegraph/foundation/classification/_/',ids='@forgegraph/foundation/identifiers/_/';
  const identifiers=await call(ids+'IdentifierSet.create',{label:'Records taxonomy'});
  const taxonomy=await call(ci+'Taxonomy.create',{key:'records',identifiers:identifiers.id});
  const concept=await call(ci+'Concept.create',{taxonomy:taxonomy.id,ordinal:1,identifiers:identifiers.id,parent:null});
  const meaning=await call(ci+'ConceptRevision.create',{concept:concept.id,taxonomy:taxonomy.id,ordinal:1,revision:1,label:'Regulated record',definition:'Evidence retained after closure'});
  const category=await call(p+'RecordCategory.create',{label:'Regulated records',meaning:meaning.id});
  async function register(disposition:string){
   const rule=await call(p+'RetentionRule.create',{category:category.id,trigger:'BusinessClosed',periodDays:30,disposition,authority:'Records officer',source:'illustrative:policy/v1',support:seal.id});
   const row=await Effect.runPromise(service.register(String(rule.id),start,ctx,String(seal.id)));
   expect(Date.parse(String(row.retainUntil))).toBe(Date.parse(due));return row;
  }
  for(const [kind,name,field] of [['Archive','ComplianceInvoice','invoiceNumber'],['Destroy','ApplicantData','applicantCode'],['Anonymize','LitigationFile','caseNumber'],['Transfer','ComplianceInvoice','invoiceNumber']]){
   const row=await register(kind!);await call(d+name+'.create',{record:row.id,[field!]:'domain-1'});
   await expect(Effect.runPromise(service.dispose(String(row.id),start,'Premature','Officer',ctx))).rejects.toThrow();
   const first=await Effect.runPromise(service.hold(String(row.id),start,'Litigation','Court',ctx,String(seal.id)));
   const second=await Effect.runPromise(service.hold(String(row.id),start,'Regulatory investigation','Regulator',ctx));
   await expect(Effect.runPromise(service.dispose(String(row.id),due,'Due','Officer',ctx))).rejects.toThrow();
   await Effect.runPromise(service.release(String(row.id),String(first.id),due,'Court release','Court',ctx));
   await expect(Effect.runPromise(service.release(String(row.id),String(first.id),due,'Duplicate release','Court',ctx))).rejects.toThrow();
   await expect(Effect.runPromise(service.dispose(String(row.id),due,'Still held','Officer',ctx))).rejects.toThrow();
   await Effect.runPromise(service.release(String(row.id),String(second.id),due,'Investigation ended','Regulator',ctx));
   const decision=await Effect.runPromise(service.dispose(String(row.id),due,'Policy elapsed','Records officer',ctx,String(seal.id)));
   const state=await Effect.runPromise(service.state(String(row.id),ctx));expect(state.disposed).toBe(true);expect(state.events).toHaveLength(5);expect(state.rule.disposition).toBe(kind);
   expect(await call(p+'Record.get',{id:row.id})).toMatchObject({support:seal.id});
   await expect(call(p+'RecordEvent.delete',{id:decision.id})).rejects.toThrow();
   await expect(Effect.runPromise(service.hold(String(row.id),due,'Late hold','Court',ctx))).rejects.toThrow();
  }
  const artifactPrefix='@forgegraph/foundation/artifact/_/';
  const artifact=await call(artifactPrefix+'Artifact.create',{key:'compliance',label:'Compliance record'});
  const content=await call(artifactPrefix+'ArtifactContent.create',{});
  const upload=await call(artifactPrefix+'ArtifactContent.beginUpload',{id:content.id,expectedVersion:1,mediaType:'application/octet-stream',byteCount:1});
  await f.objects.simulateUpload((upload.upload as {url:string}).url,new TextEncoder().encode('a'),'application/octet-stream');
  const sealed=await call(artifactPrefix+'ArtifactContent.finalizeUpload',{id:content.id,expectedVersion:2});
  const revision=await Effect.runPromise(new Artifacts(engine).publish({artifact:String(artifact.id),content:String(content.id),digest:String(sealed.digest)},ctx));
  const artifactRecord=await register('Archive');
  expect(await call(p+'ArtifactRecord.create',{record:artifactRecord.id,revision:revision.id})).toMatchObject({revision:revision.id});
  const raced=await register('Destroy');
  const outcomes=await Promise.allSettled([
   Effect.runPromise(service.hold(String(raced.id),due,'Race hold','Court',ctx)),
   Effect.runPromise(service.dispose(String(raced.id),due,'Race disposition','Officer',ctx)),
  ]);
  expect(outcomes.filter(o=>o.status==='fulfilled')).toHaveLength(1);
  const state=await Effect.runPromise(service.state(String(raced.id),ctx));expect(state.events).toHaveLength(1);expect(state.disposed?state.holds.size===0:state.holds.size===1).toBe(true);
  await expect(Effect.runPromise(service.state(String(raced.id),{...ctx,tenant:'other'}))).rejects.toThrow();
  const hidden=await register('Destroy');
  await Effect.runPromise(service.hold(String(hidden.id),due,'Hidden legal hold','Court',ctx));
  const invalid=await call(p+'Record.create',{rule:hidden.rule,trigger:hidden.trigger,triggeredAt:start,retainUntil:start,support:null});
  await expect(Effect.runPromise(service.dispose(String(invalid.id),due,'Forged deadline','Officer',ctx))).rejects.toMatchObject({code:'ValidationFailed',detail:expect.stringContaining('deadline')});
  await expect(Effect.runPromise(service.release(String(hidden.id),String(state.events[0]!.id),due,'Wrong record','Officer',ctx))).rejects.toThrow();
  engine.gatekeeper.authorizer=localAuthorizer({policies:[{id:'record',actions:[p+'Record.*',p+'RetentionRule.*',p+'RecordCategory.*'],requires:[],where:[]}],pips:[],epoch:2,knownObligations:[]});
  await expect(Effect.runPromise(service.state(String(raced.id),ctx))).rejects.toThrow();
  engine.gatekeeper.authorizer=localAuthorizer({policies:[{id:'read',actions:[p+'Record.*',p+'RetentionRule.*',p+'RecordCategory.*',e+'*'],requires:[],where:[]}],pips:[],epoch:3,knownObligations:[]});
  await expect(Effect.runPromise(service.dispose(String(hidden.id),due,'Invisible hold must block','Officer',ctx))).rejects.toThrow();
 }finally{await f.close();}
});
