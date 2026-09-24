import { Effect } from "effect";
import { expect, it } from "vitest";
import { foundation, foundationAdapters } from "./helpers/foundation.js";
import { Quotations, type QuoteInput } from "../src/foundation/quotation-pricing.js";
import { AgreementCatalog } from "../src/foundation/agreement-catalog.js";
import { Decisions } from "../src/foundation/decision.js";
import { Evaluations } from "../src/foundation/evaluation.js";
import { Opportunities } from "../src/foundation/opportunity.js";
import { Engine } from "../src/engine.js";
import { localAuthorizer } from "../src/gatekeeper.js";
const p="@forgegraph/foundation/quotation-pricing/_/",a="@forgegraph/foundation/agreement-catalog/_/",sp="@forgegraph/foundation/specification/_/",lp="@forgegraph/foundation/ledger/_/",pp="@forgegraph/foundation/participation/_/";
const op="@forgegraph/foundation/opportunity/_/",ep="@forgegraph/foundation/evaluation/_/";
const run=Effect.runPromise;
async function fixture(adapter: string) {
 const h=await foundation("opportunity",adapter,true);
  const {engine,ctx,call}=h,quotes=new Quotations(engine),catalog=new AgreementCatalog(engine),decisions=new Decisions(engine);
  const repo=await call(sp+"Repository.create",{key:"pricing",provider:"git",locator:"https://example.test/pricing"}),terms=await call(sp+"SpecificationPin.create",{repository:repo.id,anchor:"terms",revision:"a".repeat(40)});
  const supplier=await call("@forgegraph/foundation/party/_/Party.create",{label:"Supplier"}),buyer=await call("@forgegraph/foundation/party/_/Party.create",{label:"Buyer"});
  const set=await call(pp+"ParticipationSet.create",{label:"Signers"}),role=await call(pp+"ParticipationRole.create",{namespace:"quotes",name:"signer"}),signers=[];
  for(const party of [supplier,buyer])signers.push(await call(pp+"Participation.create",{participationSet:set.id,participant:party.id,role:role.id,validFrom:"2025-01-01T00:00:00Z",validUntil:null,reason:"Signer",recordedBy:ctx.actor}));
  const cat=await call(a+"Catalog.create",{key:"services",label:"Services"}),entry=await call(a+"CatalogEntry.create",{catalog:cat.id,key:"service",specification:terms.id}),scope=await call("@forgegraph/foundation/entitlement/_/EntitlementScope.create",{label:"Service"});
  const offer=await run(catalog.publish({entry:String(entry.id),supplier:String(supplier.id),terms:String(terms.id),scope:String(scope.id),validFrom:"2025-01-01T00:00:00Z",validUntil:"2027-01-01T00:00:00Z"},ctx));
  const approval=await run(decisions.open({participationSet:String(set.id),electors:signers.map(s=>String(s.id)),eligibilityAt:"2026-01-01T00:00:00Z",rule:"Unanimous",options:["Accept","Reject"],deadline:"2027-01-01T00:00:00Z"},ctx)),options=(await run(decisions.state(String(approval.id),ctx))).options;
  await run(catalog.select(String(offer.id),String(approval.id),String(options[0]!.id),ctx));for(const signer of signers)await run(decisions.respond(String(approval.id),String(signer.id),[0],ctx));await run(decisions.finalize(String(approval.id),ctx));
  const acceptance={supplierParticipation:String(signers[0]!.id),customerParticipation:String(signers[1]!.id),decisionCase:String(approval.id),approvedOption:String(options[0]!.id),validFrom:"2026-02-01T00:00:00Z",validUntil:"2026-12-01T00:00:00Z"};
  const book=await call(lp+"LedgerBook.create",{key:"prices"}),usd=await call(lp+"Account.create",{book:book.id,key:"USD",unit:"USD"}),credit=await call(lp+"Account.create",{book:book.id,key:"credits",unit:"credit"});
  const rate=await call(p+"PricingRate.create",{key:"money",definition:terms.id,account:usd.id,unitPrice:"0.200000",validFrom:"2026-01-01T00:00:00Z",validUntil:"2026-02-01T00:00:00Z"});
  const nonmonetary=await call(p+"PricingRate.create",{key:"credit",definition:terms.id,account:credit.id,unitPrice:"2",validFrom:"2026-01-01T00:00:00Z",validUntil:"2026-02-01T00:00:00Z"});
  const discount=await call(p+"PriceAdjustment.create",{key:"discount",definition:terms.id,account:usd.id,amount:"-0.100000",reason:"Promotion"});
  const evalPrefix="@forgegraph/foundation/evaluation/_/",evalSet=await call(evalPrefix+"EvaluationSet.create",{label:"Price calculation"}),executor=await call(evalPrefix+"EvaluationExecutor.create",{key:"pricing",label:"Pricing"}),evaluations=new Evaluations(engine);
  const calculation=await run(evaluations.create({evaluationSet:String(evalSet.id),definition:String(terms.id),executor:String(executor.id)},ctx));await run(evaluations.start(String(calculation.id),"2026-01-01T00:00:00Z",ctx));
  const finish=await run(evaluations.finish(String(calculation.id),"Completed","2026-01-01T00:00:01Z","Rate policy evaluated",ctx));
  const input:QuoteInput={key:"first",evaluation:String(finish.id),offer:String(offer.id),buyer:String(buyer.id),terms:String(terms.id),pricedAt:"2026-01-01T00:00:00Z",expiresAt:"2026-01-02T00:00:00Z",lines:[{rate:String(rate.id),quantity:"2.5",adjustment:String(discount.id)},{rate:String(nonmonetary.id),quantity:"3"}]};
 return {...h,quotes,catalog,decisions,acceptance,input,offer,signers,terms,usd,rate,nonmonetary,discount};
}
for (const adapter of foundationAdapters) it(`${adapter}: configurable pursuit, sourced qualification, conversion and terminal races`, async () => {
 const h=await fixture(adapter);
 try {
  const {engine,ctx,call,quotes,input,acceptance,terms,signers}=h;
  const service=new Opportunities(engine),evaluations=new Evaluations(engine);
  const definition=await call(op+'PursuitDefinition.create',{key:'domain-pursuit',specification:terms.id});
  const stages:Record<string,string>={};
  for(const [key,outcome] of [['discover','Open'],['qualified','Open'],['converted','Won'],['declined','Lost'],['withdrawn','Abandoned']]){
   const stage=await call(op+'PursuitStage.create',{definition:definition.id,key,label:key,initial:key==='discover',outcome});stages[key!]=String(stage.id);
  }
  const transitions:Record<string,string>={};
  for(const key of ['qualified','converted','declined','withdrawn'])transitions[key]=String((await call(op+'StageTransition.create',{fromStage:stages.discover,toStage:stages[key]})).id);
  const qualifyToWin=await call(op+'StageTransition.create',{fromStage:stages.qualified,toStage:stages.converted});
  const executor=await call(ep+'EvaluationExecutor.create',{key:'qualification',label:'Domain evaluator'});
  const start='2026-01-01T00:00:00Z',at='2026-01-01T00:00:01Z';
  async function pursuit(key:string){
   const set=await call(ep+'EvaluationSet.create',{label:key});
   const row=await call(op+'Opportunity.create',{key,definition:definition.id,subject:input.buyer,participants:signers[0]!.participationSet,qualification:terms.id,evaluations:set.id,potentialOutcome:'Possible future valuable outcome',openedAt:start,expectedAt:'2026-02-01T00:00:00Z'});
   await call(op+'OpportunityParticipant.create',{opportunity:row.id,participant:signers[0]!.id});
   await run(service.transition(String(row.id),{stage:stages.discover!,effectiveAt:start,nextAction:'Discuss requirements',reason:'Intake'},ctx));
   return row;
  }
  const sales=await pursuit('sales');
  const evalRun=await run(evaluations.create({evaluationSet:String(sales.evaluations),definition:String(terms.id),executor:String(executor.id)},ctx));
  await run(evaluations.start(String(evalRun.id),start,ctx));
  const finish=await run(evaluations.finish(String(evalRun.id),'Completed',at,'Domain rubric assessed',ctx));
  const assessment=await run(service.assess(String(sales.id),{finish:String(finish.id),confidence:'0.650000',potentialValue:'10000.000000',unit:'USD',rationale:'Evaluator forecast, not guaranteed revenue'},ctx));
  await run(service.transition(String(sales.id),{stage:stages.qualified!,transition:transitions.qualified!,assessment:String(assessment.id),effectiveAt:at,reason:'Qualified by domain rubric'},ctx));
  await expect(run(service.transition(String(sales.id),{stage:stages.converted!,transition:String(qualifyToWin.id),effectiveAt:at,reason:'Unsubstantiated win'},ctx))).rejects.toThrow();
  const quote=await run(quotes.publish(input,ctx));
  await run(service.linkQuote(String(sales.id),String(quote.id),ctx));
  const stateBefore=await run(service.state(String(sales.id),ctx));expect(stateBefore.outcome).toBe('Open');
  const agreement=await run(quotes.accept(String(quote.id),acceptance,ctx));
  await expect(run(service.transition(String(sales.id),{stage:stages.converted!,transition:String(qualifyToWin.id),agreement:String(agreement.agreement),effectiveAt:at,reason:'Backdated before issuance'},ctx))).rejects.toMatchObject({code:'ValidationFailed'});
  const issued=await run(h.catalog.state(String(agreement.agreement),'2026-02-01T00:00:00Z',ctx));
  await run(service.transition(String(sales.id),{stage:stages.converted!,transition:String(qualifyToWin.id),agreement:String(agreement.agreement),effectiveAt:String(issued.issuance!.createdAt),reason:'Quote accepted and agreement issued'},ctx));
  expect((await run(service.state(String(sales.id),ctx))).outcome).toBe('Won');
  await expect(run(service.transition(String(sales.id),{stage:stages.discover!,effectiveAt:at,reason:'Reopen'},ctx))).rejects.toThrow();
  for(const [key,name,field] of [['partnership','PartnershipPursuit','sharedOutcome'],['grant','GrantPursuit','program'],['procurement','ProcurementPursuit','requirement']]){
   const row=await pursuit(key!);
   await call('@fixture/opportunity-consumer/_/'+name+'.create',{pursuit:row.id,[field!]:'Domain-owned details'});
   await expect(run(service.assess(String(row.id),{finish:String(finish.id),rationale:'Cross-pursuit result'},ctx))).rejects.toMatchObject({code:'ValidationFailed'});
   const solicitation=await call('@forgegraph/foundation/selection/_/Solicitation.create',{key,criteria:terms.id,terms:terms.id,participants:row.participants,opensAt:start,closesAt:'2026-02-01T00:00:00Z',tiePolicy:'reject'});
   await run(service.linkSelection(String(row.id),String(solicitation.id),ctx));
   const outcomes=await Promise.allSettled(['declined','withdrawn'].map(stage=>run(service.transition(String(row.id),{stage:stages[stage]!,transition:transitions[stage]!,effectiveAt:at,reason:'Terminal decision'},ctx))));
   expect(outcomes.filter(o=>o.status==='fulfilled')).toHaveLength(1);
   expect(['Lost','Abandoned']).toContain((await run(service.state(String(row.id),ctx))).outcome);
  }
  await call('@fixture/opportunity-consumer/_/SalesPursuit.create',{pursuit:sales.id,product:'Consulting'});
  const abandoned=await pursuit('explicit-abandoned');
  await run(service.transition(String(abandoned.id),{stage:stages.withdrawn!,transition:transitions.withdrawn!,effectiveAt:at,reason:'Pursuit abandoned'},ctx));
  expect((await run(service.state(String(abandoned.id),ctx))).outcome).toBe('Abandoned');
  await expect(call(op+'OpportunityEvent.delete',{id:stateBefore.events[0]!.id})).rejects.toThrow();
  await expect(run(service.state(String(sales.id),{...ctx,tenant:'other'}))).rejects.toThrow();
  const guarded=new Engine(engine.model,engine.layer);
  guarded.gatekeeper.authorizer=localAuthorizer({policies:engine.model.resources.filter(r=>r.id!==op+'OpportunityEvent').map(r=>({id:r.id,actions:[r.id+'.*'],requires:[],where:[]})),pips:[],epoch:2,knownObligations:[]});
  await expect(run(new Opportunities(guarded).state(String(sales.id),ctx))).rejects.toThrow();
  await call(ep+'EvaluationQuarantine.create',{run:evalRun.id,sourceDigest:'a'.repeat(64),reason:'Untrusted evaluator result',recordedBy:ctx.actor});
  await expect(run(service.state(String(sales.id),ctx))).rejects.toMatchObject({code:'ValidationFailed'});
 } finally { await h.close(); }
});
