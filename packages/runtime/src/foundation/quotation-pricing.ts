import { Evaluations } from "./evaluation.js";
import { Effect } from "effect";
import type { Engine, CallContext } from "../engine.js";
import { sha256, stableJson } from "../engine.js";
import type { Wire } from "../decode.js";
import { err, type ForgeError } from "../errors.js";
import { Clock } from "../services.js";
import { decodeDatetime, decodeDecimal, formatMinor, toMinor } from "../codecs.js";
import { AgreementCatalog, type AcceptAgreement } from "./agreement-catalog.js";
import { findTerminalFact } from "./facts.js";
import { Decisions } from "./decision.js";
import { Evidence } from "./evidence.js";
const p="@forgegraph/foundation/quotation-pricing/_/",a="@forgegraph/foundation/agreement-catalog/_/",sp="@forgegraph/foundation/specification/_/",ep="@forgegraph/foundation/evaluation/_/",lp="@forgegraph/foundation/ledger/_/";
const bad=(detail:string)=>Effect.fail(err("ValidationFailed",detail));
export interface QuoteInput {key:string;offer:string;buyer:string;terms:string;pricedAt:string;expiresAt:string;lines:readonly {rate:string;quantity:string;adjustment?:string}[];evaluation?:string;previous?:string}
export type QuoteAgreementInput=Omit<AcceptAgreement,"acceptanceKey"|"offer"|"customer"|"expectedTerms"|"predecessor"|"change">;
/** Six-decimal exact fixed rates plus signed fixed adjustments. No floating point,
 * implicit FX, silent rounding, posting or settlement. Agreement issuance resumes. */
