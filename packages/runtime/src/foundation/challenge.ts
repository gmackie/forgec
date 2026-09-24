import { Effect } from 'effect';
import type { Engine,CallContext } from '../engine.js';
import type { Wire } from '../decode.js';
import { err,type ForgeError } from '../errors.js';
import { Clock,Storage } from '../services.js';
import { Evaluations } from './evaluation.js';
import { Evidence } from './evidence.js';
import { Trust } from './trust.js';
import { Decisions } from './decision.js';
import { findTerminalFact } from './facts.js';
const p='@forgegraph/foundation/challenge/_/',ep='@forgegraph/foundation/evaluation/_/';
const bad=(message:string)=>Effect.fail(err('ValidationFailed',message));
export type ChallengeVerifier=(challenge:Wire,evaluation:Wire,ctx:CallContext)=>Effect.Effect<boolean,ForgeError>;
/** Domain verifiers supply proof interpretation; this service owns durable friction only. */
export class Challenges {
 constructor(private readonly engine:Engine,private readonly verifier?:ChallengeVerifier){}
 private call(op:string,input:Wire,ctx:CallContext){return this.engine.call(p+op,input,ctx);}
 private now(){return Effect.gen(function*(){return(yield* Clock).now();}).pipe(Effect.provide(this.engine.layer));}
 private support(id:unknown,ctx:CallContext){const self=this;return Effect.gen(function*(){const seal=yield* self.engine.call('@forgegraph/foundation/evidence/_/EvidenceSeal.get',{id},ctx);yield* new Evidence(self.engine).sealedItems(String(seal.bundle),ctx);});}
 private decision(id:string,ctx:CallContext){const self=this;return Effect.gen(function*(){
  const row=yield* self.call('ChallengeDecision.get',{id},ctx),interaction=yield* self.call('ChallengeInteraction.get',{id:row.interaction},ctx);
  yield* self.engine.call('@forgegraph/foundation/trust/_/TrustSubject.get',{id:interaction.subject},ctx);
  for(const id of [row.policy,interaction.action])yield* self.engine.call('@forgegraph/foundation/specification/_/SpecificationPin.get',{id},ctx);
  const finish=yield* new Evaluations(self.engine).result(String(row.evaluation),ctx),run=yield* self.engine.call(ep+'EvaluationRun.get',{id:row.run},ctx);
  if(finish.outcome!=='Completed'||finish.run!==run.id||run.definition!==row.policy)return yield* bad('Challenge policy evaluation is not valid');
  yield* self.support(row.support,ctx);
  if(row.risk){const risk=yield* self.engine.call('@forgegraph/foundation/risk/_/RiskAssessment.get',{id:row.risk},ctx);yield* new Evaluations(self.engine).result(String(risk.evaluation),ctx);yield* self.support(risk.support,ctx);}
  if(row.trust){const assessment=yield* new Trust(self.engine).inspect(String(row.trust),String(row.createdAt),ctx);if(!assessment.usable||assessment.review.subject!==interaction.subject)return yield* bad('Trust input is not usable for this interaction subject');}
  return {row,interaction};
 });}
 private event(challenge:string,ordinal:number,ctx:CallContext){const self=this;return Effect.gen(function*(){
  const model=self.engine.model.resource(p+'ChallengeEvent'),unique=model.uniques.find(u=>u.fields.length===2&&u.fields.includes('challenge')&&u.fields.includes('ordinal'))!,values={challenge,ordinal};
  const row=yield* (yield* Storage).findUnique(ctx.tenant,model,unique,self.engine.claimKey(model,unique,values)!,values);
  return row?yield* self.call('ChallengeEvent.get',{id:row.id},ctx):null;
 }).pipe(Effect.provide(this.engine.layer));}
 private approval(challenge:Wire,attempt:Wire,ctx:CallContext){const self=this;return Effect.gen(function*(){
  const binding=yield* findTerminalFact(self.engine,p+'ChallengeApproval','challenge',challenge.id,ctx);
  if(!binding)return null;
  const state=yield* new Decisions(self.engine).state(String(binding.decisionCase),ctx);
  if(!state.outcome||state.outcome.id!==attempt.outcome||attempt.approval!==binding.id||!state.events[0]||String(binding.createdAt)>=String(state.events[0].createdAt))return yield* bad('Approval was not prebound or its decision is not final');
  return state.outcome.selected===binding.approvedOption;
 });}
 state(id:string,ctx:CallContext):Effect.Effect<{challenge:Wire;interaction:Wire;events:Wire[];phase:string},ForgeError>{const self=this;return Effect.gen(function*(){
  const challenge=yield* self.call('Challenge.get',{id},ctx),context=yield* self.decision(String(challenge.decision),ctx),now=yield* self.now();
  yield* self.engine.call('@forgegraph/foundation/specification/_/SpecificationPin.get',{id:challenge.requirement},ctx);
  const events:Wire[]=[];let phase='pending';
  for(let ordinal=1;ordinal<=17;ordinal++){const event=yield* self.event(id,ordinal,ctx);if(!event)break;
   if(phase!=='pending'||event.previous!==(events.at(-1)?.id??null))return yield* bad('Invalid challenge journal');
   if(event.attempt){const attempt=yield* self.call('ChallengeAttempt.get',{id:event.attempt},ctx),finish=yield* new Evaluations(self.engine).result(String(attempt.evaluation),ctx),run=yield* self.engine.call(ep+'EvaluationRun.get',{id:attempt.run},ctx);
    yield* self.support(attempt.support,ctx);
    if(attempt.challenge!==id||finish.run!==run.id||run.definition!==challenge.requirement||finish.outcome!=='Completed'||String(run.createdAt)<String(challenge.createdAt)||String(finish.finishedAt)>String(event.createdAt))return yield* bad('Attempt does not prove this challenge requirement');
    const approval=yield* self.approval(challenge,attempt,ctx);
    const successful=approval??(self.verifier?yield* self.verifier(challenge,finish,ctx):yield* bad('A domain verification interpreter is required'));
    if(successful!==attempt.successful||successful!==(event.kind==='satisfied'))return yield* bad('Attempt outcome differs from admitted evidence');
   }
   events.push(event);if(event.kind!=='failed')phase=String(event.kind);
  }
  if(phase==='pending')phase=now>=String(challenge.expiresAt)?'expired':events.length>=Number(challenge.maxAttempts)?'exhausted':'pending';
  if(phase==='satisfied'&&now>=String(challenge.expiresAt))phase='expired';
  return {challenge,interaction:context.interaction,events,phase};
 });}
 attempt(id:string,evaluation:string,support:string,ctx:CallContext){const self=this;return Effect.gen(function*(){
  const state=yield* self.state(id,ctx);if(state.phase!=='pending')return yield* bad('Challenge cannot accept another attempt');
  const finish=yield* new Evaluations(self.engine).result(evaluation,ctx),run=yield* self.engine.call(ep+'EvaluationRun.get',{id:finish.run},ctx);
  if(String(finish.finishedAt)>(yield* self.now())||finish.outcome!=='Completed'||run.definition!==state.challenge.requirement||String(run.createdAt)<String(state.challenge.createdAt))return yield* bad('Attempt evaluation is not bound to this requirement');
  yield* self.support(support,ctx);
  const approval=yield* findTerminalFact(self.engine,p+'ChallengeApproval','challenge',id,ctx);
  const outcome=approval?(yield* new Decisions(self.engine).state(String(approval.decisionCase),ctx)).outcome:null;
  const candidate={approval:approval?.id??null,outcome:outcome?.id??null};
  const approved=yield* self.approval(state.challenge,candidate,ctx),successful=approved??(self.verifier?yield* self.verifier(state.challenge,finish,ctx):yield* bad('A domain verification interpreter is required'));
  const attempt=yield* self.call('ChallengeAttempt.create',{challenge:id,evaluation,run:run.id,support,successful,...candidate},ctx);
  return yield* self.call('ChallengeEvent.create',{challenge:id,ordinal:state.events.length+1,previous:state.events.at(-1)?.id??null,kind:successful?'satisfied':'failed',attempt:attempt.id,reason:successful?'Requirement satisfied':'Verification did not satisfy requirement'},ctx);
 });}
 end(id:string,kind:'cancelled'|'expired',reason:string,ctx:CallContext){const self=this;return Effect.gen(function*(){
  const state=yield* self.state(id,ctx);if(state.events.at(-1)&&state.events.at(-1)!.kind!=='failed')return yield* bad('Challenge is terminal');
  if(kind==='expired'&&(yield* self.now())<String(state.challenge.expiresAt))return yield* bad('Challenge has not expired');
  return yield* self.call('ChallengeEvent.create',{challenge:id,ordinal:state.events.length+1,previous:state.events.at(-1)?.id??null,kind,attempt:null,reason},ctx);
 });}
 assurance(id:string,subject:string,ctx:CallContext){const self=this;return Effect.gen(function*(){
  const state=yield* self.state(id,ctx);if(state.interaction.subject!==subject)return yield* bad('Assurance subject differs from trusted principal mapping');
  const now=yield* self.now();return {pip:'challenge:'+id,attribute:'satisfied',value:state.phase==='satisfied',challenge:id,interaction:state.interaction.id,subject,requirement:state.challenge.requirement,observedAt:now,expiresAt:new Date(Math.min(Date.parse(now)+1000,Date.parse(String(state.challenge.expiresAt)))).toISOString()};
 });}
}
