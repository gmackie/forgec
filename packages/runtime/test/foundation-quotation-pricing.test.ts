import { Effect } from "effect";
import { expect, it, vi } from "vitest";
import { foundation, foundationAdapters } from "./helpers/foundation.js";
import { Quotations, type QuoteInput } from "../src/foundation/quotation-pricing.js";
import { AgreementCatalog } from "../src/foundation/agreement-catalog.js";
import { Decisions } from "../src/foundation/decision.js";
import { Evaluations } from "../src/foundation/evaluation.js";
import { Ledger } from "../src/foundation/ledger.js";
import { Engine } from "../src/engine.js";
import { localAuthorizer } from "../src/gatekeeper.js";
const p="@forgegraph/foundation/quotation-pricing/_/",a="@forgegraph/foundation/agreement-catalog/_/",sp="@forgegraph/foundation/specification/_/",lp="@forgegraph/foundation/ledger/_/",pp="@forgegraph/foundation/participation/_/";
const run=Effect.runPromise;
async function fixture(adapter: string) {
 const h=await foundation("quotation-pricing",adapter,true);
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
for(const adapter of foundationAdapters)it(`${adapter}: exact quote snapshot, rate bounds, revision races and resumable agreement`,async()=>{
 const h=await fixture(adapter);try{
 const {engine,ctx,call,quotes,catalog,decisions,acceptance,input,offer,signers,terms,usd,rate,nonmonetary,discount}=h;
  const quote=await run(quotes.publish(input,ctx));expect((await run(quotes.inspect(String(quote.id),ctx))).totals).toEqual({USD:"0.400000",credit:"6.000000"});
  expect((await run(quotes.publish(input,ctx))).id).toBe(quote.id);
  await expect(run(quotes.publish({...input,lines:[{rate:String(rate.id),quantity:"3"}]},ctx))).rejects.toThrow();
  await expect(run(quotes.publish({...input,key:"precision",lines:[{rate:String(rate.id),quantity:"0.000001"}]},ctx))).rejects.toThrow();
  await expect(run(quotes.publish({...input,key:"rate-boundary",pricedAt:"2026-02-01T00:00:00Z",expiresAt:"2026-02-02T00:00:00Z"},ctx))).rejects.toThrow();
  await expect(run(quotes.publish({...input,key:"unit",lines:[{rate:String(nonmonetary.id),quantity:"1",adjustment:String(discount.id)}]},ctx))).rejects.toThrow();
  const revised=await run(quotes.publish({...input,key:"revised",previous:String(quote.id),lines:[{rate:String(rate.id),quantity:"5"}]},ctx));
  expect((await run(quotes.publish({...input,key:"revised",previous:String(quote.id),lines:[{rate:String(rate.id),quantity:"5"}]},ctx))).id).toBe(revised.id);
  await expect(run(quotes.accept(String(quote.id),acceptance,ctx))).rejects.toThrow();expect((await run(quotes.inspect(String(quote.id),ctx))).totals.USD).toBe("0.400000");
  for(const name of ["SaaSQuote","ServiceQuote","ProcurementQuote"])await call("@foundation-probe/quotation-pricing-consumers/_/"+name+".create",{quote:revised.id});
  // Durable acceptance survives an authorization failure during Agreement issuance.
  const guarded=new Engine(engine.model,engine.layer);guarded.gatekeeper.authorizer=localAuthorizer({policies:engine.model.resources.map(r=>({id:r.id,actions:[r.id+(r.id===a+"AgreementIssued"?".get":".*")],requires:[],where:[]})),pips:[],epoch:1,knownObligations:[]});
  await expect(run(new Quotations(guarded).accept(String(revised.id),acceptance,ctx))).rejects.toThrow();
  expect((await run(quotes.inspect(String(revised.id),ctx))).end?.outcome).toBe("Accepted");
  await expect(run(quotes.agreement(String(revised.id),ctx))).rejects.toThrow();
  const restarted=new Quotations(new Engine(engine.model,engine.layer)),link=await run(restarted.accept(String(revised.id),acceptance,ctx));
  expect((await run(restarted.accept(String(revised.id),acceptance,ctx))).id).toBe(link.id);
  expect((await run(restarted.agreement(String(revised.id),ctx))).id).toBe(link.id);
  await expect(run(restarted.accept(String(revised.id),{...acceptance,validUntil:"2026-11-01T00:00:00Z"},ctx))).rejects.toMatchObject({code:"IdempotencyMismatch"});
  await call("@foundation-probe/quotation-pricing-consumers/_/Order.create",{acceptance:link.acceptance,agreement:link.id});
  expect((await run(new Ledger(engine).balance(String(usd.id),ctx))).quantity).toBe("0.000000");
  const invalid=await run(quotes.publish({...input,key:"bad-signer"},ctx));
  await expect(run(quotes.accept(String(invalid.id),{...acceptance,customerParticipation:String(signers[0]!.id)},ctx))).rejects.toThrow();
  expect((await run(quotes.inspect(String(invalid.id),ctx))).end).toBeNull();
  const expiring=await run(quotes.publish({...input,key:"expiry",expiresAt:"2026-01-01T00:05:00Z"},ctx));
  await expect(run(quotes.expire(String(expiring.id),ctx))).rejects.toThrow();engine.testClockJump(10*60*1000);
  const outcomes=await Promise.allSettled([run(quotes.accept(String(expiring.id),acceptance,ctx)),run(quotes.expire(String(expiring.id),ctx))]);expect(outcomes[0]!.status).toBe("rejected");expect(outcomes[1]!.status).toBe("fulfilled");
  const competing=await run(quotes.publish({...input,key:"competing"},ctx));const race=await Promise.allSettled([run(quotes.accept(String(competing.id),acceptance,ctx)),run(quotes.publish({...input,key:"competing-revision",previous:String(competing.id)},ctx))]);expect(race.filter(r=>r.status==="fulfilled")).toHaveLength(1);
  await expect(run(quotes.inspect(String(revised.id),{...ctx,tenant:"foreign"}))).rejects.toThrow();
  const hidden=new Engine(engine.model,engine.layer);hidden.gatekeeper.authorizer=localAuthorizer({policies:engine.model.resources.filter(r=>r.id!==p+"PriceAdjustment").map(r=>({id:r.id,actions:[r.id+".*"],requires:[],where:[]})),pips:[],epoch:1,knownObligations:[]});
  await expect(run(new Quotations(hidden).inspect(String(quote.id),ctx))).rejects.toThrow();
 }finally{await h.close();}
});

for(const adapter of foundationAdapters){
 it(`${adapter}: accepted quote recovers after quote, offer and contract windows close`,async()=>{
  const h=await fixture(adapter);try{
   const {engine,ctx,quotes,input,acceptance,call}=h;
   const quote=await run(quotes.publish(input,ctx));
   const guarded=new Engine(engine.model,engine.layer);
   guarded.gatekeeper.authorizer=localAuthorizer({policies:engine.model.resources.map(r=>({id:r.id,actions:[r.id+(r.id===a+"Agreement"?".get":".*")],requires:[],where:[]})),pips:[],epoch:1,knownObligations:[]});
   await expect(run(new Quotations(guarded).accept(String(quote.id),acceptance,ctx))).rejects.toThrow();
   const terminal=(await run(quotes.inspect(String(quote.id),ctx))).end!;
   expect(terminal.outcome).toBe("Accepted");expect(terminal.intent).toBeTruthy();
   await call(pp+"ParticipationEnd.create",{revoked:true,participation:h.signers[0]!.id,effectiveAt:"2026-01-15T00:00:00Z",reason:"Authority ended after signing",recordedBy:ctx.actor});
   engine.testClockJump(400*24*60*60*1000);
   await expect(run(quotes.accept(String(quote.id),{...acceptance,validUntil:"2028-01-01T00:00:00Z"},ctx))).rejects.toMatchObject({code:"IdempotencyMismatch"});
   const resumed=new Quotations(new Engine(engine.model,engine.layer));
   const attempts=await Promise.allSettled([run(resumed.accept(String(quote.id),acceptance,{...ctx,actor:"recovery-worker"})),run(resumed.accept(String(quote.id),acceptance,{...ctx,actor:"recovery-worker"}))]);
   expect(attempts.some(x=>x.status==="fulfilled")).toBe(true);
   const link=await run(resumed.accept(String(quote.id),acceptance,{...ctx,actor:"recovery-worker"}));
   expect((await run(resumed.agreement(String(quote.id),ctx))).id).toBe(link.id);
   const agreement=await call(a+"Agreement.get",{id:link.agreement});
   expect(agreement.recordedBy).toBe(ctx.actor);
   expect((await run(h.catalog.state(String(agreement.id),"2027-03-01T00:00:00Z",ctx))).phase).toBe("Expired");
   expect((await run(resumed.accept(String(quote.id),acceptance,ctx))).id).toBe(link.id);
   const hidden=new Engine(engine.model,engine.layer);
   hidden.gatekeeper.authorizer=localAuthorizer({policies:engine.model.resources.filter(r=>r.id!==a+"AgreementAcceptanceCommit").map(r=>({id:r.id,actions:[r.id+".*"],requires:[],where:[]})),pips:[],epoch:1,knownObligations:[]});
   await expect(run(new Quotations(hidden).accept(String(quote.id),acceptance,ctx))).rejects.toThrow();
   hidden.gatekeeper.authorizer=localAuthorizer({policies:engine.model.resources.filter(r=>r.id!=="@forgegraph/foundation/decision/_/DecisionOutcome").map(r=>({id:r.id,actions:[r.id+".*"],requires:[],where:[]})),pips:[],epoch:2,knownObligations:[]});
   await expect(run(new Quotations(hidden).accept(String(quote.id),acceptance,ctx))).rejects.toThrow();
  }finally{await h.close();}
 });
 it(`${adapter}: rejected atomic acceptance leaves no commit and an orphan cannot recover`,async()=>{
  const h=await fixture(adapter);try{
   const {engine,ctx,quotes,input,acceptance,call}=h;
   const quote=await run(quotes.publish(input,ctx));
   const guarded=new Engine(engine.model,engine.layer);
   guarded.gatekeeper.authorizer=localAuthorizer({policies:engine.model.resources.map(r=>({id:r.id,actions:[r.id+(r.id===a+"AgreementAcceptanceCommit"?".get":".*")],requires:[],where:[]})),pips:[],epoch:1,knownObligations:[]});
   await expect(run(new Quotations(guarded).accept(String(quote.id),acceptance,ctx))).rejects.toThrow();
   expect((await run(quotes.inspect(String(quote.id),ctx))).end).toBeNull();
   const intent=await call(a+"AgreementAcceptance.find.byAcceptanceKey",{params:{acceptanceKey:"quote:"+quote.id}});
   expect(intent.id).toBeTruthy();
   const forged={...intent};for(const field of ["id","createdAt","updatedAt","version"])delete forged[field];
   await expect(call(a+"AgreementAcceptance.create",{...forged,acceptanceKey:"forged-window",offerValidUntil:"2030-01-01T00:00:00Z"})).rejects.toMatchObject({code:"ValidationFailed"});
   await expect(call(a+"AgreementAcceptanceCommit.create",{...forged,acceptance:intent.id,offerValidUntil:"2030-01-01T00:00:00Z"})).rejects.toMatchObject({code:"ValidationFailed"});
   await expect(call(a+"AgreementAcceptanceCommit.find.byAcceptance",{params:{acceptance:intent.id}})).rejects.toMatchObject({code:"NotFound"});
   const accepted=await run(quotes.publish({...input,key:"winner",previous:String(quote.id)},ctx));
   expect(accepted.previous).toBe(quote.id);
   await expect(run(quotes.accept(String(quote.id),acceptance,ctx))).rejects.toThrow();
   await expect(run(h.catalog.acceptCommitted({ ...acceptance,acceptanceKey:"quote:"+quote.id,offer:input.offer,customer:input.buyer,expectedTerms:input.terms },String(intent.id),ctx))).rejects.toThrow();
  }finally{await h.close();}
 });
 it(`${adapter}: acceptance delayed beyond offer or start cutoff cannot publish terminal`,async()=>{
  for(const elapsed of [32,400]){
   const h=await fixture(adapter);try{
    const {engine,ctx,quotes,input,acceptance}=h;
    const quote=await run(quotes.publish({...input,expiresAt:"2028-01-01T00:00:00Z"},ctx));
    const atomic=engine.atomic.bind(engine);
    const spy=vi.spyOn(engine,"atomic").mockImplementation((mutations,context,options)=>{engine.testClockJump(elapsed*24*60*60*1000);return atomic(mutations,context,options);});
    try{await expect(run(quotes.accept(String(quote.id),acceptance,ctx))).rejects.toMatchObject({code:"ValidationFailed"});}finally{spy.mockRestore();}
    expect((await run(quotes.inspect(String(quote.id),ctx))).end).toBeNull();
    await expect(run(quotes.agreement(String(quote.id),ctx))).rejects.toThrow();
   }finally{await h.close();}
  }
 });
}

for(const adapter of foundationAdapters)it(`${adapter}: recovery rejects signatory authority ended before committed acceptance`,async()=>{
 const h=await fixture(adapter);try{
  const quote=await run(h.quotes.publish(h.input,h.ctx));
  const guarded=new Engine(h.engine.model,h.engine.layer);
  guarded.gatekeeper.authorizer=localAuthorizer({policies:h.engine.model.resources.map(r=>({id:r.id,actions:[r.id+(r.id===a+"AgreementIssued"?".get":".*")],requires:[],where:[]})),pips:[],epoch:1,knownObligations:[]});
  await expect(run(new Quotations(guarded).accept(String(quote.id),h.acceptance,h.ctx))).rejects.toThrow();
  await h.call(pp+"ParticipationEnd.create",{revoked:true,participation:h.signers[0]!.id,effectiveAt:"2026-01-01T00:00:00Z",reason:"Authority was absent",recordedBy:h.ctx.actor});
  await expect(run(h.quotes.accept(String(quote.id),h.acceptance,h.ctx))).rejects.toMatchObject({detail:"Signer authority ended before committed acceptance"});
  const agreement=await h.call(a+"Agreement.find.byAcceptanceKey",{params:{acceptanceKey:"quote:"+quote.id}});
  await expect(run(h.catalog.issue(String(agreement.id),h.ctx))).rejects.toMatchObject({detail:"Signer authority ended before committed acceptance"});
  await expect(run(h.catalog.state(String(agreement.id),"2026-03-01T00:00:00Z",h.ctx))).rejects.toMatchObject({detail:"Signer authority ended before committed acceptance"});
 }finally{await h.close();}
});

for(const adapter of foundationAdapters)it(`${adapter}: signer revocation racing acceptance cannot publish terminal or commit`,async()=>{
 const h=await fixture(adapter);try{
  const quote=await run(h.quotes.publish(h.input,h.ctx));
  const atomic=h.engine.atomic.bind(h.engine);
  const spy=vi.spyOn(h.engine,"atomic").mockImplementation((mutations,context,options)=>Effect.gen(function*(){
   yield* h.engine.call(pp+"ParticipationEnd.create",{participation:h.signers[0]!.id,revoked:true,effectiveAt:"2026-01-01T00:00:00Z",recordedBy:h.ctx.actor,reason:"Concurrent revocation"},h.ctx);
   return yield* atomic(mutations,context,options);
  }));
  try{await expect(run(h.quotes.accept(String(quote.id),h.acceptance,h.ctx))).rejects.toThrow();}finally{spy.mockRestore();}
  expect((await h.call(pp+"ParticipationEnd.find.byParticipation",{params:{participation:h.signers[0]!.id}})).revoked).toBe(true);
  expect((await run(h.quotes.inspect(String(quote.id),h.ctx))).end).toBeNull();
  const intent=await h.call(a+"AgreementAcceptance.find.byAcceptanceKey",{params:{acceptanceKey:"quote:"+quote.id}});
  await expect(h.call(a+"AgreementAcceptanceCommit.find.byAcceptance",{params:{acceptance:intent.id}})).rejects.toMatchObject({code:"NotFound"});
 }finally{await h.close();}
});
