import { Effect } from 'effect';
import { expect,it } from 'vitest';
import type { Wire } from '../src/decode.js';
import { foundation,foundationAdapters } from './helpers/foundation.js';
import { Billing } from '../src/foundation/billing.js';
import { AgreementCatalog } from '../src/foundation/agreement-catalog.js';
import { Decisions } from '../src/foundation/decision.js';
import { Usage } from '../src/foundation/usage.js';
import { Entitlements } from '../src/foundation/entitlement.js';
import { Fulfillments } from '../src/foundation/fulfillment.js';
import { findTerminalFact } from '../src/foundation/facts.js';
import { err } from '../src/errors.js';
import { Settlements,type SettlementAdmission } from '../src/foundation/settlement.js';
import { Ledger } from '../src/foundation/ledger.js';
import { Engine } from '../src/engine.js';
import { localAuthorizer } from '../src/gatekeeper.js';
const p='@forgegraph/foundation/billing/_/',a='@forgegraph/foundation/agreement-catalog/_/',sp='@forgegraph/foundation/specification/_/',pp='@forgegraph/foundation/participation/_/',ep='@forgegraph/foundation/entitlement/_/',lp='@forgegraph/foundation/ledger/_/',qp='@forgegraph/foundation/quotation-pricing/_/',up='@forgegraph/foundation/usage/_/',st='@forgegraph/foundation/settlement/_/';
const run=Effect.runPromise,from='2026-02-01T00:00:00Z',until='2026-03-01T00:00:00Z',at='2026-02-15T00:00:00Z';
for(const adapter of foundationAdapters)it(`${adapter}: exact billing, immutable snapshots, credits and independent financial records`,async()=>{
 const h=await foundation('billing',adapter,true);
 try{
 const {engine,ctx,call}=h,catalog=new AgreementCatalog(engine),decisions=new Decisions(engine),service=new Billing(engine);
  const repo=await call(sp+"Repository.create",{key:"pricing",provider:"git",locator:"https://example.test/pricing"}),terms=await call(sp+"SpecificationPin.create",{repository:repo.id,anchor:"terms",revision:"a".repeat(40)});
  const supplier=await call("@forgegraph/foundation/party/_/Party.create",{label:"Supplier"}),buyer=await call("@forgegraph/foundation/party/_/Party.create",{label:"Buyer"});
  const set=await call(pp+"ParticipationSet.create",{label:"Signers"}),role=await call(pp+"ParticipationRole.create",{namespace:"quotes",name:"signer"}),signers=[];
  for(const party of [supplier,buyer])signers.push(await call(pp+"Participation.create",{participationSet:set.id,participant:party.id,role:role.id,validFrom:"2025-01-01T00:00:00Z",validUntil:null,reason:"Signer",recordedBy:ctx.actor}));
  const cat=await call(a+"Catalog.create",{key:"services",label:"Services"}),entry=await call(a+"CatalogEntry.create",{catalog:cat.id,key:"service",specification:terms.id}),scope=await call("@forgegraph/foundation/entitlement/_/EntitlementScope.create",{label:"Service"});
  const requirement=await call(ep+"RequirementDefinition.create",{namespace:"billing",name:"payment"});
  const offer=await run(catalog.publish({entry:String(entry.id),supplier:String(supplier.id),terms:String(terms.id),scope:String(scope.id),requirement:String(requirement.id),validFrom:"2025-01-01T00:00:00Z",validUntil:"2027-01-01T00:00:00Z"},ctx));
  const approval=await run(decisions.open({participationSet:String(set.id),electors:signers.map(s=>String(s.id)),eligibilityAt:"2026-01-01T00:00:00Z",rule:"Unanimous",options:["Accept","Reject"],deadline:"2027-01-01T00:00:00Z"},ctx)),options=(await run(decisions.state(String(approval.id),ctx))).options;
  await run(catalog.select(String(offer.id),String(approval.id),String(options[0]!.id),ctx));for(const signer of signers)await run(decisions.respond(String(approval.id),String(signer.id),[0],ctx));await run(decisions.finalize(String(approval.id),ctx));
  const acceptance={supplierParticipation:String(signers[0]!.id),customerParticipation:String(signers[1]!.id),decisionCase:String(approval.id),approvedOption:String(options[0]!.id),validFrom:"2026-02-01T00:00:00Z",validUntil:"2026-12-01T00:00:00Z"};
 const accepted=await run(catalog.accept({...acceptance,acceptanceKey:'billing',offer:String(offer.id),customer:String(buyer.id),expectedTerms:String(terms.id)},ctx));await run(catalog.issue(String(accepted.id),ctx));
 const period=await call(p+'BillingPeriod.create',{agreement:accepted.id,terms:terms.id,from,until});
 const book=await call(lp+'LedgerBook.create',{key:'billing'}),account=await call(lp+'Account.create',{book:book.id,key:'receivable',unit:'USD'}),cash=await call(lp+'Account.create',{book:book.id,key:'cash',unit:'USD'});
 const rate=await call(qp+'PricingRate.create',{key:'rate',definition:terms.id,account:account.id,unitPrice:'2.500000',validFrom:from,validUntil:until});
 const dimension=await call(up+'UsageDimension.create',{key:'minutes',unit:'minute'}),stream=await call(up+'UsageStream.create',{label:'Telecom',dimension:dimension.id}),source=await call(up+'UsageSource.create',{key:'meter'}),meter=await call(p+'BillingMeterRate.create',{rate:rate.id,dimension:dimension.id});
 const event=await run(new Usage(engine).ingest({stream:String(stream.id),dimension:String(dimension.id),source:String(source.id),unit:'minute',quantity:'4',ordinal:1,eventKey:'reading-1',occurredAt:at},ctx));
 const base={period:String(period.id),ratedAt:at,source:'agreement:service',rate:String(rate.id)};
 const usage=await run(service.rate({...base,kind:'usage',sourceKey:'usage-1',usageEvent:String(event.id),meter:String(meter.id)},ctx));
 const recurring=await run(service.rate({...base,kind:'recurring',sourceKey:'subscription',quantity:'8'},ctx));
 const oneOff=await run(service.rate({...base,kind:'oneOff',sourceKey:'service',quantity:'2'},ctx));
 await expect(run(service.rate({...base,kind:'recurring',sourceKey:'duplicate-subscription',quantity:'8'},ctx))).rejects.toThrow();
 expect(usage.amount).toBe('10.000000');expect(recurring.amount).toBe('20.000000');expect(oneOff.amount).toBe('5.000000');
 await expect(run(service.rate({...base,kind:'usage',sourceKey:'usage-duplicate',usageEvent:String(event.id),meter:String(meter.id)},ctx))).rejects.toThrow();
 await expect(run(service.rate({...base,kind:'oneOff',sourceKey:'rounding',quantity:'0.000001'},ctx))).rejects.toThrow();
 const bill=await run(service.draft({key:'invoice-1',period:String(period.id),charges:[String(usage.id),String(recurring.id),String(oneOff.id)],reason:'Monthly invoice'},ctx));
 const issue=await run(service.issue(String(bill.id),ctx));
 for(const [profile,extra] of [['SaaSInvoice',{invoiceNumber:'INV-1'}],['UtilityInvoice',{servicePoint:'meter-1'}],['ServiceInvoice',{engagement:'consulting-1'}]] as const)await call('@fixture/billing-consumer/_/'+profile+'.create',{issue:issue.id,...extra});
 expect((await run(service.inspect(String(bill.id),ctx))).totals).toEqual({USD:'35.000000'});
 expect((await run(new Ledger(engine).balance(String(account.id),ctx))).quantity).toBe('0.000000');
 const duplicate=await run(service.draft({key:'duplicate',period:String(period.id),charges:[String(usage.id)],reason:'Duplicate'} ,ctx));
 await expect(run(service.issue(String(duplicate.id),ctx))).rejects.toThrow();
 expect((await run(service.inspect(String(duplicate.id),ctx))).issue).toBeNull();
 const adjustment=await call(qp+'PriceAdjustment.create',{key:'credit',definition:terms.id,account:account.id,amount:'-5',reason:'Proration'});
 const credit=await run(service.rate({period:String(period.id),ratedAt:at,source:'proration:policy',sourceKey:'credit',kind:'adjustment',adjustment:String(adjustment.id),adjustmentFor:String(recurring.id)},ctx));
 await call('@fixture/billing-consumer/_/BillingProration.create',{charge:credit.id,numeratorDays:7,denominatorDays:28,calculation:terms.id});
 const correction=await run(service.draft({key:'credit-note',period:String(period.id),charges:[String(credit.id)],corrects:String(bill.id),reason:'Prorated correction'},ctx));await run(service.issue(String(correction.id),ctx));
 expect((await run(service.inspect(String(correction.id),ctx))).totals).toEqual({USD:'-5.000000'});
 await run(new Usage(engine).retract(String(event.id),'Late correction requires separate credit',ctx));
 expect((await run(service.inspect(String(bill.id),ctx))).totals).toEqual({USD:'35.000000'});
 const tax=await call(qp+'PriceAdjustment.create',{key:'tax',definition:terms.id,account:account.id,amount:'1',reason:'Domain tax calculation'});
 const taxCharge=await run(service.rate({period:String(period.id),ratedAt:at,source:'tax:policy',sourceKey:'tax',kind:'adjustment',adjustment:String(tax.id),adjustmentFor:String(oneOff.id)},ctx));
 await call('@fixture/billing-consumer/_/BillingTaxDetail.create',{charge:taxCharge.id,jurisdiction:'test-domain',calculation:terms.id});
 // Positions derive from obligations, not from the invoice's displayed total.
 const settlementBook=await call(st+'SettlementBook.create',{key:'billing'}),settlements=new Settlements(engine),positions:Wire[]=[];
 for(const quantity of ['10','25']){
  const obligation=await run(new Entitlements(engine).recordObligation({obligatedParty:String(buyer.id),requirement:String(requirement.id),scope:String(scope.id),quantity,unit:'USD',incurredAt:at,dueAt:until,reason:'Earned service'},ctx));
  const position=await run(settlements.openPosition({book:String(settlementBook.id),obligation:String(obligation.id),creditor:String(supplier.id),agreement:String(accepted.id),reason:'Financial position'},ctx));positions.push(position);
  await call(p+'BillPosition.create',{bill:bill.id,issue:issue.id,period:period.id,agreement:accepted.id,position:position.id});
 }
 expect((await run(service.positions(String(bill.id),until,ctx)))).toHaveLength(2);
 for(const position of await run(service.positions(String(bill.id),until,ctx)))expect(position.materialized).toBe('0.000000');
 const posting=await run(new Ledger(engine).post({book:String(book.id),key:'separate-ledger',policy:'balanced',entries:[{account:String(account.id),quantity:'35'},{account:String(cash.id),quantity:'-35'}],reason:'Separate recognized posting'},ctx));expect(posting.id).toBeTruthy();
 expect((await run(new Ledger(engine).balance(String(account.id),ctx))).quantity).toBe('35.000000');
 expect((await run(service.positions(String(bill.id),until,ctx)))[0]!.settled).toBe('0.000000');
 const admission:SettlementAdmission=(source,allocations,context)=>Effect.gen(function*(){
  const fact=yield* findTerminalFact(engine,'@fixture/billing-consumer/_/BillingEconomicEvent','fulfillmentEnd',source.fulfillmentEnd,context);
  if(!fact||['kind','unit','quantity','occurredAt'].some(k=>source[k]!==fact[k])||allocations.some(x=>x.position.agreement!==fact.agreement))return yield* Effect.fail(err('ValidationFailed','Source does not match independently observed economic event'));
 });
 const finance=new Settlements(engine,admission),projection=new Billing(engine,admission);
 engine.testClockJump(50*24*60*60*1000);
 const fp='@forgegraph/foundation/fulfillment/_/',deliverySet=await call(fp+'FulfillmentSet.create',{label:'Observed service/payment'}),executor=await call(fp+'FulfillmentExecutor.create',{key:'observer'});
 for(const [ordinal,kind] of [[1,'Materialize'],[2,'Settle']] as const){
  const execution=await call(fp+'Fulfillment.create',{fulfillmentSet:deliverySet.id,ordinal,executor:executor.id,specificationPin:terms.id,requestedAt:at,evidence:null});
  const helper=new Fulfillments(engine);await run(helper.start(String(execution.id),at,ctx));const end=await run(helper.finish(String(execution.id),'completed','complete',at,'Observed',ctx));
  await call('@fixture/billing-consumer/_/BillingEconomicEvent.create',{fulfillmentEnd:end.id,agreement:accepted.id,kind,unit:'USD',quantity:'35',occurredAt:at});
  const src=await run(finance.admitSource({book:String(settlementBook.id),key:kind,kind,unit:'USD',quantity:'35',occurredAt:at,fulfillmentEnd:String(end.id),reason:'Independent event'},ctx));
  const command={book:String(settlementBook.id),key:kind,source:String(src.id),occurredAt:at,effectiveAt:at,reason:kind,lines:positions.map((position,i)=>({position:String(position.id),quantity:i===0?'10':'25'}))};
  const commit=await run(kind==='Materialize'?finance.materialize(command,ctx):finance.settle(command,ctx));
  if(kind==='Settle')await run(finance.linkLedger(String(commit.id),String(posting.id),'Associated independently validated posting',ctx));
 }
 for(const position of await run(projection.positions(String(bill.id),until,ctx)))expect(position.remaining).toBe('0.000000');
 const raceBills=[];for(const key of ['tax-a','tax-b'])raceBills.push(await run(service.draft({key,period:String(period.id),charges:[String(taxCharge.id)],reason:'Tax statement'},ctx)));
 const race=await Promise.allSettled(raceBills.map(bill=>run(service.issue(String(bill.id),ctx))));expect(race.filter(r=>r.status==='fulfilled')).toHaveLength(1);

 await expect(call(p+'Bill.delete',{id:bill.id})).rejects.toThrow();await expect(call(p+'BillingCharge.update',{id:usage.id,amount:'1'})).rejects.toThrow();
 await expect(run(service.inspect(String(bill.id),{...ctx,tenant:'foreign'}))).rejects.toThrow();
 const hidden=new Engine(engine.model,engine.layer);hidden.gatekeeper.authorizer=localAuthorizer({policies:engine.model.resources.filter(r=>r.id!==p+'BilledCharge').map(r=>({id:r.id,actions:[r.id+'.*'],requires:[],where:[]})),pips:[],epoch:2,knownObligations:[]});
 await expect(run(new Billing(hidden).inspect(String(bill.id),ctx))).rejects.toThrow();
 }finally{await h.close();}
});
