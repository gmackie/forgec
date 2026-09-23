import { Effect } from 'effect';
import { expect,it } from 'vitest';
import { foundation, foundationAdapters } from './helpers/foundation.js';
import { Assurance } from '../src/foundation/assurance.js';
import { Evaluations } from '../src/foundation/evaluation.js';
import { Artifacts } from '../src/foundation/artifact.js';
import { Evidence } from '../src/foundation/evidence.js';
import { localAuthorizer } from '../src/gatekeeper.js';
const p='@forgegraph/foundation/assurance/_/',v='@forgegraph/foundation/evaluation/_/',s='@forgegraph/foundation/specification/_/',e='@forgegraph/foundation/evidence/_/',d='@fixture/assurance-consumer/_/';
const start='2026-01-01T00:00:00Z',end='2026-02-01T00:00:00Z';
for(const adapter of foundationAdapters)it(`${adapter}: findings, dispositions, corrective work and pinned attestations retain separate history`,async()=>{
 const f=await foundation('assurance',adapter,true);const {call,ctx,engine}=f;
 try{
  const service=new Assurance(engine),evaluations=new Evaluations(engine);
  const repository=await call(s+'Repository.create',{key:'requirements',provider:'git',locator:'https://example.test/requirements'});
  const pin=await call(s+'SpecificationPin.create',{repository:repository.id,anchor:'assurance',revision:'a'.repeat(40)});
  const set=await call(v+'EvaluationSet.create',{label:'Assessment'}),executor=await call(v+'EvaluationExecutor.create',{key:'inspector',label:'Inspector'});
  const bundle=await call(e+'EvidenceBundle.create',{key:'assurance',label:'Proof'});
  const seal=await Effect.runPromise(new Evidence(engine).seal(String(bundle.id),null,ctx));
  async function evaluate(){const run=await Effect.runPromise(evaluations.create({evaluationSet:String(set.id),definition:String(pin.id),executor:String(executor.id)},ctx));await Effect.runPromise(evaluations.start(String(run.id),start,ctx));const finish=await Effect.runPromise(evaluations.finish(String(run.id),'Completed',start,'Performed',ctx,String(seal.id)));return {run,finish};}
  const original=await evaluate();
  const finding=await call(p+'Finding.create',{finish:original.finish.id,run:original.run.id,specification:pin.id,summary:'Condition identified'});
  expect(await Effect.runPromise(service.findingPhase(String(finding.id),ctx))).toBe('Open');
  expect(await Effect.runPromise(evaluations.phase(String(original.run.id),ctx))).toBe('Completed');
  for(const [name,field] of [['Vulnerability','advisory'],['ManufacturingCAPA','lot'],['AccessReview','account'],['ModelAssurance','modelDigest']])expect(await call(d+name+'.create',{finding:finding.id,[field!]:'typed-detail'})).toMatchObject({finding:finding.id});
  const dispositions=await Promise.allSettled(['Remediate','Waived'].map(kind=>Effect.runPromise(service.disposition(String(finding.id),kind as 'Remediate'|'Waived','Reviewed',ctx))));
  expect(dispositions.filter(x=>x.status==='fulfilled')).toHaveLength(1);
  const disposition=(dispositions.find(x=>x.status==='fulfilled') as PromiseFulfilledResult<Record<string,unknown>>).value;
  // First synchronous plan is deliberately Remediate; assert rather than weaken the expected lifecycle.
  expect(disposition.kind).toBe('Remediate');
  const remediation=await call(p+'Remediation.create',{disposition:disposition.id,finding:finding.id,intendedAction:'Correct condition'});
  await call(d+'CorrectiveWork.create',{remediation:remediation.id,instruction:'Domain-owned forward work'});
  expect(await Effect.runPromise(service.remediationPhase(String(remediation.id),ctx))).toBe('Planned');
  await expect(call(p+'RemediationFinish.create',{remediation:remediation.id,disposition:disposition.id,outcome:'Completed',reason:'No re-evaluation'})).rejects.toThrow();
  await expect(call(p+'Reevaluation.create',{remediation:remediation.id,finding:finding.id,finish:original.finish.id,run:original.run.id})).rejects.toThrow();
  const repeated=await evaluate();
  const reevaluation=await call(p+'Reevaluation.create',{remediation:remediation.id,finding:finding.id,finish:repeated.finish.id,run:repeated.run.id});
  const finish=await call(p+'RemediationFinish.create',{remediation:remediation.id,disposition:disposition.id,reevaluation:reevaluation.id,outcome:'Completed',reason:'Correction verified'});
  await call(p+'FindingClosure.create',{finding:finding.id,disposition:disposition.id,remediationFinish:finish.id,reason:'Closed after verification'});
  expect(await Effect.runPromise(service.findingPhase(String(finding.id),ctx))).toBe('Closed');
  expect(await Effect.runPromise(service.remediationPhase(String(remediation.id),ctx))).toBe('Completed');
  for(const kind of ['Accepted','FalsePositive','Waived','Deferred'] as const){
   const followup=await call(p+'Finding.create',{finish:original.finish.id,run:original.run.id,specification:pin.id,summary:kind,predecessor:finding.id});
   const decision=await Effect.runPromise(service.disposition(String(followup.id),kind,'Reviewed reason',ctx));
   await expect(call(p+'Remediation.create',{disposition:decision.id,finding:followup.id,intendedAction:'Invalid'})).rejects.toThrow();
   const closing=call(p+'FindingClosure.create',{finding:followup.id,disposition:decision.id,reason:'Disposition closure'});
   if(kind==='Deferred')await expect(closing).rejects.toThrow();else await closing;
  }
  const cancelled=await call(p+'Remediation.create',{disposition:disposition.id,finding:finding.id,intendedAction:'Alternate action'});
  await call(p+'RemediationFinish.create',{remediation:cancelled.id,disposition:disposition.id,outcome:'Cancelled',reason:'No longer needed'});
  expect(await Effect.runPromise(service.remediationPhase(String(cancelled.id),ctx))).toBe('Cancelled');
  const issuer=await call(p+'AssuranceIssuer.create',{key:'review-board',label:'Review board'});
  const a='@forgegraph/foundation/artifact/_/';
  const artifact=await call(a+'Artifact.create',{key:'assurance-report',label:'Report'});
  const content=await call(a+'ArtifactContent.create',{});
  const upload=await call(a+'ArtifactContent.beginUpload',{id:content.id,expectedVersion:1,mediaType:'text/plain',byteCount:5});
  await f.objects.simulateUpload((upload.upload as {url:string}).url,new TextEncoder().encode('proof'),'text/plain');
  const sealed=await call(a+'ArtifactContent.finalizeUpload',{id:content.id,expectedVersion:2});
  const revision=await Effect.runPromise(new Artifacts(engine).publish({artifact:String(artifact.id),content:String(content.id),digest:String(sealed.digest)},ctx));
  const input={finding:String(finding.id),issuer:String(issuer.id),issuerRecord:'assertion',specification:String(pin.id),finish:String(repeated.finish.id),run:String(repeated.run.id),support:String(seal.id),artifact:String(revision.id),conclusion:'Domain-qualified assertion',validFrom:start,validUntil:'2026-03-01T00:00:00Z'};
  const attestation=await Effect.runPromise(service.issue(input,ctx));
  expect(await Effect.runPromise(service.current(String(attestation.id),start,ctx))).toMatchObject({support:seal.id});
  expect(await Effect.runPromise(service.current(String(attestation.id),'2026-03-01T00:00:00Z',ctx))).toBeNull();
  const replacement=await Effect.runPromise(service.issue({...input,issuerRecord:'successor',validFrom:end},ctx));
  const endings=await Promise.allSettled([Effect.runPromise(service.end(String(attestation.id),end,'Superseded',ctx,String(replacement.id))),Effect.runPromise(service.end(String(attestation.id),end,'Revoked',ctx))]);
  expect(endings.filter(x=>x.status==='fulfilled')).toHaveLength(1);
  expect(await Effect.runPromise(service.current(String(attestation.id),end,ctx))).toBeNull();
  expect(await Effect.runPromise(service.current(String(attestation.id),start,ctx))).not.toBeNull();
  await expect(call(p+'Attestation.create',{...input,issuerRecord:'invalid',support:bundle.id})).rejects.toThrow();
  await expect(Effect.runPromise(service.issue({...input,issuerRecord:'foreign'},{...ctx,tenant:'foreign'}))).rejects.toThrow();
  for(const [name,id] of [['Finding',finding.id],['Disposition',disposition.id],['Remediation',remediation.id],['Attestation',attestation.id]])await expect(call(p+name+'.delete',{id})).rejects.toThrow();
  // Readable attestation metadata must not reveal unreadable sealed support.
  engine.gatekeeper.authorizer=localAuthorizer({policies:[{id:'assurance',actions:[p+'*'],requires:[],where:[]},{id:'evaluation',actions:[v+'*'],requires:[],where:[]},{id:'specification',actions:[s+'*'],requires:[],where:[]}],pips:[],epoch:3,knownObligations:[]});
  await expect(Effect.runPromise(service.current(String(replacement.id),end,ctx))).rejects.toThrow();
  engine.gatekeeper.authorizer=localAuthorizer({policies:[{id:'attestation',actions:[p+'Attestation.*'],requires:[],where:[]}],pips:[],epoch:1,knownObligations:[]});
  await expect(Effect.runPromise(service.current(String(attestation.id),start,ctx))).rejects.toThrow();
  engine.gatekeeper.authorizer=localAuthorizer({policies:[],pips:[],epoch:2,knownObligations:[]});
  await expect(call(p+'Finding.create',{finish:original.finish.id,run:original.run.id,specification:pin.id,summary:'Denied'})).rejects.toThrow();
 }finally{await f.close();}
});
