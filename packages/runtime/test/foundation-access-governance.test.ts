import { Effect } from 'effect';
import { expect,it,vi } from 'vitest';
import { foundation,foundationAdapters } from './helpers/foundation.js';
import { AccessGovernance } from '../src/foundation/access-governance.js';
import { Decisions } from '../src/foundation/decision.js';
import { Entitlements } from '../src/foundation/entitlement.js';
import { Qualifications } from '../src/foundation/qualification.js';
import { Attestations } from '../src/foundation/attestation.js';
import { Evidence } from '../src/foundation/evidence.js';
import { Delegations } from '../src/foundation/delegation.js';
import { Engine } from '../src/engine.js';
import { Clock } from '../src/services.js';
import { localAuthorizer } from '../src/gatekeeper.js';
const p='@forgegraph/foundation/access-governance/_/',d='@forgegraph/foundation/delegation/_/',e='@forgegraph/foundation/entitlement/_/',pp='@forgegraph/foundation/participation/_/',ap='@forgegraph/foundation/attestation/_/',q='@forgegraph/foundation/qualification/_/';
const from='2026-01-01T00:00:00Z',until='2026-02-01T00:00:00Z',due='2026-01-15T00:00:00Z';
for(const adapter of foundationAdapters)it(`${adapter}: approved access, certified reviews, conflicts and delegated software actors`,async()=>{
 const h=await foundation('access-governance',adapter,true),run=Effect.runPromise;try{
  const {engine,ctx,call}=h,service=new AccessGovernance(engine),decisions=new Decisions(engine),attestations=new Attestations(engine);
  const now=()=>run(Effect.gen(function*(){return(yield* Clock).now();}).pipe(Effect.provide(engine.layer)));
  const repo=await call('@forgegraph/foundation/specification/_/Repository.create',{key:'access',provider:'git',locator:'https://example.test/policy'}),pin=await call('@forgegraph/foundation/specification/_/SpecificationPin.create',{repository:repo.id,anchor:'governance',revision:'a'.repeat(40)});
  const bundle=await call('@forgegraph/foundation/evidence/_/EvidenceBundle.create',{key:'governance',label:'Governance evidence'}),seal=await run(new Evidence(engine).seal(String(bundle.id),null,ctx));
  const party=await call('@forgegraph/foundation/party/_/Party.create',{label:'User'}),reviewerParty=await call('@forgegraph/foundation/party/_/Party.create',{label:'Reviewer'}),subject=await call(d+'DelegationSubject.create',{label:'User'}),agent=await call(d+'DelegationSubject.create',{label:'Service account'}),holder=await call(d+'DelegationPartySubject.create',{subject:subject.id,party:party.id});
  const set=await call(pp+'ParticipationSet.create',{label:'Access reviewers'}),role=await call(pp+'ParticipationRole.create',{namespace:'governance',name:'reviewer'}),reviewer=await call(pp+'Participation.create',{participationSet:set.id,participant:reviewerParty.id,role:role.id,validFrom:from,validUntil:until,recordedBy:ctx.actor,reason:'Assigned reviewer'});
  const reviewerSubject=await call(ap+'AttestationSubject.create',{label:'Reviewer'}),certifier=await call(ap+'AttestationPartySubject.create',{subject:reviewerSubject.id,party:reviewerParty.id});
  async function identity(owner:unknown){const qualificationSubject=await call(q+'QualificationSubject.create',{label:'Access holder'}),attestationSubject=await call(ap+'AttestationSubject.create',{label:'Access subject'});return call(p+'AccessIdentity.create',{subject:owner,qualificationSubject:qualificationSubject.id,attestationSubject:attestationSubject.id});}
  const userIdentity=await identity(subject.id),agentIdentity=await identity(agent.id),scope=await call(e+'EntitlementScope.create',{label:'Tenant administration'}),right=await call(e+'RightDefinition.create',{namespace:'tenant',name:'admin'});
  const root=await run(new Entitlements(engine).issue({holder:String(party.id),scope:String(scope.id),right:String(right.id),validFrom:from,validUntil:until,reason:'Approved root authority'},ctx));
  const qualificationDefinition=await call(q+'QualificationDefinition.create',{key:'training',pin:pin.id,label:'Admin training'}),qualificationRequirement=await call(q+'QualificationRequirement.create',{definition:qualificationDefinition.id,minimumLevel:null});
  const award=await run(new Qualifications(engine).award({subject:String(userIdentity.qualificationSubject),definition:String(qualificationDefinition.id),issuer:String(reviewerParty.id),issuerRecord:'training',issuedAt:from,expiresAt:until,support:String(seal.id)},ctx));
  async function decision(options:string[]){const record=await run(decisions.open({participationSet:String(set.id),electors:[String(reviewer.id)],eligibilityAt:await now(),rule:'Single',options,deadline:until},ctx));return {record,options:(await run(decisions.state(String(record.id),ctx))).options};}
  async function approve(id:unknown,choice:number){await run(decisions.respond(String(id),String(reviewer.id),[choice],ctx));await run(decisions.finalize(String(id),ctx));}
  async function grant(identity:typeof userIdentity,delegation?:string){const approval=await decision(['Approve','Reject']);const request=await call(p+'AccessRequest.create',{identity:identity.id,subject:identity.subject,root:root.id,holder:delegation?null:holder.id,delegation:delegation??null,membership:null,qualification:delegation?null:qualificationRequirement.id,policy:pin.id,decisionCase:approval.record.id,approvedOption:approval.options[0]!.id,validFrom:from,validUntil:until,reviewDue:due,source:'approved-access-request',support:seal.id});await approve(approval.record.id,0);return run(service.issue(String(request.id),ctx));}
  const first=await grant(userIdentity),second=await grant(userIdentity);
  await call('@fixture/access-governance-consumer/_/WorkforceAccess.create',{grant:first.id,position:'Administrator'});await call('@fixture/access-governance-consumer/_/TenantAccess.create',{grant:second.id,tenantKey:'customer-1'});
  const delegation=await call(d+'Delegation.create',{delegator:subject.id,delegate:agent.id,root:root.id,rootHolder:holder.id,parent:null,depth:1,scope:scope.id,right:right.id,constraints:pin.id,purpose:'tenant-admin',validFrom:from,validUntil:until,redelegable:false,source:'workload mandate',support:seal.id});
  const delegated=await grant(agentIdentity,String(delegation.id));await call('@fixture/access-governance-consumer/_/ServiceAccountAccess.create',{grant:delegated.id,workload:'billing-service'});
  expect((await run(service.explain(String(delegated.id),await now(),ctx))).chain).toHaveLength(1);
  async function review(grant:unknown,outcome:'continued'|'modified'|'revoked',conflict?:unknown){
   const approval=await decision(['Continue','Modify','Revoke']);const review=await call(p+'AccessReview.create',{grant,kind:conflict?'adHoc':'periodic',reviewer:reviewer.id,certifier:certifier.id,decisionCase:approval.record.id,continueOption:approval.options[0]!.id,modifyOption:approval.options[1]!.id,revokeOption:approval.options[2]!.id,findingCount:conflict?1:0,reason:'Review access'});
   if(conflict)await call(p+'AccessReviewFinding.create',{review:review.id,ordinal:1,conflictingGrant:conflict,support:seal.id,reason:'Segregation of duties conflict'});
   await approve(approval.record.id,['continued','modified','revoked'].indexOf(outcome));
   const current=await now(),assertion=await run(attestations.issue({issuer:String(reviewerSubject.id),subject:String(userIdentity.attestationSubject),issuerRecord:String(review.id),specification:String(pin.id),issuedAt:current,validFrom:current,validUntil:until,conclusion:'Access review: '+outcome,source:'review:'+review.id,support:String(seal.id)},ctx));
   return {review,assertion};
  }
  const continuation=await review(first.id,'continued',second.id);
  const continuationInput={outcome:'continued' as const,certification:String(continuation.assertion.id),nextReviewAt:'2026-01-25T00:00:00Z',reason:'Certified'};
  await expect(run(service.complete(String(continuation.review.id),continuationInput,ctx))).rejects.toThrow();
  await run(service.complete(String(continuation.review.id),{...continuationInput,acceptsConflicts:true},ctx));
  expect((await run(service.explain(String(first.id),'2026-01-20T00:00:00Z',ctx))).effective).toBe(true);
  expect((await run(service.explain(String(second.id),'2026-01-20T00:00:00Z',ctx))).reasons).toContain('review-overdue');
  const replacement=await grant(userIdentity),modification=await review(second.id,'modified');await run(service.complete(String(modification.review.id),{outcome:'modified',certification:String(modification.assertion.id),nextReviewAt:due,replacement:String(replacement.id),reason:'Replace grant'},ctx));expect((await run(service.explain(String(second.id),await now(),ctx))).effective).toBe(false);
  const pip=await run(service.pip(String(first.id),String(subject.id),ctx));
  const policy=localAuthorizer({policies:[{id:'separate-access-policy',actions:['admin'],requires:[{pip:pip.pip,attribute:pip.attribute}],where:[{field:'id',op:'in',from:{pip:pip.pip,attribute:pip.attribute,map:{true:['tenant-admin']}}}]}],pips:[],epoch:1,knownObligations:[]});
  vi.useFakeTimers({toFake:['Date']});vi.setSystemTime(new Date(pip.observedAt));try{expect((await run(policy.decide({principal:{tenant:ctx.tenant,actor:ctx.actor},action:'admin',kind:'read',current:{id:'tenant-admin'},attributes:[pip],requestId:'access'}))).effect).toBe('allow');}finally{vi.useRealTimers();}
  await run(attestations.end(String(continuation.assertion.id),await now(),'Certification withdrawn',ctx));expect((await run(service.explain(String(first.id),await now(),ctx))).reasons).toContain('certification-inactive');
  const lateDecision=await decision(['Approve','Reject']);await approve(lateDecision.record.id,0);
  const originalRequest=await call(p+'AccessRequest.get',{id:first.request});
  const fields=['identity','subject','root','holder','delegation','membership','qualification','policy','validFrom','validUntil','reviewDue','source','support'];
  const lateRequest=await call(p+'AccessRequest.create',{...Object.fromEntries(fields.map(field=>[field,originalRequest[field]])),decisionCase:lateDecision.record.id,approvedOption:lateDecision.options[0]!.id});
  await expect(run(service.issue(String(lateRequest.id),ctx))).rejects.toThrow();
  const revocation=await review(first.id,'revoked'),revokeInput={outcome:'revoked' as const,certification:String(revocation.assertion.id),nextReviewAt:due,reason:'Remove access'};
  const race=await Promise.allSettled([run(service.complete(String(revocation.review.id),revokeInput,ctx)),run(service.complete(String(revocation.review.id),revokeInput,ctx))]);expect(race.filter(r=>r.status==='fulfilled')).toHaveLength(1);
  expect((await run(service.pip(String(first.id),String(subject.id),ctx))).value).toBe(false);
  await run(new Delegations(engine).revoke(String(delegation.id),await now(),'Workload removed',ctx));expect((await run(service.explain(String(delegated.id),await now(),ctx))).effective).toBe(false);
  await run(new Qualifications(engine).revoke(String(award.id),await now(),'Training invalidated',ctx));expect((await run(service.explain(String(replacement.id),await now(),ctx))).reasons).toContain('qualification-missing');
  const renewedRoot=await run(new Entitlements(engine).renew(String(root.id),{validFrom:until,validUntil:'2026-03-01T00:00:00Z',reason:'Renewed entitlement'},ctx));
  const renewalDecision=await decision(['Approve','Reject']);
  const renewalRequest=await call(p+'AccessRequest.create',{...Object.fromEntries(fields.map(field=>[field,originalRequest[field]])),root:renewedRoot.id,qualification:null,validFrom:until,validUntil:'2026-03-01T00:00:00Z',reviewDue:'2026-02-15T00:00:00Z',decisionCase:renewalDecision.record.id,approvedOption:renewalDecision.options[0]!.id});await approve(renewalDecision.record.id,0);
  const renewal=await run(service.issue(String(renewalRequest.id),ctx));
  expect((await run(service.explain(String(renewal.id),await now(),ctx))).effective).toBe(false);
  expect((await run(service.explain(String(renewal.id),'2026-02-02T00:00:00Z',ctx))).effective).toBe(true);
  const hidden=new Engine(engine.model,engine.layer);hidden.gatekeeper.authorizer=localAuthorizer({policies:engine.model.resources.filter(r=>r.id!==p+'AccessGrantEnd').map(r=>({id:r.id,actions:[r.id+'.*'],requires:[],where:[]})),pips:[],epoch:2,knownObligations:[]});await expect(run(new AccessGovernance(hidden).explain(String(first.id),await now(),ctx))).rejects.toThrow();
  await expect(run(service.pip(String(first.id),String(agent.id),ctx))).rejects.toThrow();await expect(run(service.explain(String(first.id),await now(),{...ctx,tenant:'foreign'}))).rejects.toThrow();
 }finally{await h.close();}
});
