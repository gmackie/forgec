import {Effect} from 'effect';
import {it,expect} from 'vitest';
import {Intake} from '../src/foundation/intake.js';
import {Evaluations} from '../src/foundation/evaluation.js';
import {Artifacts} from '../src/foundation/artifact.js';
import {localAuthorizer} from '../src/gatekeeper.js';
import {foundation} from './helpers/foundation.js';
const p='@forgegraph/foundation/intake/_/',s='@forgegraph/foundation/specification/_/',e='@forgegraph/foundation/evaluation/_/',a='@forgegraph/foundation/artifact/_/',d='@fixture/intake-consumer/_/';
for(const adapter of ['memory','sqlite']) it(`${adapter}: exact form/raw pins, validation and typed idempotent domain transforms`,async()=>{
 const f=foundation('intake',adapter,true),{call,ctx,engine,objects}=f;
 try {
  const repository=await call(s+'Repository.create',{key:'forms',provider:'git',locator:'https://example.test/forms'});
  const pin=await call(s+'SpecificationPin.create',{repository:repository.id,anchor:'form',revision:'a'.repeat(40)});
  const next=await call(s+'SpecificationPin.create',{repository:repository.id,anchor:'form',revision:'b'.repeat(40)});
  const form=await call(p+'IntakeForm.create',{definition:pin.id,label:'Expense',anonymousAllowed:false});
  const party=await call('@forgegraph/foundation/party/_/Party.create',{label:'Submitter'});
  const artifact=await call(a+'Artifact.create',{key:'raw-form',label:'Original form'});
  const content=await call(a+'ArtifactContent.create',{});
  const upload=await call(a+'ArtifactContent.beginUpload',{id:content.id,expectedVersion:1,mediaType:'text/plain',byteCount:3});
  await objects.simulateUpload((upload.upload as {url:string}).url,new TextEncoder().encode('raw'),'text/plain');
  const sealed=await call(a+'ArtifactContent.finalizeUpload',{id:content.id,expectedVersion:2});
  const revision=await Effect.runPromise(new Artifacts(engine).publish({artifact:String(artifact.id),content:String(content.id),digest:String(sealed.digest)},ctx));
  const api=new Intake(engine),input={form:String(form.id),sourceKey:'form-1',submitter:String(party.id),raw:String(revision.id),submittedAt:'2026-01-01T00:00:00Z'};
  const submission=await Effect.runPromise(api.submit(input,{...ctx,idempotencyKey:'submit'}));
  expect(await Effect.runPromise(api.submit(input,{...ctx,idempotencyKey:'submit'}))).toEqual(submission);
  expect(submission).toMatchObject({definition:pin.id,raw:revision.id});
  await expect(call(p+'Submission.create',{...input,sourceKey:'wrong',definition:next.id})).rejects.toThrow();
  await expect(Effect.runPromise(api.submit({...input,sourceKey:'anonymous',submitter:undefined},ctx))).rejects.toThrow();
  const group=await call(e+'EvaluationSet.create',{label:'Validation'}),executor=await call(e+'EvaluationExecutor.create',{key:'validator',label:'Validator'});
  const evaluations=new Evaluations(engine);
  async function validation(submissionId:string,definition:string,verdict:'Accepted'|'Rejected') {
   const run=await Effect.runPromise(evaluations.create({evaluationSet:String(group.id),definition,executor:String(executor.id)},ctx));
   await Effect.runPromise(evaluations.start(String(run.id),'2026-01-01T01:00:00Z',ctx));
   const finish=await Effect.runPromise(evaluations.finish(String(run.id),'Completed','2026-01-01T02:00:00Z','checked',ctx));
   return Effect.runPromise(api.validate(submissionId,String(finish.id),verdict,'typed validator result',ctx));
  }
  await expect(validation(String(submission.id),String(next.id),'Accepted')).rejects.toThrow();
  const accepted=await validation(String(submission.id),String(pin.id),'Accepted');
  const transformed=await call(d+'Expense.create',{validation:accepted.id,amount:'12.50',currency:'USD',merchant:'Store'},{...ctx,idempotencyKey:'transform'});
  expect(await call(d+'Expense.create',{validation:accepted.id,amount:'12.50',currency:'USD',merchant:'Store'},{...ctx,idempotencyKey:'transform'})).toEqual(transformed);
  await expect(call(d+'Expense.create',{validation:accepted.id,amount:'13.00',currency:'USD',merchant:'Store'})).rejects.toThrow();
  await expect(call(d+'Expense.create',{validation:accepted.id,amount:{arbitrary:'json'},currency:'USD',merchant:'Store'})).rejects.toThrow();
  for(const [type,payload] of [['VendorApplication',{legalName:'Acme Ltd',registration:'R1'}],['ClinicalQuestionnaire',{temperatureC:'37.10',symptomsReported:false}]] as const){
   const sub=await Effect.runPromise(api.submit({...input,sourceKey:type},ctx));
   const v=await validation(String(sub.id),String(pin.id),'Accepted');
   expect(await call(d+type+'.create',{validation:v.id,...payload})).toMatchObject({validation:v.id});
  }
  const rejectedSub=await Effect.runPromise(api.submit({...input,sourceKey:'rejected'},ctx));
  const rejected=await validation(String(rejectedSub.id),String(pin.id),'Rejected');
  await expect(call(d+'Expense.create',{validation:rejected.id,amount:'1.00',currency:'USD',merchant:'Store'})).rejects.toThrow();
  await expect(call(p+'Submission.update',{id:submission.id,patch:{raw:null}})).rejects.toThrow();
  await expect(Effect.runPromise(api.submit({...input,sourceKey:'cross-tenant'},{...ctx,tenant:'other'}))).rejects.toThrow();
  engine.gatekeeper.authorizer=localAuthorizer({policies:[],pips:[],epoch:1,knownObligations:[]});
  await expect(Effect.runPromise(api.submit({...input,sourceKey:'denied'},ctx))).rejects.toMatchObject({code:'NotFound'});
 }finally{f.close();}
});
