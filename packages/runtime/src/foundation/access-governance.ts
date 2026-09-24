import { Effect } from 'effect';
import type { Engine,CallContext,AtomicMutation } from '../engine.js';
import type { Wire } from '../decode.js';
import { err,type ForgeError } from '../errors.js';
import { Clock,Storage } from '../services.js';
import { decodeDatetime } from '../codecs.js';
import { Decisions } from './decision.js';
import { Delegations } from './delegation.js';
import { Qualifications } from './qualification.js';
import { Attestations } from './attestation.js';
import { Evidence } from './evidence.js';
import { findTerminalFact } from './facts.js';
const p='@forgegraph/foundation/access-governance/_/',ep='@forgegraph/foundation/entitlement/_/',pp='@forgegraph/foundation/participation/_/';
const bad=(message:string)=>Effect.fail(err('ValidationFailed',message));
export class AccessGovernance {
 constructor(private readonly engine:Engine){}
 private call(op:string,input:Wire,ctx:CallContext){return this.engine.call(p+op,input,ctx);}
 private now(){return Effect.gen(function*(){return(yield* Clock).now();}).pipe(Effect.provide(this.engine.layer));}
 private support(id:unknown,ctx:CallContext){const self=this;return Effect.gen(function*(){const seal=yield* self.engine.call('@forgegraph/foundation/evidence/_/EvidenceSeal.get',{id},ctx);yield* new Evidence(self.engine).sealedItems(String(seal.bundle),ctx);});}
 private find(resource:string,values:Wire,ctx:CallContext){const self=this;return Effect.gen(function*(){const model=self.engine.model.resource(p+resource),unique=model.uniques.find(u=>u.fields.length===Object.keys(values).length&&u.fields.every(f=>Object.hasOwn(values,f)))!;
  const row=yield* (yield* Storage).findUnique(ctx.tenant,model,unique,self.engine.claimKey(model,unique,values)!,values);return row?yield* self.call(resource+'.get',{id:row.id},ctx):null;
 }).pipe(Effect.provide(this.engine.layer));}
 private request(id:string,at:string,ctx:CallContext){const self=this;return Effect.gen(function*(){
  const request=yield* self.call('AccessRequest.get',{id},ctx),identity=yield* self.call('AccessIdentity.get',{id:request.identity},ctx),root=yield* self.engine.call(ep+'Entitlement.get',{id:request.root},ctx);
  yield* self.engine.call('@forgegraph/foundation/specification/_/SpecificationPin.get',{id:request.policy},ctx);yield* self.support(request.support,ctx);
  yield* self.engine.call('@forgegraph/foundation/delegation/_/DelegationSubject.get',{id:identity.subject},ctx);
  for(const [resource,id] of [['RightDefinition',root.right],['EntitlementScope',root.scope]])yield* self.engine.call(ep+resource+'.get',{id},ctx);
  const reasons:string[]=[],chain:Wire[]=[];
  if(at<String(request.validFrom)||at>=String(request.validUntil))reasons.push('grant-window');
  const ended=yield* findTerminalFact(self.engine,ep+'EntitlementEnd','entitlement',root.id,ctx);if(ended&&at>=String(ended.effectiveAt))reasons.push('root-revoked');
  if(request.delegation){const state=yield* new Delegations(self.engine).explain(String(request.delegation),at,ctx);chain.push(...state.chain);if(state.delegation.delegate!==identity.subject||state.root.id!==root.id)return yield* bad('Delegated grant subject or root differs');reasons.push(...state.reasons);}
  else {const holder=yield* self.engine.call('@forgegraph/foundation/delegation/_/DelegationPartySubject.get',{id:request.holder},ctx);if(holder.subject!==identity.subject||holder.party!==root.holder)return yield* bad('Direct grant does not belong to the subject');}
  if(request.membership){const member=yield* self.engine.call(pp+'Participation.get',{id:request.membership},ctx),end=yield* findTerminalFact(self.engine,pp+'ParticipationEnd','participation',member.id,ctx);if(at<String(member.validFrom)||member.validUntil!=null&&at>=String(member.validUntil)||end&&at>=String(end.effectiveAt))reasons.push('membership-inactive');}
  if(request.qualification){const qualification=yield* new Qualifications(self.engine).satisfies(String(identity.qualificationSubject),String(request.qualification),at,ctx);if(!qualification.qualified)reasons.push('qualification-missing');}
  return {request,identity,root,reasons,chain};
 });}
 private approved(request:Wire,approval:unknown,ctx:CallContext){const self=this;return Effect.gen(function*(){const decision=yield* new Decisions(self.engine).state(String(request.decisionCase),ctx);if(!decision.outcome||decision.outcome.id!==approval||decision.outcome.selected!==request.approvedOption||!decision.events[0]||String(request.createdAt)>=String(decision.events[0].createdAt))return yield* bad('Grant approval was not prebound before responses');});}
 issue(request:string,ctx:CallContext){const self=this;return Effect.gen(function*(){
  const now=yield* self.now(),record=yield* self.call('AccessRequest.get',{id:request},ctx);
  const state=yield* self.request(request,now<String(record.validFrom)?String(record.validFrom):now,ctx);if(state.reasons.length)return yield* bad('Grant prerequisites are not effective at its activation instant');
  const decision=yield* new Decisions(self.engine).state(String(state.request.decisionCase),ctx);yield* self.approved(state.request,decision.outcome?.id,ctx);
  return yield* self.call('AccessGrant.create',{request,approval:decision.outcome!.id},ctx);
 });}
 private review(id:string,approval:unknown,certification:string,outcome:string,at:string,ctx:CallContext){const self=this;return Effect.gen(function*(){
  const review=yield* self.call('AccessReview.get',{id},ctx),grant=yield* self.call('AccessGrant.get',{id:review.grant},ctx),request=yield* self.call('AccessRequest.get',{id:grant.request},ctx),identity=yield* self.call('AccessIdentity.get',{id:request.identity},ctx);
  const decision=yield* new Decisions(self.engine).state(String(review.decisionCase),ctx),selected=review[outcome==='continued'?'continueOption':outcome==='modified'?'modifyOption':'revokeOption'];
  if(!decision.outcome||decision.outcome.id!==approval||decision.outcome.selected!==selected||!decision.events[0]||String(review.createdAt)>=String(decision.events[0].createdAt)||!decision.responses.some(r=>r.voter===review.reviewer))return yield* bad('Assigned review decision is not final or was not prebound');
  const reviewer=yield* self.engine.call(pp+'Participation.get',{id:review.reviewer},ctx),ended=yield* findTerminalFact(self.engine,pp+'ParticipationEnd','participation',reviewer.id,ctx),certifier=yield* self.engine.call('@forgegraph/foundation/attestation/_/AttestationPartySubject.get',{id:review.certifier},ctx);
  if(at<String(reviewer.validFrom)||reviewer.validUntil!=null&&at>=String(reviewer.validUntil)||ended&&at>=String(ended.effectiveAt)||reviewer.participant!==certifier.party)return yield* bad('Assigned reviewer lacks current participation');
  for(let ordinal=1;ordinal<=Number(review.findingCount);ordinal++){const finding=yield* self.find('AccessReviewFinding',{review:id,ordinal},ctx);if(!finding)return yield* bad('Review findings are incomplete');yield* self.call('AccessGrant.get',{id:finding.conflictingGrant},ctx);yield* self.support(finding.support,ctx);}
  const assertion=yield* new Attestations(self.engine).current(certification,at,ctx);
  if(!assertion||assertion.issuer!==certifier.subject||assertion.subject!==identity.attestationSubject||assertion.specification!==request.policy||assertion.conclusion!=='Access review: '+outcome||String(assertion.issuedAt)<String(decision.events.at(-1)!.createdAt))return yield* bad('Certification does not bind reviewer, subject, policy and finalized outcome');
  return {review,request,assertion};
 });}
 private history(grant:string,ctx:CallContext){const self=this;return Effect.gen(function*(){
  const history:Wire[]=[];for(let ordinal=1;ordinal<=64;ordinal++){const row=yield* self.find('AccessReviewCompletion',{grant,ordinal},ctx);if(!row)break;if(row.previous!==(history.at(-1)?.id??null)||history.at(-1)&&history.at(-1)!.outcome!=='continued')return yield* bad('Invalid access review chain');yield* self.review(String(row.review),row.approval,String(row.certification),String(row.outcome),String(row.createdAt),ctx);history.push(row);}
  return history;
 });}
 explain(grant:string,at:string,ctx:CallContext){const self=this;return Effect.gen(function*(){
  at=yield* Effect.try({try:()=>decodeDatetime(at),catch:()=>err('ValidationFailed','Invalid access instant')});
  const row=yield* self.call('AccessGrant.get',{id:grant},ctx),state=yield* self.request(String(row.request),at,ctx);yield* self.approved(state.request,row.approval,ctx);
  const history=yield* self.history(grant,ctx),latest=history.filter(r=>String(r.createdAt)<=at).at(-1),end=yield* findTerminalFact(self.engine,p+'AccessGrantEnd','grant',grant,ctx);
  const reasons=[...state.reasons];if(at<String(row.createdAt))reasons.push('not-granted');if(end&&at>=String(end.effectiveAt))reasons.push('grant-ended');
  if(latest&&latest.outcome!=='continued')reasons.push(String(latest.outcome));
  const reviewDue=String(latest?.nextReviewAt??state.request.reviewDue);if(at>=reviewDue)reasons.push('review-overdue');
  if(latest&&!(yield* new Attestations(self.engine).current(String(latest.certification),at,ctx)))reasons.push('certification-inactive');
  return {...state,grant:row,history,end,reviewDue,reasons,effective:reasons.length===0};
 });}
 complete(reviewId:string,input:{outcome:'continued'|'modified'|'revoked';certification:string;nextReviewAt:string;acceptsConflicts?:boolean;replacement?:string;reason:string},ctx:CallContext){const self=this;return Effect.gen(function*(){
  const now=yield* self.now(),review=yield* self.call('AccessReview.get',{id:reviewId},ctx),decision=yield* new Decisions(self.engine).state(String(review.decisionCase),ctx);
  const checked=yield* self.review(reviewId,decision.outcome?.id,input.certification,input.outcome,now,ctx);
  const history=yield* self.history(String(review.grant),ctx);if(history.length>=64)return yield* bad('Access review limit reached');
  const end=yield* findTerminalFact(self.engine,p+'AccessGrantEnd','grant',review.grant,ctx);if(end)return yield* bad('Grant is already ended');
  const next=yield* Effect.try({try:()=>decodeDatetime(input.nextReviewAt),catch:()=>err('ValidationFailed','Invalid next review date')});
  if(next>String(checked.request.validUntil)||checked.assertion.validUntil!=null&&next>String(checked.assertion.validUntil))return yield* bad('Certification cannot extend grant or attestation expiry');
  if(input.outcome==='modified'){if(!input.replacement)return yield* bad('Modification requires a separately approved replacement');const replacement=yield* self.explain(input.replacement,now,ctx);if(replacement.request.identity!==checked.request.identity||!replacement.effective)return yield* bad('Replacement must be effective for the same identity');}
  const mutations:AtomicMutation[]=[{operation:p+'AccessReviewCompletion.create',input:{grant:review.grant,ordinal:history.length+1,previous:history.at(-1)?.id??null,review:reviewId,outcome:input.outcome,approval:decision.outcome!.id,certification:input.certification,nextReviewAt:next,acceptsConflicts:input.acceptsConflicts??false,replacement:input.replacement??null,reason:input.reason}}];
  if(input.outcome!=='continued')mutations.push({operation:p+'AccessGrantEnd.create',input:{grant:review.grant,replacement:input.replacement??null,effectiveAt:now,reason:input.reason}});
  const unique=self.engine.model.resource(p+'AccessGrantEnd').uniques.find(u=>u.fields[0]==='grant')!.name;
  return yield* self.engine.atomic(mutations,ctx,{absent:input.outcome==='continued'?[{resource:p+'AccessGrantEnd',unique,values:{grant:review.grant}}]:[]});
 });}
 pip(grant:string,subject:string,ctx:CallContext){const self=this;return Effect.gen(function*(){const now=yield* self.now(),state=yield* self.explain(grant,now,ctx);if(state.identity.subject!==subject)return yield* bad('Grant subject differs from trusted principal mapping');return {pip:'access-governance:'+grant,attribute:'effective',value:state.effective,observedAt:now,expiresAt:new Date(Math.min(Date.parse(now)+1000,Date.parse(state.reviewDue),Date.parse(String(state.request.validUntil)))).toISOString(),subject,scope:state.root.scope,right:state.root.right,purpose:state.chain[0]?.purpose??null,constraints:state.chain[0]?.constraints??state.request.policy,reasons:state.reasons,delegationChain:state.chain.map(r=>r.id)};});}
}
