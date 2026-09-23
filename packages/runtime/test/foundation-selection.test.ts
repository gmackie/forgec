import { Effect } from "effect";
import { expect, it } from "vitest";
import { foundation, foundationAdapters } from "./helpers/foundation.js";
import { Selection } from "../src/foundation/selection.js";
import { Evaluations } from "../src/foundation/evaluation.js";
import { Decisions } from "../src/foundation/decision.js";
import { AgreementCatalog } from "../src/foundation/agreement-catalog.js";
import type { Wire } from "../src/decode.js";
import { Engine } from "../src/engine.js";
import { localAuthorizer } from "../src/gatekeeper.js";
const p="@forgegraph/foundation/selection/_/",sp="@forgegraph/foundation/specification/_/",pp="@forgegraph/foundation/participation/_/",ep="@forgegraph/foundation/evaluation/_/",ap="@forgegraph/foundation/agreement-catalog/_/";
for(const adapter of foundationAdapters)it(`${adapter}: scored shortlist, pinned decision and winning issued agreement`,async()=>{
 const h=await foundation("selection",adapter,true),run=Effect.runPromise;try{
  const {engine,ctx,call}=h,selection=new Selection(engine),evaluations=new Evaluations(engine),decisions=new Decisions(engine),agreements=new AgreementCatalog(engine);
  const repo=await call(sp+"Repository.create",{key:"selection",provider:"git",locator:"https://example.test/spec"});
  const criteria=await call(sp+"SpecificationPin.create",{repository:repo.id,anchor:"criteria",revision:"a".repeat(40)}),terms=await call(sp+"SpecificationPin.create",{repository:repo.id,anchor:"terms",revision:"b".repeat(40)});
  const participants=await call(pp+"ParticipationSet.create",{label:"Submitters"}),role=await call(pp+"ParticipationRole.create",{namespace:"selection",name:"participant"});
  const members:Wire[]=[],parties:Wire[]=[];
  for(const label of ["Supplier A","Supplier B","Buyer"]){const party=await call("@forgegraph/foundation/party/_/Party.create",{label});parties.push(party);members.push(await call(pp+"Participation.create",{participationSet:participants.id,participant:party.id,role:role.id,validFrom:"2025-01-01T00:00:00Z",validUntil:null,reason:"Applicant or buyer",recordedBy:ctx.actor}));}
  const solicitation=await call(p+"Solicitation.create",{key:"tender",criteria:criteria.id,terms:terms.id,participants:participants.id,opensAt:"2025-01-01T00:00:00Z",closesAt:"2026-01-01T00:05:00Z",tiePolicy:"reject"});
  const executor=await call(ep+"EvaluationExecutor.create",{key:"reviewer",label:"Reviewer"}),scores=[],submissions=[];
  for(const [i,member] of members.slice(0,2).entries()){
   const set=await call(ep+"EvaluationSet.create",{label:"Applicant "+i});
   const submission=await run(selection.submit({solicitation:String(solicitation.id),key:"application-"+i,participant:String(member.id),evaluationSet:String(set.id)},ctx));submissions.push(submission);
   const wrongRun=await run(evaluations.create({evaluationSet:String(set.id),definition:String(terms.id),executor:String(executor.id)},ctx));
   await run(evaluations.start(String(wrongRun.id),"2026-01-01T00:00:00Z",ctx));
   const wrongFinish=await run(evaluations.finish(String(wrongRun.id),"Completed","2026-01-01T00:00:01Z","Wrong criterion",ctx));
   await expect(run(selection.scoreSubmission(String(submission.id),String(wrongFinish.id),"100","Wrong criteria",ctx))).rejects.toThrow();
   const evaluation=await run(evaluations.create({evaluationSet:String(set.id),definition:String(criteria.id),executor:String(executor.id)},ctx));
   await run(evaluations.start(String(evaluation.id),"2026-01-01T00:00:00Z",ctx));
   const finish=await run(evaluations.finish(String(evaluation.id),"Completed","2026-01-01T00:00:01Z","Reviewed criteria",ctx));
   scores.push(await run(selection.scoreSubmission(String(submission.id),String(finish.id),i===0?"9.000001":"8.999999","Explicit domain rubric",ctx)));
  }
  for(const [name,field] of [["ProcurementBid","tenderCode"],["JobApplication","applicationCode"],["GrantApplication","programCode"]])await call("@foundation-probe/selection-consumers/_/"+name+".create",{submission:submissions[0]!.id,[field!]:"demo"});
  const ties=[];
  for(const tiePolicy of ["reject","submissionKey"]){
   const solicitation=await call(p+"Solicitation.create",{key:tiePolicy,criteria:criteria.id,terms:terms.id,participants:participants.id,opensAt:"2025-01-01T00:00:00Z",closesAt:"2026-01-01T00:05:00Z",tiePolicy}),tiedScores=[];
   for(const [i,member] of members.slice(0,2).entries()){
    const submission=await run(selection.submit({solicitation:String(solicitation.id),key:"tie-"+i,participant:String(member.id),evaluationSet:String(submissions[i]!.evaluationSet)},ctx));
    tiedScores.push(await run(selection.scoreSubmission(String(submission.id),String(scores[i]!.finish),"10","Tied",ctx)));
   }
   const decision=await run(decisions.open({participationSet:String(participants.id),electors:[String(members[2]!.id)],eligibilityAt:"2026-01-01T00:00:00Z",rule:"ChooseOne",options:["First","Second"],deadline:"2026-02-01T00:00:00Z"},ctx));
   ties.push({solicitation,decision,tiedScores,tiePolicy});
  }
  const decision=await run(decisions.open({participationSet:String(participants.id),electors:[String(members[2]!.id)],eligibilityAt:"2026-01-01T00:00:00Z",rule:"ChooseOne",options:["Highest score","Second score"],deadline:"2026-02-01T00:00:00Z"},ctx));
  await expect(run(selection.shortlist(String(solicitation.id),String(decision.id),scores.map(s=>String(s.id)),ctx))).rejects.toThrow();engine.testClockJump(10*60*1000);
  await expect(run(selection.submit({solicitation:String(solicitation.id),key:"late",participant:String(members[0]!.id),evaluationSet:String(submissions[0]!.evaluationSet)},ctx))).rejects.toThrow();
  for(const tie of ties){const effect=selection.shortlist(String(tie.solicitation.id),String(tie.decision.id),tie.tiedScores.toReversed().map(s=>String(s.id)),ctx);if(tie.tiePolicy==="reject")await expect(run(effect)).rejects.toThrow();else expect((await run(effect)).id).toBeTruthy();}
  const shortlist=await run(selection.shortlist(String(solicitation.id),String(decision.id),scores.toReversed().map(s=>String(s.id)),ctx));
  await run(decisions.respond(String(decision.id),String(members[2]!.id),[0],ctx));await run(decisions.finalize(String(decision.id),ctx));
  // The issued agreement comes from a separate real two-signer approval decision.
  const catalog=await call(ap+"Catalog.create",{key:"services",label:"Services"}),entry=await call(ap+"CatalogEntry.create",{catalog:catalog.id,key:"service",specification:terms.id});
  const scope=await call("@forgegraph/foundation/entitlement/_/EntitlementScope.create",{label:"Service"});
  async function issued(supplierIndex:number,key:string){
   const offerEntry=await call(ap+"CatalogEntry.create",{catalog:catalog.id,key,specification:terms.id});
   const offer=await run(agreements.publish({entry:String(offerEntry.id),supplier:String(parties[supplierIndex]!.id),terms:String(terms.id),scope:String(scope.id),validFrom:"2025-01-01T00:00:00Z",validUntil:"2027-01-01T00:00:00Z"},ctx));
   const approval=await run(decisions.open({participationSet:String(participants.id),electors:[String(members[supplierIndex]!.id),String(members[2]!.id)],eligibilityAt:"2026-01-01T00:00:00Z",rule:"Unanimous",options:["Accept","Reject"],deadline:"2027-01-01T00:00:00Z"},ctx));
   const options=(await run(decisions.state(String(approval.id),ctx))).options;
   await run(agreements.select(String(offer.id),String(approval.id),String(options[0]!.id),ctx));
   for(const member of [members[supplierIndex]!,members[2]!])await run(decisions.respond(String(approval.id),String(member.id),[0],ctx));await run(decisions.finalize(String(approval.id),ctx));
   const agreement=await run(agreements.accept({acceptanceKey:key,offer:String(offer.id),customer:String(parties[2]!.id),supplierParticipation:String(members[supplierIndex]!.id),customerParticipation:String(members[2]!.id),decisionCase:String(approval.id),approvedOption:String(options[0]!.id),expectedTerms:String(terms.id),validFrom:"2026-02-01T00:00:00Z",validUntil:"2026-12-01T00:00:00Z"},ctx));
   await run(agreements.issue(String(agreement.id),ctx));return agreement;
  }
  const wrongAgreement=await issued(1,"loser");
  await expect(run(selection.award(String(shortlist.id),String(wrongAgreement.id),ctx))).rejects.toThrow();
  const agreement=await issued(0,"winner");
  const awards=await Promise.allSettled([run(selection.award(String(shortlist.id),String(agreement.id),ctx)),run(selection.award(String(shortlist.id),String(agreement.id),ctx))]);expect(awards.some(x=>x.status==="fulfilled")).toBe(true);
  const award=await run(selection.award(String(shortlist.id),String(agreement.id),ctx));expect(award.submission).toBe(submissions[0]!.id);
  expect((await run(new Selection(new Engine(engine.model,engine.layer)).inspectAward(String(solicitation.id),ctx))).id).toBe(award.id);
  await expect(call(p+"SelectionAward.delete",{id:award.id})).rejects.toThrow();
  const hidden=new Engine(engine.model,engine.layer);hidden.gatekeeper.authorizer=localAuthorizer({policies:engine.model.resources.filter(r=>r.id!==ep+"EvaluationFinish").map(r=>({id:r.id,actions:[r.id+".*"],requires:[],where:[]})),pips:[],epoch:1,knownObligations:[]});
  await expect(run(new Selection(hidden).inspectAward(String(solicitation.id),ctx))).rejects.toThrow();
  await expect(run(selection.inspectAward(String(solicitation.id),{...ctx,tenant:"other"}))).rejects.toThrow();
 }finally{await h.close();}
});
