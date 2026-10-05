import { Effect } from 'effect';
import { sha256,stableJson,type Engine,type CallContext,type AtomicMutation } from '../engine.js';
import type { Wire } from '../decode.js';
import { err,type ForgeError } from '../errors.js';
import { decodeDatetime,decodeDecimal,toMinor,formatMinor } from '../codecs.js';
import { exactRateAmount } from './quotation-pricing.js';
import { findTerminalFact } from './facts.js';
import { AgreementCatalog } from './agreement-catalog.js';
import { Settlements,type SettlementAdmission } from './settlement.js';
const p='@forgegraph/foundation/billing/_/',qp='@forgegraph/foundation/quotation-pricing/_/',lp='@forgegraph/foundation/ledger/_/',up='@forgegraph/foundation/usage/_/';
const bad=(message:string)=>Effect.fail(err('ValidationFailed',message));
export interface ChargeInput {period:string;sourceKey:string;kind:'usage'|'recurring'|'oneOff'|'adjustment';ratedAt:string;source:string;rate?:string;quantity?:string;meter?:string;usageEvent?:string;adjustment?:string;adjustmentFor?:string}
/** Exact fixed-rate snapshots. Tax/proration are explicit domain-priced adjustments. */
export class Billing {
 constructor(private readonly engine:Engine,private readonly settlementAdmission?:SettlementAdmission){}
 private call(op:string,input:Wire,ctx:CallContext){return this.engine.call(p+op,input,ctx);}
 private period(id:string,ctx:CallContext){const self=this;return Effect.gen(function*(){
  const period=yield* self.call('BillingPeriod.get',{id},ctx);
  const agreement=yield* self.engine.call('@forgegraph/foundation/agreement-catalog/_/Agreement.get',{id:period.agreement},ctx);
  yield* self.engine.call('@forgegraph/foundation/specification/_/SpecificationPin.get',{id:period.terms},ctx);
  if(period.terms!==agreement.terms||String(period.from)<String(agreement.validFrom)||String(period.until)>String(agreement.validUntil))return yield* bad('Billing period differs from pinned agreement terms');
  return period;
 });}
 private calculate(input:ChargeInput,ctx:CallContext,historical=false):Effect.Effect<Wire,ForgeError>{const self=this;return Effect.gen(function*(){
  const period=yield* self.period(input.period,ctx);
  const ratedAt=yield* Effect.try({try:()=>decodeDatetime(input.ratedAt),catch:()=>err('ValidationFailed','Invalid rating time')});
  const agreement=yield* new AgreementCatalog(self.engine).state(String(period.agreement),ratedAt,ctx);
  if(agreement.phase!=='Active'||ratedAt<String(period.from)||ratedAt>=String(period.until))return yield* bad('Rating requires an active agreement within its period');
  const fields:Wire={...input,ratedAt,rate:input.rate??null,meter:input.meter??null,usageEvent:input.usageEvent??null,adjustment:input.adjustment??null,adjustmentFor:input.adjustmentFor??null};
  if(input.kind==='adjustment'){
   if(!input.adjustment||!input.adjustmentFor)return yield* bad('Adjustment requires a priced correction and original charge');
   const adjustment=yield* self.engine.call(qp+'PriceAdjustment.get',{id:input.adjustment},ctx),original=yield* self.call('BillingCharge.get',{id:input.adjustmentFor},ctx),prior=yield* self.period(String(original.period),ctx);
   const account=yield* self.engine.call(lp+'Account.get',{id:adjustment.account},ctx),oldAccount=yield* self.engine.call(lp+'Account.get',{id:original.account},ctx);
   if(prior.agreement!==period.agreement||account.unit!==oldAccount.unit)return yield* bad('Correction must preserve agreement and unit');
   Object.assign(fields,{quantity:'1.000000',amount:adjustment.amount,account:adjustment.account,definition:adjustment.definition});
  }else{
   if(!input.rate)return yield* bad('Rated charge requires a pricing rate');
   const rate=yield* self.engine.call(qp+'PricingRate.get',{id:input.rate},ctx);
   if(ratedAt<String(rate.validFrom)||ratedAt>=String(rate.validUntil))return yield* bad('Rate is outside its effective interval');
   let quantity=input.quantity??'1';
   if(input.kind==='usage'){
    if(!input.usageEvent||!input.meter)return yield* bad('Usage rating requires an exact event and meter-rate binding');
    const event=yield* self.engine.call(up+'UsageEvent.get',{id:input.usageEvent},ctx),meter=yield* self.call('BillingMeterRate.get',{id:input.meter},ctx);
    if(meter.rate!==input.rate||meter.dimension!==event.dimension||event.replacementFor!=null)return yield* bad('Wrong usage dimension or staged replacement; admit corrected usage through a credit and new source');
    const correction=yield* findTerminalFact(self.engine,up+'UsageCorrection','event',event.id,ctx);
    if(correction&&!historical)return yield* bad('Usage source is already corrected or retracted');
    const start=String(event.occurredAt??event.intervalStart),end=String(event.occurredAt??event.intervalEnd);
    if(start<String(period.from)||end>String(period.until)||event.occurredAt!=null&&start>=String(period.until))return yield* bad('Usage source is outside the billing period');
    quantity=String(event.quantity);
   }
   quantity=yield* Effect.try({try:()=>decodeDecimal(quantity,{scale:6,min:'0.000001'}),catch:()=>err('ValidationFailed','Invalid rated quantity')});
   const amount=yield* Effect.try({try:()=>exactRateAmount(quantity,String(rate.unitPrice)),catch:()=>err('ValidationFailed','Rating requires an exact six-decimal result')});
   Object.assign(fields,{quantity,amount:formatMinor(amount,6),account:rate.account,definition:rate.definition});
  }
  yield* self.engine.call(lp+'Account.get',{id:fields.account},ctx);
  yield* self.engine.call('@forgegraph/foundation/specification/_/SpecificationPin.get',{id:fields.definition},ctx);
  return fields;
 });}
 rate(input:ChargeInput,ctx:CallContext){const self=this;return Effect.gen(function*(){
  const fields=yield* self.calculate(input,ctx);
  const guards=input.usageEvent?[{resource:up+'UsageCorrection',unique:self.engine.model.resource(up+'UsageCorrection').uniques.find(u=>u.fields.length===1&&u.fields[0]==='event')!.name,values:{event:input.usageEvent}}]:[];
  const mutations:AtomicMutation[]=[{operation:p+'BillingCharge.create',input:fields}];
  if(input.kind==='recurring')mutations.push({operation:p+'BillingRecurringClaim.create',input:{period:input.period,rate:input.rate,sourceKey:input.sourceKey}});
  return (yield* self.engine.atomic(mutations,ctx,{absent:guards}))[0]!;
 });}
 private snapshot(bill:Wire,ctx:CallContext):Effect.Effect<{charges:Wire[];totals:Record<string,string>;digest:string},ForgeError>{const self=this;return Effect.gen(function*(){
  const period=yield* self.period(String(bill.period),ctx),charges:Wire[]=[],seen=new Set<string>(),total=new Map<string,bigint>();let id=String(bill.head);
  if(bill.corrects!=null){const previous=yield* self.call('Bill.get',{id:bill.corrects},ctx),prior=yield* self.period(String(previous.period),ctx);if(prior.agreement!==period.agreement||!(yield* findTerminalFact(self.engine,p+'BillIssued','bill',previous.id,ctx)))return yield* bad('Correction requires an issued bill for the same agreement');}
  while(id){if(charges.length>=16||seen.has(id))return yield* bad('Bill requires at most 16 acyclic lines');seen.add(id);
   const line=yield* self.call('BillingLine.get',{id},ctx),charge=yield* self.call('BillingCharge.get',{id:line.charge},ctx);
   if(charge.period!==bill.period||charges.some(c=>c.id===charge.id))return yield* bad('Bill has duplicate or cross-period charges');
   const calculated=yield* self.calculate({period:String(charge.period),sourceKey:String(charge.sourceKey),kind:charge.kind as ChargeInput['kind'],ratedAt:String(charge.ratedAt),source:String(charge.source),quantity:String(charge.quantity),...(charge.rate?{rate:String(charge.rate)}:{}),...(charge.meter?{meter:String(charge.meter)}:{}),...(charge.usageEvent?{usageEvent:String(charge.usageEvent)}:{}),...(charge.adjustment?{adjustment:String(charge.adjustment)}:{}),...(charge.adjustmentFor?{adjustmentFor:String(charge.adjustmentFor)}:{})},ctx,true);
   if(Object.entries(calculated).some(([key,value])=>charge[key]!==value))return yield* bad('Stored charge differs from its exact rating inputs');
   const account=yield* self.engine.call(lp+'Account.get',{id:charge.account},ctx);yield* self.engine.call('@forgegraph/foundation/specification/_/SpecificationPin.get',{id:charge.definition},ctx);
   if(charge.kind==='recurring'){const claim=yield* self.call('BillingRecurringClaim.find.byPeriodRate',{params:{period:charge.period,rate:charge.rate}},ctx);if(claim.sourceKey!==charge.sourceKey)return yield* bad('Recurring charge has no unique period-rate claim');}
   charges.push(charge);total.set(String(account.unit),(total.get(String(account.unit))??0n)+toMinor(String(charge.amount),6));id=line.next==null?'':String(line.next);
  }
  if(!charges.length)return yield* bad('Bill has no charges');
  const totals=Object.fromEntries([...total].map(([unit,amount])=>[unit,formatMinor(amount,6)]));
  return {charges,totals,digest:yield* Effect.promise(()=>sha256(stableJson({bill,period,charges,totals})))};
 });}
 draft(input:{key:string;period:string;charges:readonly string[];reason:string;corrects?:string},ctx:CallContext){const self=this;return Effect.gen(function*(){
  if(!input.charges.length||input.charges.length>16||new Set(input.charges).size!==input.charges.length)return yield* bad('Bill needs 1..16 distinct charges');
  let head:unknown=null;
  for(const charge of [...input.charges].reverse()){const line=yield* self.call('BillingLine.create',{charge,next:head},ctx);head=line.id;}
  const body={key:input.key,period:input.period,head,corrects:input.corrects??null,reason:input.reason};yield* self.snapshot(body,ctx);
  return yield* self.call('Bill.create',body,ctx);
 });}
 issue(bill:string,ctx:CallContext){const self=this;return Effect.gen(function*(){
  const row=yield* self.call('Bill.get',{id:bill},ctx),snapshot=yield* self.snapshot(row,ctx);
  const existing=yield* findTerminalFact(self.engine,p+'BillIssued','bill',bill,ctx);if(existing){if(existing.digest!==snapshot.digest)return yield* bad('Issued snapshot digest mismatch');return existing;}
  const mutations:AtomicMutation[]=snapshot.charges.map(charge=>({operation:p+'BilledCharge.create',input:{bill,charge:charge.id}}));
  mutations.push({operation:p+'BillIssued.create',input:{bill,digest:snapshot.digest,issuedBy:ctx.actor}});
  return (yield* self.engine.atomic(mutations,ctx)).at(-1)!;
 });}
 inspect(bill:string,ctx:CallContext){const self=this;return Effect.gen(function*(){
  const row=yield* self.call('Bill.get',{id:bill},ctx),snapshot=yield* self.snapshot(row,ctx),issue=yield* findTerminalFact(self.engine,p+'BillIssued','bill',bill,ctx);
  if(issue){if(issue.digest!==snapshot.digest)return yield* bad('Issued snapshot digest mismatch');for(const charge of snapshot.charges){const claim=yield* findTerminalFact(self.engine,p+'BilledCharge','charge',charge.id,ctx);if(!claim||claim.bill!==bill)return yield* bad('Issued bill lacks unique charge claims');}}
  return {bill:row,issue,...snapshot};
 });}
 positions(bill:string,asOf:string,ctx:CallContext){const self=this;return Effect.gen(function*(){
  const snapshot=yield* self.inspect(bill,ctx);if(!snapshot.issue)return yield* bad('Unissued bill has no financial representation');
  const result:Wire[]=[];let cursor:string|undefined;
  do{const page=yield* self.call('BillPosition.list.byBill',{params:{bill},limit:16,...(cursor?{cursor}:{})},ctx);
   for(const row of page.items as Wire[]){if(result.length>=128)return yield* bad('Bill position bound exceeded');result.push(yield* new Settlements(self.engine,self.settlementAdmission).inspect(String(row.position),{asOf},ctx));}
   cursor=page.next as string|undefined;
  }while(cursor);
  return result;
 });}
}
