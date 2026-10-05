import { Effect } from 'effect';
import { expect, it } from 'vitest';
import { foundation, foundationAdapters } from './helpers/foundation.js';
import { Trust } from '../src/foundation/trust.js';
import { Evidence } from '../src/foundation/evidence.js';
import { Evaluations } from '../src/foundation/evaluation.js';
import { Risks } from '../src/foundation/risk.js';
import { Engine } from '../src/engine.js';
import { localAuthorizer } from '../src/gatekeeper.js';
const p='@forgegraph/foundation/trust/_/', e='@forgegraph/foundation/evaluation/_/', ev='@forgegraph/foundation/evidence/_/', sp='@forgegraph/foundation/specification/_/';
const observedAt='2025-12-15T00:00:00Z', windowFrom='2025-12-01T00:00:00Z', windowUntil='2026-01-01T00:00:00Z';
const assessedAt='2026-01-02T00:00:00Z', riskAt='2026-01-03T00:00:00Z', correctedAt='2026-01-04T00:00:00Z', resolvedAt='2026-01-05T00:00:00Z';
for(const adapter of foundationAdapters) it(`${adapter}: contextual trust provenance, correction/dispute history and risk inputs`,async()=>{
 const f=await foundation('trust',adapter,true),run=Effect.runPromise;
 try {
  const {engine,ctx,call}=f,service=new Trust(engine),evaluations=new Evaluations(engine);
  const issuer=await call('@forgegraph/foundation/party/_/Party.create',{label:'Verified observer'});
  const repo=await call(sp+'Repository.create',{key:'trust-methods',provider:'git',locator:'https://example.test/trust'});
  const method=await call(sp+'SpecificationPin.create',{repository:repo.id,anchor:'delivery-model',revision:'a'.repeat(40)});
  const otherMethod=await call(sp+'SpecificationPin.create',{repository:repo.id,anchor:'other-model',revision:'b'.repeat(40)});
  const bundle=await call(ev+'EvidenceBundle.create',{key:'observations',label:'Source observations'});
  const source=await call(ev+'EvidenceSource.create',{key:'verified-log',label:'Verified log'});
  await call(ev+'EvidenceItem.create',{bundle:bundle.id,source:source.id,sourceRecord:'receipt-1',kind:'delivery-receipt',observedAt,provenance:'Signed delivery record'});
  const seal=await run(new Evidence(engine).seal(String(bundle.id),null,ctx));
  const executor=await call(e+'EvaluationExecutor.create',{key:'domain-method',label:'Pinned contextual method'});
  const dimension=await call(p+'TrustDimension.create',{key:'reliability',context:'fulfillment/vendor',method:method.id,minimum:'0',maximum:'100'});
  const otherDimension=await call(p+'TrustDimension.create',{key:'reliability',context:'software/agent',method:method.id,minimum:'-1',maximum:'1'});
  const kind=await call(p+'SignalKind.create',{dimension:dimension.id,key:'delivery',definition:method.id});
  const agentKind=await call(p+'SignalKind.create',{dimension:otherDimension.id,key:'verified-output',definition:method.id});
  const subject=await call(p+'TrustSubject.create',{label:'Supplier'});
  await call(p+'TrustPartySubject.create',{subject:subject.id,party:issuer.id});
  async function signal(key:string,subjectId=subject.id,dimensionId=dimension.id,kindId=kind.id){return call(p+'TrustSignal.create',{subject:subjectId,dimension:dimensionId,kind:kindId,issuer:issuer.id,sourceRecord:key,observedAt,support:seal.id,explanation:'Observed fact with immutable source evidence'});}
  const onTime=await signal('on-time'),late=await signal('late');
  await call('@fixture/trust-consumer/_/VendorDeliverySignal.create',{signal:onTime.id,orderNumber:'order-1',lateMinutes:0});
  await call('@fixture/trust-consumer/_/VendorDeliverySignal.create',{signal:late.id,orderNumber:'order-2',lateMinutes:60});
  const marketSignal=await signal('marketplace');
  await call('@fixture/trust-consumer/_/MarketplaceResolutionSignal.create',{signal:marketSignal.id,caseNumber:'case-1',resolved:true});
  const device=await call(p+'TrustSubject.create',{label:'Agent device'});
  await call('@fixture/trust-consumer/_/DeviceSubject.create',{subject:device.id,serial:'device-1'});
  const agentSignal=await signal('agent-run',device.id,otherDimension.id,agentKind.id);
  await call('@fixture/trust-consumer/_/AgentRunSignal.create',{signal:agentSignal.id,runKey:'run-1',verified:true});
  async function review(key:string,signals:string[],subjectId=subject.id,dimensionId=dimension.id){
   const set=await call(e+'EvaluationSet.create',{label:key});
   return run(service.open({subject:String(subjectId),dimension:String(dimensionId),evaluations:String(set.id),windowFrom,windowUntil,signals:signals.map(signal=>({signal,rationale:'Input selected by the pinned method'}))},ctx));
  }
  async function finish(review:Record<string,unknown>,definition=method.id,finishedAt=assessedAt){
   const r=await run(evaluations.create({evaluationSet:String(review.evaluations),definition:String(definition),executor:String(executor.id)},ctx));
   await run(evaluations.start(String(r.id),windowUntil,ctx));
   return run(evaluations.finish(String(r.id),'Completed',finishedAt,'Method evaluated exact bound signal set',ctx,String(seal.id)));
  }
  const review1=await review('vendor',[String(onTime.id),String(late.id)]);
  const wrong=await finish(review1,otherMethod.id);
  await expect(run(service.assess(String(review1.id),{finish:String(wrong.id),score:'90',confidence:'0.8',explanation:'Wrong method'},ctx))).rejects.toMatchObject({code:'ValidationFailed'});
  const evaluated=await finish(review1);
  const assessment=await run(service.assess(String(review1.id),{finish:String(evaluated.id),score:'90',confidence:'0.8',explanation:'Pinned method rates one late receipt among two deliveries'},ctx));
  const state=await run(service.inspect(String(assessment.id),assessedAt,ctx));expect(state.usable).toBe(true);expect(state.members).toHaveLength(2);expect(state.assessment.score).toBe('90.000000');
  await expect(review('cross-subject',[String(agentSignal.id)])).rejects.toMatchObject({code:'ValidationFailed'});
  await expect(review('duplicates',[String(onTime.id),String(onTime.id)])).rejects.toMatchObject({code:'ValidationFailed'});
  const agentReview=await review('agent',[String(agentSignal.id)],device.id,otherDimension.id),agentFinish=await finish(agentReview);
  await expect(run(service.assess(String(agentReview.id),{finish:String(agentFinish.id),score:'90',confidence:'1',explanation:'Wrong contextual scale'},ctx))).rejects.toMatchObject({code:'ValidationFailed'});
  const agentAssessment=await run(service.assess(String(agentReview.id),{finish:String(agentFinish.id),score:'0.9',confidence:'0.5',explanation:'Agent verification model'},ctx));
  expect((await run(service.inspect(String(agentAssessment.id),assessedAt,ctx))).dimension.context).toBe('software/agent');
  const rp='@forgegraph/foundation/risk/_/';
  const risk=await call(rp+'Risk.create',{scenario:'Supplier may miss delivery'});
  const scale=await call(rp+'RiskScale.create',{key:'likelihood-impact',label:'Scenario rubric'});
  const level=await call(rp+'RiskLevel.create',{scale:scale.id,code:'medium',rank:2});
  const riskAssessment=await run(new Risks(engine).assess({risk:String(risk.id),likelihood:String(level.id),impact:String(level.id),confidence:'0.8',evaluation:String(evaluated.id),support:String(seal.id),assessedAt:riskAt},ctx));
  expect(await run(service.linkRisk(String(riskAssessment.id),String(assessment.id),'Delivery trust informs this future-harm scenario',ctx))).toMatchObject({trust:assessment.id});
  const dispute=await call(p+'SignalDispute.create',{signal:late.id,raisedBy:issuer.id,effectiveAt:correctedAt,reason:'Receipt timestamp challenged',support:seal.id});
  expect((await run(service.inspect(String(assessment.id),riskAt,ctx))).usable).toBe(true);
  expect((await run(service.inspect(String(assessment.id),correctedAt,ctx))).usable).toBe(false);
  await call(p+'DisputeResolution.create',{dispute:dispute.id,upheld:false,effectiveAt:resolvedAt,reason:'Independent receipt confirmed timestamp',support:seal.id});
  expect((await run(service.inspect(String(assessment.id),resolvedAt,ctx))).usable).toBe(true);
  const replacement=await signal('corrected-on-time');
  await call(p+'SignalCorrection.create',{signal:onTime.id,replacement:replacement.id,effectiveAt:correctedAt,reason:'Corrected source measurement',support:seal.id});
  expect((await run(service.inspect(String(assessment.id),resolvedAt,ctx))).usable).toBe(false);
  expect((await run(service.inspect(String(assessment.id),riskAt,ctx))).assessment.id).toBe(assessment.id);
  const stale=await review('stale-inputs',[String(onTime.id),String(late.id)]),staleFinish=await finish(stale,method.id,resolvedAt);
  await expect(run(service.assess(String(stale.id),{finish:String(staleFinish.id),score:'90',confidence:'0.9',explanation:'Corrected original must not support a new assessment'},ctx))).rejects.toMatchObject({code:'ValidationFailed'});
  const fresh=await review('corrected',[String(replacement.id),String(late.id)]),freshFinish=await finish(fresh);
  const newAssessment=await run(service.assess(String(fresh.id),{finish:String(freshFinish.id),score:'95',confidence:'0.9',explanation:'Fresh evaluation of corrected signals'},ctx));
  expect((await run(service.inspect(String(newAssessment.id),resolvedAt,ctx))).usable).toBe(true);
  await expect(call(p+'TrustAssessment.delete',{id:assessment.id})).rejects.toThrow();
  await expect(run(service.inspect(String(assessment.id),riskAt,{...ctx,tenant:'other'}))).rejects.toThrow();
  const guarded=new Engine(engine.model,engine.layer);
  guarded.gatekeeper.authorizer=localAuthorizer({policies:engine.model.resources.filter(r=>r.id!==p+'SignalCorrection').map(r=>({id:r.id,actions:[r.id+'.*'],requires:[],where:[]})),pips:[],epoch:2,knownObligations:[]});
  await expect(run(new Trust(guarded).inspect(String(assessment.id),resolvedAt,ctx))).rejects.toThrow();
 }finally{await f.close();}
});
