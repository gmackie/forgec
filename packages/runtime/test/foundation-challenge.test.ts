import { Effect } from 'effect';
import { expect,it,vi } from 'vitest';
import { foundation,foundationAdapters } from './helpers/foundation.js';
import { Challenges,type ChallengeVerifier } from '../src/foundation/challenge.js';
import { Evaluations } from '../src/foundation/evaluation.js';
import { Evidence } from '../src/foundation/evidence.js';
import { Trust } from '../src/foundation/trust.js';
import { Risks } from '../src/foundation/risk.js';
import { Decisions } from '../src/foundation/decision.js';
import { findTerminalFact } from '../src/foundation/facts.js';
import { Engine } from '../src/engine.js';
import { Clock } from '../src/services.js';
import { err } from '../src/errors.js';
import { localAuthorizer } from '../src/gatekeeper.js';
const p='@forgegraph/foundation/challenge/_/',e='@forgegraph/foundation/evaluation/_/',sp='@forgegraph/foundation/specification/_/',t='@forgegraph/foundation/trust/_/';
for(const adapter of foundationAdapters)it(`${adapter}: contextual challenge proof, retries, expiry, approval and assurance`,async()=>{
 const h=await foundation('challenge',adapter,true),run=Effect.runPromise;
 try{
  const {engine,ctx,call}=h,evaluations=new Evaluations(engine),trust=new Trust(engine);
  const now=()=>run(Effect.gen(function*(){return(yield* Clock).now();}).pipe(Effect.provide(engine.layer)));
  const repo=await call(sp+'Repository.create',{key:'challenge',provider:'git',locator:'https://example.test/policies'}),pin=await call(sp+'SpecificationPin.create',{repository:repo.id,anchor:'challenge-policy',revision:'a'.repeat(40)});
  const subject=await call(t+'TrustSubject.create',{label:'Agent'}),issuer=await call('@forgegraph/foundation/party/_/Party.create',{label:'Observer'});
  const bundle=await call('@forgegraph/foundation/evidence/_/EvidenceBundle.create',{key:'proof',label:'Proof evidence'}),seal=await run(new Evidence(engine).seal(String(bundle.id),null,ctx));
  const executor=await call(e+'EvaluationExecutor.create',{key:'verifier',label:'Verifier'});
  async function evaluate(){const set=await call(e+'EvaluationSet.create',{label:'Verification'}),evaluation=await run(evaluations.create({evaluationSet:String(set.id),definition:String(pin.id),executor:String(executor.id)},ctx));await run(evaluations.start(String(evaluation.id),await now(),ctx));const finish=await run(evaluations.finish(String(evaluation.id),'Completed',await now(),'Evaluated',ctx,String(seal.id)));return {evaluation,finish};}
  const policy=await evaluate(),risk=await call('@forgegraph/foundation/risk/_/Risk.create',{scenario:'Risky tool execution'}),scale=await call('@forgegraph/foundation/risk/_/RiskScale.create',{key:'risk',label:'Risk'}),level=await call('@forgegraph/foundation/risk/_/RiskLevel.create',{scale:scale.id,code:'high',rank:3});
  const assessment=await run(new Risks(engine).assess({risk:String(risk.id),likelihood:String(level.id),impact:String(level.id),confidence:'0.900',evaluation:String(policy.finish.id),support:String(seal.id),assessedAt:await now()},ctx));
  const dimension=await call(t+'TrustDimension.create',{key:'action',context:'agent',method:pin.id,minimum:'0',maximum:'1'}),kind=await call(t+'SignalKind.create',{dimension:dimension.id,key:'verified',definition:pin.id});
  const signal=await call(t+'TrustSignal.create',{subject:subject.id,dimension:dimension.id,kind:kind.id,issuer:issuer.id,sourceRecord:'action-1',observedAt:'2025-12-31T12:00:00Z',support:seal.id,explanation:'Observed action'}),set=await call(e+'EvaluationSet.create',{label:'Trust'});
  const review=await run(trust.open({subject:String(subject.id),dimension:String(dimension.id),windowFrom:'2025-12-31T00:00:00Z',windowUntil:'2026-01-01T00:00:00Z',evaluations:String(set.id),signals:[{signal:String(signal.id),rationale:'Bound observation'}]},ctx));
  const trustRun=await run(evaluations.create({evaluationSet:String(set.id),definition:String(pin.id),executor:String(executor.id)},ctx));await run(evaluations.start(String(trustRun.id),await now(),ctx));const trustFinish=await run(evaluations.finish(String(trustRun.id),'Completed',await now(),'Assessed',ctx));
  const trustAssessment=await run(trust.assess(String(review.id),{finish:String(trustFinish.id),score:'0.800000',confidence:'0.900000',explanation:'Contextual confidence'},ctx));
  const interaction=await call(p+'ChallengeInteraction.create',{subject:subject.id,action:pin.id,startedAt:'2026-01-01T00:00:00Z',until:'2026-02-01T00:00:00Z'});
  await call(p+'ChallengeParticipant.create',{interaction:interaction.id,subject:subject.id});
  await call('@fixture/challenge-consumer/_/AgentAction.create',{interaction:interaction.id,toolName:'deploy'});await call('@fixture/challenge-consumer/_/CustomerServiceException.create',{interaction:interaction.id,caseNumber:'case-1'});

  async function challenge(mechanism='proof-of-person',expiresAt='2026-01-02T00:00:00Z'){
   const decision=await call(p+'ChallengeDecision.create',{interaction:interaction.id,policy:pin.id,evaluation:policy.finish.id,run:policy.evaluation.id,disposition:'require',risk:assessment.id,trust:trustAssessment.id,support:seal.id,reason:'Risk and evidence require verification'});
   return call(p+'Challenge.create',{decision:decision.id,interaction:interaction.id,requirement:pin.id,mechanism,maxAttempts:2,expiresAt});
  }
  const verifier:ChallengeVerifier=(challenge,finish,context)=>Effect.gen(function*(){const observation=yield* findTerminalFact(engine,'@fixture/challenge-consumer/_/VerificationObservation','evaluation',finish.id,context);if(!observation||observation.challenge!==challenge.id||observation.protocol!==challenge.mechanism)return yield* Effect.fail(err('ValidationFailed','Proof is not bound to this challenge'));return observation.passed===true;});
  const service=new Challenges(engine,verifier);
  async function proof(id:unknown,passed:boolean,protocol='proof-of-person'){const evaluated=await evaluate();await call('@fixture/challenge-consumer/_/VerificationObservation.create',{evaluation:evaluated.finish.id,challenge:id,passed,protocol});return String(evaluated.finish.id);}
  const first=await challenge();await call('@fixture/challenge-consumer/_/ProofOfPerson.create',{challenge:first.id,proofProtocol:'domain-proof'});
  await run(service.attempt(String(first.id),await proof(first.id,false),String(seal.id),ctx));expect((await run(service.state(String(first.id),ctx))).phase).toBe('pending');
  await run(service.attempt(String(first.id),await proof(first.id,true),String(seal.id),ctx));expect((await run(service.assurance(String(first.id),String(subject.id),ctx))).value).toBe(true);
  await expect(run(service.attempt(String(first.id),await proof(first.id,true),String(seal.id),ctx))).rejects.toThrow();
  const assurance=await run(service.assurance(String(first.id),String(subject.id),ctx));
  const policyGate=localAuthorizer({policies:[{id:'separate-policy',actions:['test-action'],requires:[{pip:assurance.pip,attribute:assurance.attribute}],where:[{field:'id',op:'in',from:{pip:assurance.pip,attribute:assurance.attribute,map:{true:['action']}}}]}],pips:[],epoch:1,knownObligations:[]});
  const request={principal:{tenant:ctx.tenant,actor:ctx.actor},action:'test-action',kind:'read',current:{id:'action'},attributes:[assurance],requestId:'pip'};
  vi.useFakeTimers({toFake:['Date']});vi.setSystemTime(new Date(assurance.observedAt));
  try { expect((await run(policyGate.decide(request))).effect).toBe('allow');
  expect((await run(policyGate.decide({...request,attributes:[{...assurance,value:false}]}))).effect).toBe('deny');
  }finally{vi.useRealTimers();}
  const exhausted=await challenge();for(let i=0;i<2;i++)await run(service.attempt(String(exhausted.id),await proof(exhausted.id,false),String(seal.id),ctx));expect((await run(service.state(String(exhausted.id),ctx))).phase).toBe('exhausted');
  const step=await challenge('step-up');await call('@fixture/challenge-consumer/_/StepUpVerification.create',{challenge:step.id,assuranceLevel:'hardware-key'});
  const evaluated=await proof(step.id,true,'step-up');const races=await Promise.allSettled([run(service.attempt(String(step.id),evaluated,String(seal.id),ctx)),run(service.end(String(step.id),'cancelled','Withdrawn',ctx))]);expect(races.filter(r=>r.status==='fulfilled')).toHaveLength(1);
  const manual=await challenge('manual-review');await call('@fixture/challenge-consumer/_/ManualReview.create',{challenge:manual.id,queue:'supervisor'});
  const pp='@forgegraph/foundation/participation/_/',participants=await call(pp+'ParticipationSet.create',{label:'Reviewers'}),role=await call(pp+'ParticipationRole.create',{namespace:'challenge',name:'reviewer'}),member=await call(pp+'Participation.create',{participationSet:participants.id,participant:issuer.id,role:role.id,validFrom:'2025-01-01T00:00:00Z',validUntil:null,recordedBy:ctx.actor,reason:'Assigned'});
  const decisions=new Decisions(engine),approval=await run(decisions.open({participationSet:String(participants.id),electors:[String(member.id)],eligibilityAt:await now(),rule:'Single',options:['Approve','Reject'],deadline:'2026-01-02T00:00:00Z'},ctx)),options=(await run(decisions.state(String(approval.id),ctx))).options;
  await call(p+'ChallengeApproval.create',{challenge:manual.id,decisionCase:approval.id,approvedOption:options[0]!.id});await run(decisions.respond(String(approval.id),String(member.id),[0],ctx));await run(decisions.finalize(String(approval.id),ctx));
  await run(service.attempt(String(manual.id),String((await evaluate()).finish.id),String(seal.id),ctx));expect((await run(new Challenges(engine).state(String(manual.id),ctx))).phase).toBe('satisfied');
  const expires=await challenge();engine.testClockJump(2*24*60*60*1000);await run(service.end(String(expires.id),'expired','Deadline elapsed',ctx));expect((await run(service.assurance(String(first.id),String(subject.id),ctx))).value).toBe(false);
  await expect(run(service.assurance(String(first.id),'wrong-subject',ctx))).rejects.toThrow();
  const hidden=new Engine(engine.model,engine.layer);hidden.gatekeeper.authorizer=localAuthorizer({policies:engine.model.resources.filter(r=>r.id!==p+'ChallengeEvent').map(r=>({id:r.id,actions:[r.id+'.*'],requires:[],where:[]})),pips:[],epoch:2,knownObligations:[]});
  await expect(run(new Challenges(hidden,verifier).state(String(first.id),ctx))).rejects.toThrow();
  await expect(run(service.state(String(first.id),{...ctx,tenant:'foreign'}))).rejects.toThrow();
 }finally{await h.close();}
});
