import { Effect } from "effect";
import { expect,it } from "vitest";
import { foundation,foundationAdapters } from "./helpers/foundation.js";
import { Settlements,type SettlementAdmission } from "../src/foundation/settlement.js";
import { Entitlements } from "../src/foundation/entitlement.js";
import { Fulfillments } from "../src/foundation/fulfillment.js";
import { Ledger } from "../src/foundation/ledger.js";
import { AgreementCatalog } from "../src/foundation/agreement-catalog.js";
import { Decisions } from "../src/foundation/decision.js";
import { Participations } from "../src/foundation/participation.js";
import { findTerminalFact } from "../src/foundation/facts.js";
import { Engine } from "../src/engine.js";
import { localAuthorizer } from "../src/gatekeeper.js";
import { err } from "../src/errors.js";
import { Clock,Storage } from "../src/services.js";
const p="@forgegraph/foundation/settlement/_/",e="@forgegraph/foundation/entitlement/_/",f="@forgegraph/foundation/fulfillment/_/",a="@forgegraph/foundation/agreement-catalog/_/",s="@forgegraph/foundation/specification/_/",c="@fixture/settlement-consumer/_/",l="@forgegraph/foundation/ledger/_/";
const run=Effect.runPromise,at="2026-01-01T00:00:00.000Z",future="2026-02-01T00:00:00.000Z";
async function setup(adapter:string,unit="USD"){
 const fixture=await foundation("settlement",adapter,true),{engine,ctx,call}=fixture;
 const creditor=await call("@forgegraph/foundation/party/_/Party.create",{label:"Creditor"}),debtor=await call("@forgegraph/foundation/party/_/Party.create",{label:"Debtor"});
 const scope=await call(e+"EntitlementScope.create",{label:"Reciprocal exchange"}),requirement=await call(e+"RequirementDefinition.create",{namespace:"settlement",name:"perform"});
 const book=await call(p+"SettlementBook.create",{key:"book"});
 const admissionFor=(eng:Engine):SettlementAdmission=>(source,positions,context,_effectiveAt,knownAt)=>Effect.gen(function*(){
  const occurrence=yield* findTerminalFact(eng,c+"EconomicOccurrence","fulfillmentEnd",source.fulfillmentEnd,context);
  if(!occurrence||knownAt&&String(occurrence.createdAt)>knownAt||["kind","unit","quantity","occurredAt"].some(field=>source[field]!==occurrence[field]))return yield* Effect.fail(err("ValidationFailed","Source differs from typed economic occurrence"));
  for(const {position} of positions){const obligation=yield* eng.call(e+"Obligation.get",{id:position.obligation},context);if(position.creditor!==occurrence.creditor||position.debtor!==occurrence.debtor||obligation.scope!==occurrence.scope)return yield* Effect.fail(err("ValidationFailed","Occurrence does not admit this obligation"));}
 });
 const api=new Settlements(engine,admissionFor(engine));let counter=0;
 async function position(quantity="100.000000",agreement?:string,incurredAt=at){
  const obligation=await run(new Entitlements(engine).recordObligation({obligatedParty:String(debtor.id),requirement:String(requirement.id),scope:String(scope.id),quantity,unit,incurredAt,dueAt:future,reason:"Reciprocal obligation"},ctx));
  return api.openPosition({book:String(book.id),obligation:String(obligation.id),creditor:String(creditor.id),...(agreement?{agreement}:{}),reason:"Earned performance becomes due"},ctx).pipe(Effect.runPromise);
 }
 const set=await call(f+"FulfillmentSet.create",{label:"Observed occurrences"}),executor=await call(f+"FulfillmentExecutor.create",{key:"domain-observer"});
 async function source(kind:"Materialize"|"Settle",quantity:string,occurredAt=at){
  const ordinal=++counter,fulfillment=await call(f+"Fulfillment.create",{fulfillmentSet:set.id,ordinal,executor:executor.id,requestedAt:at});
  const helper=new Fulfillments(engine);await run(helper.start(String(fulfillment.id),at,ctx));
  const end=await run(helper.finish(String(fulfillment.id),"completed","partial",occurredAt,"Observed domain performance",ctx));
  await call(c+"EconomicOccurrence.create",{fulfillmentEnd:end.id,kind,creditor:creditor.id,debtor:debtor.id,scope:scope.id,unit,quantity,occurredAt});
  return run(api.admitSource({book:String(book.id),key:"source-"+ordinal,kind,unit,quantity,occurredAt,fulfillmentEnd:String(end.id),reason:"Reviewed native event"},ctx));
 }
 async function command(kind:"Materialize"|"Settle",lines:{position:string;quantity:string}[],key:string,effectiveAt=at){
  const quantity=lines.reduce((n,line)=>n+BigInt(line.quantity.replace('.','')),0n);const amount=(quantity/1000000n)+'.'+(quantity%1000000n).toString().padStart(6,'0');
  const observed=await source(kind,amount);const input={book:String(book.id),source:String(observed.id),key,occurredAt:at,effectiveAt,reason:key,lines};
  return {input,commit:await run(kind==="Materialize"?api.materialize(input,ctx):api.settle(input,ctx))};
 }
 return {...fixture,api,admissionFor,creditor,debtor,scope,requirement,book,position,source,command};
}
for(const adapter of foundationAdapters){
 for(const [unit,domain,field]of [["USD","CommerceReceivable","orderNumber"],["USD","ExpenseReimbursement","expenseNumber"],["SERVICE_MINUTES","ServiceCredit","serviceKey"]])
 it(`${adapter}: ${domain} partial materialization and settlement retain neutral temporal positions`,async()=>{
   const x=await setup(adapter,unit);try{
    const position=await x.position(),id=String(position.id);await x.call(c+domain+".create",{[field!]:"native",position:id});await x.call(c+"InvoiceRepresentation.create",{invoiceNumber:"copy",position:id});
    await x.command("Materialize",[{position:id,quantity:"40.000000"}],"delivery-1");
    await x.command("Settle",[{position:id,quantity:"15.000000"}],"payment-1");
    const known=await run(Effect.gen(function*(){return(yield* Clock).now();}).pipe(Effect.provide(x.engine.layer)));
    x.engine.testClockJump(1000);
    await x.command("Materialize",[{position:id,quantity:"60.000000"}],"delivery-2");
    const final=await x.command("Settle",[{position:id,quantity:"85.000000"}],"payment-2");
    expect(await run(x.api.inspect(id,{asOf:at,knownAt:known,party:String(x.creditor.id)},x.ctx))).toMatchObject({materialized:"40.000000",settled:"15.000000",remaining:"25.000000",perspective:"receivable"});
    expect(await run(x.api.inspect(id,{asOf:future,party:String(x.debtor.id)},x.ctx))).toMatchObject({remaining:"0.000000",perspective:"payable",overdue:false});
    expect(await run(x.api.settle(final.input,x.ctx))).toEqual(final.commit);
    await expect(run(x.api.settle({...final.input,reason:"changed"},x.ctx))).rejects.toMatchObject({code:"IdempotencyMismatch"});
    await expect(run(x.api.inspect(id,{asOf:at,knownAt:"2025-01-01T00:00:00Z"},x.ctx))).rejects.toMatchObject({code:"NotFound"});
    const restarted=new Settlements(new Engine(x.engine.model,x.engine.layer),x.admissionFor(x.engine));expect(await run(restarted.inspect(id,{asOf:future},x.ctx))).toMatchObject({remaining:"0.000000"});
   }finally{await x.close();}
 });
 it(`${adapter}: one source atomically settles multiple positions and cannot be overspent or reused`,async()=>{
  const x=await setup(adapter);try{
   const first=await x.position(),second=await x.position(),ids=[String(first.id),String(second.id)];
   await x.command("Materialize",ids.map(position=>({position,quantity:"100.000000"})),"earned");
   const src=await x.source("Settle","150.000000"),base={book:String(x.book.id),source:String(src.id),key:"payment",occurredAt:at,effectiveAt:at,reason:"one payment",lines:ids.map(position=>({position,quantity:"75.000000"}))};
   const races=await Promise.allSettled([run(x.api.settle(base,x.ctx)),run(x.api.settle(base,x.ctx))]);expect(races.some(r=>r.status==="fulfilled")).toBe(true);
   await run(x.api.settle(base,x.ctx));for(const id of ids)expect(await run(x.api.inspect(id,{asOf:at},x.ctx))).toMatchObject({remaining:"25.000000"});
   await expect(run(x.api.settle({...base,key:"reused-source"},x.ctx))).rejects.toThrow();
   await expect(run(x.api.admitSource({book:String(x.book.id),key:"different-key",kind:"Settle",unit:"USD",quantity:"150.000000",occurredAt:at,fulfillmentEnd:String(src.fulfillmentEnd),reason:"same native payment"},x.ctx))).rejects.toThrow();
   const over=await x.source("Settle","60.000000");await expect(run(x.api.settle({...base,key:"over",source:String(over.id),lines:ids.map(position=>({position,quantity:"30.000000"}))},x.ctx))).rejects.toMatchObject({detail:"Settlement would overdraw a temporal position balance"});
   for(const id of ids)expect(await run(x.api.inspect(id,{asOf:at},x.ctx))).toMatchObject({remaining:"25.000000"});
   const one=await x.source("Settle","20.000000"),two=await x.source("Settle","20.000000");
   const competing=await Promise.allSettled([one,two].map((source,i)=>run(x.api.settle({...base,key:"race-"+i,source:String(source.id),lines:[{position:ids[0]!,quantity:"20.000000"}]},x.ctx))));expect(competing.filter(r=>r.status==="fulfilled")).toHaveLength(1);
   expect(await run(x.api.inspect(ids[0]!,{asOf:at},x.ctx))).toMatchObject({remaining:"5.000000"});
  }finally{await x.close();}
 });
 it(`${adapter}: immutable reversals corrections and effective-time prefixes preserve explainable history`,async()=>{
  const x=await setup(adapter);try{
   const position=await x.position(),id=String(position.id),earned=await x.command("Materialize",[{position:id,quantity:"100.000000"}],"earned",future);
   await expect(x.command("Settle",[{position:id,quantity:"1.000000"}],"too-early",at)).rejects.toThrow();
   const paid=await x.command("Settle",[{position:id,quantity:"30.000000"}],"paid",future);
   await expect(run(x.api.reverse(String(x.book.id),String(earned.commit.id),{key:"unearn",occurredAt:at,effectiveAt:future,reason:"would overdraw"},x.ctx))).rejects.toThrow();
   const reversal=await run(x.api.reverse(String(x.book.id),String(paid.commit.id),{key:"undo-payment",occurredAt:at,effectiveAt:future,reason:"Correction"},x.ctx));
   expect(await run(x.api.inspect(id,{asOf:future},x.ctx))).toMatchObject({remaining:"100.000000",settled:"0.000000"});
   await expect(run(x.api.reverse(String(x.book.id),String(paid.commit.id),{key:"twice",occurredAt:at,effectiveAt:future,reason:"Repeated"},x.ctx))).rejects.toThrow();
   await expect(run(x.api.reverse(String(x.book.id),String(reversal.id),{key:"nested",occurredAt:at,effectiveAt:future,reason:"Nested"},x.ctx))).rejects.toThrow();
   await x.command("Settle",[{position:id,quantity:"25.000000"}],"corrected",future);
   expect(await run(x.api.inspect(id,{asOf:at},x.ctx))).toMatchObject({remaining:"0.000000"});expect(await run(x.api.inspect(id,{asOf:future},x.ctx))).toMatchObject({remaining:"75.000000",overdue:true});
   await expect(x.call(p+"SettlementCommit.update",{id:reversal.id,patch:{key:"rewrite"}})).rejects.toThrow();
  }finally{await x.close();}
 });
 it(`${adapter}: trusted source admission authorization isolation and failed publication never mint balances`,async()=>{
  const x=await setup(adapter);try{
   const position=await x.position(),id=String(position.id),source=await x.source("Materialize","10.000000");
   const input={book:String(x.book.id),source:String(source.id),key:"earned",occurredAt:at,effectiveAt:at,reason:"earned",lines:[{position:id,quantity:"10.000000"}]};
   await expect(run(new Settlements(x.engine).materialize(input,x.ctx))).rejects.toMatchObject({detail:"Trusted typed source admission is required"});
   await expect(run(x.api.materialize({...input,lines:[{position:id,quantity:"9.000000"}]},x.ctx))).rejects.toMatchObject({detail:"Event allocations must exactly consume source quantity"});
   const guarded=new Engine(x.engine.model,x.engine.layer);guarded.gatekeeper.authorizer=localAuthorizer({policies:x.engine.model.resources.map(r=>({id:r.id,actions:[r.id+(r.id===p+"SettlementCommit"?".get":".*")],requires:[],where:[]})),pips:[],epoch:1,knownObligations:[]});
   await expect(run(new Settlements(guarded,x.admissionFor(guarded)).materialize(input,x.ctx))).rejects.toThrow();expect(await run(x.api.inspect(id,{asOf:at},x.ctx))).toMatchObject({remaining:"0.000000"});
   const stagedAt=await run(Effect.gen(function*(){return(yield* Clock).now();}).pipe(Effect.provide(x.engine.layer)));x.engine.testClockJump(1000);
   await run(x.api.materialize(input,x.ctx));
   expect(await run(x.api.inspect(id,{asOf:at,knownAt:stagedAt},x.ctx))).toMatchObject({remaining:"0.000000"});
   await expect(run(x.api.inspect(id,{asOf:at},{...x.ctx,tenant:"other"}))).rejects.toThrow();
   const hidden=new Engine(x.engine.model,x.engine.layer);hidden.gatekeeper.authorizer=localAuthorizer({policies:x.engine.model.resources.filter(r=>r.id!==c+"EconomicOccurrence").map(r=>({id:r.id,actions:[r.id+".*"],requires:[],where:[]})),pips:[],epoch:2,knownObligations:[]});
   await expect(run(new Settlements(hidden,x.admissionFor(hidden)).inspect(id,{asOf:at},x.ctx))).rejects.toThrow();
   await expect(run(new Settlements(x.engine).inspect(id,{asOf:at},x.ctx))).rejects.toThrow();
  }finally{await x.close();}
 });
 it(`${adapter}: issued Agreement authority and independent exact Ledger association remain explicit`,async()=>{
  const x=await setup(adapter);try{
   const catalog=new AgreementCatalog(x.engine),decisions=new Decisions(x.engine),members=new Participations(x.engine,{namespace:"settlement-agreement",roles:["signer"]});
   const repository=await x.call(s+"Repository.create",{key:"terms",provider:"git",locator:"https://example.test/terms"}),pin=await x.call(s+"SpecificationPin.create",{repository:repository.id,anchor:"contract",revision:"a".repeat(40)});
   const book=await x.call(a+"Catalog.create",{key:"services",label:"Services"}),entry=await x.call(a+"CatalogEntry.create",{catalog:book.id,key:"service",specification:pin.id});
   const offer=await run(catalog.publish({entry:String(entry.id),supplier:String(x.creditor.id),terms:String(pin.id),scope:String(x.scope.id),requirement:String(x.requirement.id),validFrom:at,validUntil:"2027-01-01T00:00:00Z"},x.ctx));
   const set=await x.call("@forgegraph/foundation/participation/_/ParticipationSet.create",{label:"Signers"});await run(members.registerRole("signer",x.ctx));
   const signers=[];for(const party of [x.creditor,x.debtor])signers.push(await run(members.add({participationSet:String(set.id),participant:String(party.id),role:"signer",validFrom:at,reason:"Authorized signer"},x.ctx)));
   const decision=await run(decisions.open({participationSet:String(set.id),electors:signers.map(r=>String(r.id)),eligibilityAt:at,rule:"Unanimous",options:["Accept","Reject"],deadline:"2027-01-01T00:00:00Z"},x.ctx));
   const option=(await run(decisions.state(String(decision.id),x.ctx))).options[0]!;await run(catalog.select(String(offer.id),String(decision.id),String(option.id),x.ctx));
   for(const signer of signers)await run(decisions.respond(String(decision.id),String(signer.id),[0],x.ctx));await run(decisions.finalize(String(decision.id),x.ctx));
   const activeAt="2026-01-02T00:00:00.000Z",agreement=await run(catalog.accept({acceptanceKey:"contract",offer:String(offer.id),customer:String(x.debtor.id),supplierParticipation:String(signers[0]!.id),customerParticipation:String(signers[1]!.id),decisionCase:String(decision.id),approvedOption:String(option.id),expectedTerms:String(pin.id),validFrom:activeAt,validUntil:"2026-12-01T00:00:00Z"},x.ctx));
   await run(catalog.issue(String(agreement.id),x.ctx));x.engine.testClockJump(86400000);
   const position=await x.position("50.000000",String(agreement.id),activeAt),id=String(position.id),source=await x.source("Materialize","50.000000",activeAt);
   const seal=await run(x.api.materialize({book:String(x.book.id),source:String(source.id),key:"contract-performance",occurredAt:activeAt,effectiveAt:activeAt,reason:"Earned contractual due",lines:[{position:id,quantity:"50.000000"}]},x.ctx));
   const ledgerBook=await x.call(l+"LedgerBook.create",{key:"accounting"}),debit=await x.call(l+"Account.create",{book:ledgerBook.id,key:"receivable",unit:"USD"}),credit=await x.call(l+"Account.create",{book:ledgerBook.id,key:"earned",unit:"USD"});
   const ledger=new Ledger(x.engine),posting=await run(ledger.post({book:String(ledgerBook.id),key:"earned",policy:"balanced",reason:"Independent accounting",entries:[{account:String(debit.id),quantity:"50.000000"},{account:String(credit.id),quantity:"-50.000000"}]},x.ctx));
   const link=await run(x.api.linkLedger(String(seal.id),String(posting.id),"Accounting representation",x.ctx));expect(await run(x.api.linkLedger(String(seal.id),String(posting.id),"Accounting representation",x.ctx))).toEqual(link);
   expect(await run(x.api.inspect(id,{asOf:activeAt},x.ctx))).toMatchObject({remaining:"50.000000"});
   await run(ledger.reverse(String(ledgerBook.id),String(posting.id),"accounting-correction","Independent reversal",x.ctx));expect(await run(x.api.inspect(id,{asOf:activeAt},x.ctx))).toMatchObject({remaining:"50.000000"});
   // Historical arithmetic is never silently changed when current upstream authority
   // becomes unreadable. The bounded helper fails closed and raw facts remain.
   const denied=new Engine(x.engine.model,x.engine.layer);denied.gatekeeper.authorizer=localAuthorizer({policies:x.engine.model.resources.filter(r=>r.id!==a+"AgreementIssued").map(r=>({id:r.id,actions:[r.id+".*"],requires:[],where:[]})),pips:[],epoch:3,knownObligations:[]});
   await expect(run(new Settlements(denied,x.admissionFor(denied)).inspect(id,{asOf:activeAt,knownAt:String(seal.createdAt)},x.ctx))).rejects.toThrow();
   expect(await x.call(p+"SettlementCommit.get",{id:seal.id})).toMatchObject({key:"contract-performance"});
  }finally{await x.close();}
 });
 it(`${adapter}: obligation terminal races and unadmitted raw publications fail closed`,async()=>{
  const x=await setup(adapter);try{
   const position=await x.position(),id=String(position.id),source=await x.source("Materialize","10.000000"),input={book:String(x.book.id),source:String(source.id),key:"raced",occurredAt:at,effectiveAt:at,reason:"raced",lines:[{position:id,quantity:"10.000000"}]};
   const storage=await run(Effect.gen(function*(){return yield* Storage;}).pipe(Effect.provide(x.engine.layer))),original=storage.commitAll.bind(storage);let injected=false;
   storage.commitAll=(plans,options)=>Effect.gen(function*(){if(!injected){injected=true;yield* x.engine.call(e+"ObligationEnd.create",{obligation:position.obligation,kind:"Cancelled",effectiveAt:at,reason:"Concurrent cancellation",recordedBy:x.ctx.actor},x.ctx);}return yield* original(plans,options);});
   try{await expect(run(x.api.materialize(input,x.ctx))).rejects.toThrow();}finally{storage.commitAll=original;}
   expect(await run(x.api.inspect(id,{asOf:at},x.ctx))).toMatchObject({remaining:"0.000000"});
   const line=await x.call(p+"SettlementLine.create",{book:x.book.id,position:id,quantity:"10.000000"}),event=await x.call(p+"SettlementEvent.create",{book:x.book.id,key:"raw",kind:"Materialize",head:line.id,source:source.id,occurredAt:at,effectiveAt:at,reason:"Bypass helper"});
   await x.call(p+"SettlementCommit.create",{book:x.book.id,key:"raw",event:event.id,source:source.id,ordinal:1});
   await expect(run(x.api.inspect(id,{asOf:at},x.ctx))).rejects.toMatchObject({detail:"Obligation is not outstanding at event effective/knowledge time"});
  }finally{await x.close();}
 });
 it(`${adapter}: late domain proof cannot confer authority on an earlier raw publication`,async()=>{
  const x=await setup(adapter);try{
   const position=await x.position(),set=await x.call(f+"FulfillmentSet.create",{label:"Unadmitted"}),executor=await x.call(f+"FulfillmentExecutor.create",{key:"unadmitted"});
   const fulfillment=await x.call(f+"Fulfillment.create",{fulfillmentSet:set.id,ordinal:1,executor:executor.id,requestedAt:at});
   const fulfillmentApi=new Fulfillments(x.engine);await run(fulfillmentApi.start(String(fulfillment.id),at,x.ctx));const end=await run(fulfillmentApi.finish(String(fulfillment.id),"completed","complete",at,"Native event",x.ctx));
   const source=await x.call(p+"SettlementSource.create",{book:x.book.id,key:"raw",kind:"Materialize",unit:"USD",quantity:"10.000000",occurredAt:at,fulfillmentEnd:end.id,reason:"No admitted proof"});
   const line=await x.call(p+"SettlementLine.create",{book:x.book.id,position:position.id,quantity:"10.000000"}),event=await x.call(p+"SettlementEvent.create",{book:x.book.id,key:"raw",kind:"Materialize",head:line.id,source:source.id,occurredAt:at,effectiveAt:at,reason:"Unadmitted"});
   const seal=await x.call(p+"SettlementCommit.create",{book:x.book.id,key:"raw",event:event.id,source:source.id,ordinal:1});
   await expect(run(x.api.inspect(String(position.id),{asOf:at},x.ctx))).rejects.toMatchObject({detail:"Source differs from typed economic occurrence"});
   x.engine.testClockJump(1000);await x.call(c+"EconomicOccurrence.create",{fulfillmentEnd:end.id,kind:"Materialize",creditor:x.creditor.id,debtor:x.debtor.id,scope:x.scope.id,unit:"USD",quantity:"10.000000",occurredAt:at});
   await expect(run(x.api.inspect(String(position.id),{asOf:at},x.ctx))).rejects.toMatchObject({detail:"Source differs from typed economic occurrence"});
   expect(await x.call(p+"SettlementCommit.get",{id:seal.id})).toMatchObject({key:"raw"});
  }finally{await x.close();}
 });
}