export class Quotations{
 constructor(private readonly engine:Engine){}
 private call(op:string,input:Wire,ctx:CallContext):Effect.Effect<Wire,ForgeError>{return this.engine.call(p+op,input,ctx);}
 private clean(ctx:CallContext){const{idempotencyKey:_receipt,...rest}=ctx;return rest;}
 private now(){return Effect.gen(function*(){return(yield* Clock).now();}).pipe(Effect.provide(this.engine.layer));}
 private price(quote:Wire,ctx:CallContext):Effect.Effect<{lines:Wire[];totals:Record<string,string>},ForgeError>{const self=this;return Effect.gen(function*(){
  const offer=yield* self.engine.call(a+"Offer.get",{id:quote.offer},ctx),entry=yield* self.engine.call(a+"CatalogEntry.get",{id:offer.entry},ctx);
  yield* self.engine.call(a+"Catalog.get",{id:entry.catalog},ctx);yield* self.engine.call(sp+"SpecificationPin.get",{id:entry.specification},ctx);
  yield* self.engine.call(sp+"SpecificationPin.get",{id:quote.terms},ctx);for(const id of [quote.buyer,offer.supplier])yield* self.engine.call("@forgegraph/foundation/party/_/Party.get",{id},ctx);
  if(quote.terms!==offer.terms||String(quote.pricedAt)<String(offer.validFrom)||String(quote.pricedAt)>=String(offer.validUntil)||String(quote.expiresAt)<=String(quote.pricedAt))return yield* bad("Quote offer or pricing interval mismatch");
  if(quote.evaluation!=null){const finish=yield* new Evaluations(self.engine).result(String(quote.evaluation),ctx),run=yield* self.engine.call(ep+"EvaluationRun.get",{id:finish.run},ctx);if(finish.outcome!=="Completed"||finish.start==null)return yield* bad("Pricing evaluation is incomplete");const start=yield* self.engine.call(ep+"EvaluationStart.get",{id:finish.start},ctx);if(start.run!==run.id||String(finish.finishedAt)<String(start.startedAt))return yield* bad("Invalid pricing evaluation chronology");yield* self.engine.call(ep+"EvaluationExecutor.get",{id:run.executor},ctx);yield* self.engine.call(sp+"SpecificationPin.get",{id:run.definition},ctx);if(finish.support!=null){const seal=yield* self.engine.call("@forgegraph/foundation/evidence/_/EvidenceSeal.get",{id:finish.support},ctx);yield* new Evidence(self.engine).sealedItems(String(seal.bundle),ctx);}}
  const lines:Wire[]=[],seen=new Set<string>(),totals=new Map<string,bigint>();let id=String(quote.head);
  while(id){if(lines.length>=128||seen.has(id))return yield* bad("Quote requires bounded acyclic lines");seen.add(id);const line=yield* self.call("QuoteLine.get",{id},ctx),rate=yield* self.call("PricingRate.get",{id:line.rate},ctx),account=yield* self.engine.call(lp+"Account.get",{id:rate.account},ctx);yield* self.engine.call(sp+"SpecificationPin.get",{id:rate.definition},ctx);
   if(String(quote.pricedAt)<String(rate.validFrom)||String(quote.pricedAt)>=String(rate.validUntil))return yield* bad("Rate outside its half-open effective interval");
   const quantity=toMinor(String(line.quantity),6),unitPrice=toMinor(String(rate.unitPrice),6),product=quantity*unitPrice;if(quantity<=0n||unitPrice<0n||product%1000000n!==0n)return yield* bad("Rate multiplication requires exact six-decimal result");let amount=product/1000000n;
   if(line.adjustment!=null){const adjustment=yield* self.call("PriceAdjustment.get",{id:line.adjustment},ctx),value=yield* self.engine.call(lp+"Account.get",{id:adjustment.account},ctx);yield* self.engine.call(sp+"SpecificationPin.get",{id:adjustment.definition},ctx);if(value.unit!==account.unit)return yield* bad("Adjustment unit differs from rate");amount+=toMinor(String(adjustment.amount),6);}
   if(amount<0n)return yield* bad("Adjusted quote line cannot be negative");totals.set(String(account.unit),(totals.get(String(account.unit))??0n)+amount);lines.push({...line,unit:account.unit,amount:formatMinor(amount,6)});id=line.next==null?"":String(line.next);
  }
  if(!lines.length)return yield* bad("Quote has no lines");return{lines,totals:Object.fromEntries([...totals].map(([unit,amount])=>[unit,formatMinor(amount,6)]))};
 });}
 publish(input:QuoteInput,ctx:CallContext):Effect.Effect<Wire,ForgeError>{const self=this;return Effect.gen(function*(){
  if(!input.lines.length||input.lines.length>128)return yield* bad("Quote requires 1..128 lines");let head:string|null=null;
  for(const line of [...input.lines].reverse()){const quantity=yield* Effect.try({try:()=>decodeDecimal(line.quantity,{scale:6,min:"0.000001"}),catch:()=>err("ValidationFailed","Invalid exact quantity")});const row:Wire=yield* self.call("QuoteLine.create",{rate:line.rate,quantity,adjustment:line.adjustment??null,next:head},self.clean(ctx));head=String(row.id);}
  const dates=yield* Effect.try({try:()=>({pricedAt:decodeDatetime(input.pricedAt),expiresAt:decodeDatetime(input.expiresAt)}),catch:()=>err("ValidationFailed","Invalid quote timestamps")});
  const body={key:input.key,offer:input.offer,buyer:input.buyer,terms:input.terms,...dates,head,evaluation:input.evaluation??null,previous:input.previous??null};yield* self.price(body,ctx);
  if(input.previous){const prior=yield* self.inspect(input.previous,ctx);if(prior.end&&prior.end.outcome!=="Revised"||prior.quote.offer!==input.offer||prior.quote.buyer!==input.buyer)return yield* bad("Quote cannot revise this predecessor");}
  let quote=yield* findTerminalFact(self.engine,p+"Quote","key",input.key,ctx);
  if(!quote)quote=yield* self.call("Quote.create",body,self.clean(ctx)).pipe(Effect.catch(error=>error.code==="UniqueConflict"?findTerminalFact(self.engine,p+"Quote","key",input.key,ctx).pipe(Effect.flatMap(row=>row?Effect.succeed(row):Effect.fail(error))):Effect.fail(error)));
  const existing=yield* self.price(quote,ctx);
  if(Object.entries(body).some(([key,value])=>key!=="head"&&quote![key]!==value)||existing.lines.length!==input.lines.length||existing.lines.some((line,i)=>line.rate!==input.lines[i]!.rate||line.quantity!==decodeDecimal(input.lines[i]!.quantity,{scale:6})||(line.adjustment??null)!==(input.lines[i]!.adjustment??null)))return yield* Effect.fail(err("IdempotencyMismatch","Quote key reused for different snapshot"));
  if(input.previous){const end=yield* findTerminalFact(self.engine,p+"QuoteEnd","quote",input.previous,ctx);if(end){if(end.outcome!=="Revised"||end.successor!==quote.id)return yield* bad("Prior quote already ended differently");}else yield* self.call("QuoteEnd.create",{quote:input.previous,outcome:"Revised",successor:quote.id,acceptanceDigest:null,intent:null,reason:"Revised quote"},self.clean(ctx));}return quote;
 });}
 inspect(quote:string,ctx:CallContext){const self=this;return Effect.gen(function*(){
  const row=yield* self.call("Quote.get",{id:quote},ctx),priced=yield* self.price(row,ctx),end=yield* findTerminalFact(self.engine,p+"QuoteEnd","quote",quote,ctx);
  if(row.previous!=null){const prior=yield* self.call("Quote.get",{id:row.previous},ctx),closed=yield* findTerminalFact(self.engine,p+"QuoteEnd","quote",row.previous,ctx);if(!closed||closed.outcome!=="Revised"||closed.successor!==quote||prior.offer!==row.offer||prior.buyer!==row.buyer)return yield* bad("Unpublished quote revision");}
  return{quote:row,...priced,end};
 });}
 expire(quote:string,ctx:CallContext):Effect.Effect<Wire,ForgeError>{const self=this;return Effect.gen(function*(){const state=yield* self.inspect(quote,ctx);if((yield* self.now())<String(state.quote.expiresAt))return yield* bad("Quote is not expired");if(state.end)return state.end.outcome==="Expired"?state.end:yield* bad("Quote already accepted or revised");return yield* self.call("QuoteEnd.create",{quote,outcome:"Expired",successor:null,acceptanceDigest:null,intent:null,reason:"Expired quote"},self.clean(ctx));});}
 private preflight(quote:Wire,input:QuoteAgreementInput,ctx:CallContext){const self=this;return Effect.gen(function*(){
  if(Object.keys(input).some(key=>!["supplierParticipation","customerParticipation","decisionCase","approvedOption","expectedDocument","validFrom","validUntil"].includes(key)))return yield* bad("Quote agreement command has unsupported fields");
  const offer=yield* self.engine.call(a+"Offer.get",{id:quote.offer},ctx),now=yield* self.now();
  const dates=yield* Effect.try({try:()=>({from:decodeDatetime(input.validFrom),until:decodeDatetime(input.validUntil)}),catch:()=>err("ValidationFailed","Invalid agreement interval")});
  if(dates.from<now||dates.until<=dates.from||now<String(offer.validFrom)||now>=String(offer.validUntil)||(input.expectedDocument??null)!==(offer.document??null)||quote.buyer===offer.supplier)return yield* bad("Invalid quote agreement dates, parties or document pin");
  const decision=yield* new Decisions(self.engine).state(input.decisionCase,ctx),qualification=yield* findTerminalFact(self.engine,a+"OfferQualification","decisionCase",input.decisionCase,ctx);
  const selected=decision.options.find(option=>option.id===input.approvedOption);
  if(!selected||!decision.outcome||decision.outcome.selected!==selected.id||!qualification||qualification.offer!==quote.offer||qualification.approvedOption!==selected.id||!decision.events[0]||!(Date.parse(String(qualification.createdAt))<Date.parse(String(decision.events[0].createdAt))))return yield* bad("Decision was not prebound to quoted offer");
  if(input.supplierParticipation===input.customerParticipation)return yield* bad("Agreement requires distinct signers");
  let set:unknown=null;
  for(const [id,party] of [[input.supplierParticipation,offer.supplier],[input.customerParticipation,quote.buyer]]){
   const member=yield* self.engine.call("@forgegraph/foundation/participation/_/Participation.get",{id},ctx),end=yield* findTerminalFact(self.engine,"@forgegraph/foundation/participation/_/ParticipationEnd","participation",id,ctx);
   if(member.participant!==party||String(member.validFrom)>now||member.validUntil!=null&&String(member.validUntil)<=now||end&&String(end.effectiveAt)<=now||set!=null&&member.participationSet!==set||!decision.responses.some(response=>response.voter===id&&(response.ranking as number[])[0]===selected.ordinal))return yield* bad("Agreement signer does not approve quoted terms");set=member.participationSet;
  }
 });}
 accept(quote:string,input:QuoteAgreementInput,ctx:CallContext):Effect.Effect<Wire,ForgeError>{const self=this;return Effect.gen(function*(){
  const state=yield* self.inspect(quote,ctx),catalog=new AgreementCatalog(self.engine);
  const dates=yield* Effect.try({try:()=>({validFrom:decodeDatetime(input.validFrom),validUntil:decodeDatetime(input.validUntil)}),catch:()=>err("ValidationFailed","Invalid agreement interval")});
  const normalized={...input,...dates};if(normalized.expectedDocument==null)delete normalized.expectedDocument;
  const acceptance:AcceptAgreement={...normalized,acceptanceKey:"quote:"+quote,offer:String(state.quote.offer),customer:String(state.quote.buyer),expectedTerms:String(state.quote.terms)};
  const digest=yield* Effect.promise(()=>sha256(stableJson(acceptance)));
  let terminal=state.end;
  if(terminal&&(terminal.outcome!=="Accepted"||terminal.acceptanceDigest!==digest))return yield* Effect.fail(err("IdempotencyMismatch","Quote terminal or acceptance command differs"));
  if(!terminal){
   if((yield* self.now())>=String(state.quote.expiresAt))return yield* bad("Quote expired");
   yield* self.preflight(state.quote,input,ctx);
   const intent=yield* catalog.prepareAcceptance(acceptance,self.clean(ctx));
   const committedInput:Wire={acceptance:intent.id};
   for(const field of ["acceptanceKey","offer","supplier","customer","supplierParticipation","customerParticipation","supplierEnd","customerEnd","qualification","approvalOption","approval","terms","document","offerValidFrom","offerValidUntil","validFrom","validUntil","predecessor","change","recordedBy"])committedInput[field]=intent[field];
   terminal=yield* self.engine.atomic([
    {operation:p+"QuoteEnd.create",input:{quote,outcome:"Accepted",successor:null,acceptanceDigest:digest,intent:intent.id,reason:"Accepted exact priced snapshot"}},
    {operation:a+"AgreementAcceptanceCommit.create",input:committedInput}
   ],self.clean(ctx),{absent:(["supplier","customer"] as const).filter(side=>intent[side+"End"]==null).map(side=>({resource:"@forgegraph/foundation/participation/_/ParticipationEnd",unique:"participation",values:{participation:intent[side+"Participation"]}}))}).pipe(Effect.map(rows=>rows[0]!),Effect.catch(error=>error.code==="UniqueConflict"?findTerminalFact(self.engine,p+"QuoteEnd","quote",quote,ctx).pipe(Effect.flatMap(row=>row&&row.outcome==="Accepted"&&row.acceptanceDigest===digest?Effect.succeed(row):Effect.fail(error))):Effect.fail(error)));
  }
  // Acceptance is durable before contract issuance. Failed stages safely resume
  // with the exact original command, never a new terms/party/interval choice.
  // Legacy terminals without a durable intent cannot establish historical authority.
  if(terminal.intent==null)return yield* bad("Accepted quote lacks a recoverable committed intent");
  const commitment=yield* findTerminalFact(self.engine,a+"AgreementAcceptanceCommit","acceptance",terminal.intent,ctx);
  if(!commitment||!(Date.parse(String(terminal.createdAt))<=Date.parse(String(commitment.createdAt))))return yield* bad("Quote acceptance intent was not committed with its terminal");
  const agreement=yield* catalog.acceptCommitted(acceptance,String(commitment.id),self.clean(ctx));yield* catalog.issue(String(agreement.id),self.clean(ctx));
  const linked=yield* findTerminalFact(self.engine,p+"QuoteAgreement","quote",quote,ctx);if(linked){if(linked.agreement!==agreement.id||linked.acceptance!==terminal.id)return yield* bad("Quote agreement linkage changed");return linked;}
  return yield* self.call("QuoteAgreement.create",{quote,acceptance:terminal.id,agreement:agreement.id},self.clean(ctx)).pipe(Effect.catch(error=>error.code==="UniqueConflict"?findTerminalFact(self.engine,p+"QuoteAgreement","quote",quote,ctx).pipe(Effect.flatMap(row=>row&&row.agreement===agreement.id&&row.acceptance===terminal.id?Effect.succeed(row):Effect.fail(error))):Effect.fail(error)));
 });}
 /** Authoritative issued agreement trace; raw accepted terminals remain pending intents. */
 agreement(quote:string,ctx:CallContext):Effect.Effect<Wire,ForgeError>{const self=this;return Effect.gen(function*(){
  const state=yield* self.inspect(quote,ctx),link=yield* findTerminalFact(self.engine,p+"QuoteAgreement","quote",quote,ctx);
  if(!link||state.end?.outcome!=="Accepted"||link.acceptance!==state.end.id)return yield* bad("Quote agreement issuance is incomplete");
  const issued=yield* new AgreementCatalog(self.engine).state(String(link.agreement),yield* self.now(),ctx),contract=issued.agreement;
  if(!issued.issuance||contract.acceptanceKey!=="quote:"+quote||contract.offer!==state.quote.offer||contract.customer!==state.quote.buyer||contract.terms!==state.quote.terms)return yield* bad("Quote points to unrelated agreement");
  if(contract.acceptance==null||state.end.intent==null)return yield* bad("Quote agreement lacks committed acceptance");
  const commitment=yield* self.engine.call(a+"AgreementAcceptanceCommit.get",{id:contract.acceptance},ctx);
  if(commitment.acceptance!==state.end.intent||!(Date.parse(String(state.end.createdAt))<=Date.parse(String(commitment.createdAt))))return yield* bad("Quote agreement acceptance intent differs");
  const qualification=yield* self.engine.call(a+"OfferQualification.get",{id:contract.qualification},ctx);
  const acceptance:AcceptAgreement={acceptanceKey:String(contract.acceptanceKey),offer:String(contract.offer),customer:String(contract.customer),expectedTerms:String(contract.terms),supplierParticipation:String(contract.supplierParticipation),customerParticipation:String(contract.customerParticipation),decisionCase:String(qualification.decisionCase),approvedOption:String(contract.approvalOption),validFrom:String(contract.validFrom),validUntil:String(contract.validUntil),...(contract.document==null?{}:{expectedDocument:String(contract.document)})};
  const digest=yield* Effect.promise(()=>sha256(stableJson(acceptance)));if(digest!==state.end.acceptanceDigest)return yield* bad("Quote acceptance command does not match agreement");
  return link;
 });}

}
