import { Effect } from "effect";
import { decodeDatetime, decodeDecimal, formatMinor, toMinor } from "../codecs.js";
import type { Engine, CallContext } from "../engine.js";
import type { Wire } from "../decode.js";
import { err, type ForgeError } from "../errors.js";
import { Storage, Clock, type StoredRecord } from "../services.js";
import { findTerminalFact } from "./facts.js";
import { AgreementCatalog } from "./agreement-catalog.js";
import { Ledger } from "./ledger.js";
const p="@forgegraph/foundation/settlement/_/", ep="@forgegraph/foundation/entitlement/_/", fp="@forgegraph/foundation/fulfillment/_/", ap="@forgegraph/foundation/agreement-catalog/_/";
const bad=(detail:string)=>Effect.fail(err("ValidationFailed",detail));
export type SettlementAdmission = (source:Wire, allocations:readonly {position:Wire;quantity:string}[], ctx:CallContext, effectiveAt?:string, knownAt?:string)=>Effect.Effect<void,ForgeError>;
export interface SettlementAllocation { position:string; quantity:string }
export interface SettlementCommand { book:string; key:string; occurredAt:string; effectiveAt:string; reason:string; lines:SettlementAllocation[]; source:string }
type Command=Omit<SettlementCommand,"source">&{source?:string}&{kind:"Materialize"|"Settle"|"Reverse";reversalOf?:string};
type History={commit:Wire;event:Wire;lines:SettlementAllocation[]};
const same=(a:unknown,b:unknown)=>JSON.stringify(a)===JSON.stringify(b);
/** Immutable event publication serializes a bounded book. No mutable balance cache
 * and no staged candidate contributes to authority. All quantities are decimal6. */
export class Settlements {
 constructor(private readonly engine:Engine, private readonly admission?:SettlementAdmission){}
 private call(op:string,body:Wire,ctx:CallContext):Effect.Effect<Wire,ForgeError>{return this.engine.call(p+op,body,ctx);}
 private clean(ctx:CallContext){const{idempotencyKey:_,...rest}=ctx;return rest;}
 private now(){return Effect.gen(function*(){return(yield* Clock).now();}).pipe(Effect.provide(this.engine.layer));}
 private instant(value:string){return Effect.try({try:()=>decodeDatetime(value),catch:()=>err("ValidationFailed","Invalid settlement instant")});}
 private scan(name:string,book:string,ctx:CallContext):Effect.Effect<Wire[],ForgeError>{const self=this;return Effect.gen(function*(){
  const r=self.engine.model.resource(p+name),list=r.lists.find(l=>l.fields.length===1&&l.fields[0]==="book")!,keys=self.engine.sortKeys(r,list),storage=yield* Storage;
  let after=null as {keys:string[];values:unknown[];id:string}|null;const rows:Wire[]=[];
  do {const page:{records:StoredRecord[];hasMore:boolean}=yield* storage.list(ctx.tenant,r,{list,values:{book},after,limit:100},keys);
   for(const record of page.records){if(rows.length>=512)return yield* Effect.fail(err("BudgetExceeded","Settlement book exceeds 512 records"));rows.push(yield* self.call(name+".get",{id:record.id},ctx));}
   const last=page.records.at(-1);after=page.hasMore&&last?{keys:keys(last),values:list.order.map(o=>last[o.field]??null),id:String(last.id)}:null;
  }while(after);return rows;
 }).pipe(Effect.provide(self.engine.layer));}
 private position(id:string,ctx:CallContext):Effect.Effect<Wire,ForgeError>{const self=this;return Effect.gen(function*(){
  const row=yield* self.call("SettlementPosition.get",{id},ctx),obligation=yield* self.engine.call(ep+"Obligation.get",{id:row.obligation},ctx);
  for(const role of ["creditor","debtor"])yield* self.engine.call("@forgegraph/foundation/party/_/Party.get",{id:row[role]},ctx);
  if(row.creditor===row.debtor||row.debtor!==obligation.obligatedParty||row.unit!==obligation.unit||row.ceiling!==obligation.quantity||row.dueAt!==obligation.dueAt)return yield* bad("Position does not match quantified obligation");
  if(toMinor(String(row.ceiling),6)<=0n)return yield* bad("Position needs positive quantified obligation");
  if(row.agreement!=null){const contract=yield* self.engine.call(ap+"Agreement.get",{id:row.agreement},ctx),offer=yield* self.engine.call(ap+"Offer.get",{id:contract.offer},ctx);if(obligation.scope!==offer.scope||obligation.requirement!==offer.requirement||row.creditor!==contract.supplier||row.debtor!==contract.customer)return yield* bad("Position parties/scope do not match Agreement obligation");}
  return row;
 });}
 openPosition(input:{book:string;obligation:string;creditor:string;agreement?:string;reason:string},ctx:CallContext):Effect.Effect<Wire,ForgeError>{const self=this;return Effect.gen(function*(){
  yield* self.call("SettlementBook.get",{id:input.book},ctx);
  const obligation=yield* self.engine.call(ep+"Obligation.get",{id:input.obligation},ctx);
  if(obligation.quantity==null||obligation.unit==null||toMinor(String(obligation.quantity),6)<=0n)return yield* bad("Position needs positive quantified obligation");
  const body={...input,agreement:input.agreement??null,debtor:obligation.obligatedParty,unit:obligation.unit,ceiling:obligation.quantity,dueAt:obligation.dueAt};
  const existing=yield* findTerminalFact(self.engine,p+"SettlementPosition","obligation",input.obligation,ctx);
  if(existing){for(const[k,v]of Object.entries(body))if(existing[k]!==v)return yield* Effect.fail(err("IdempotencyMismatch","Obligation position already bound differently"));yield* self.position(String(existing.id),ctx);return existing;}
  yield* self.admit(body,String(obligation.incurredAt),ctx);
  return yield* self.call("SettlementPosition.create",body,self.clean(ctx));
 });}
 private admit(position:Wire,at:string,ctx:CallContext,knownAt?:string):Effect.Effect<void,ForgeError>{const self=this;return Effect.gen(function*(){
  const obligation=yield* self.engine.call(ep+"Obligation.get",{id:position.obligation},ctx),ended=yield* findTerminalFact(self.engine,ep+"ObligationEnd","obligation",position.obligation,ctx);
  if(Date.parse(at)<Date.parse(String(obligation.incurredAt))||knownAt&&Date.parse(String(obligation.createdAt))>Date.parse(knownAt)||ended&&(!knownAt||Date.parse(String(ended.createdAt))<=Date.parse(knownAt))&&Date.parse(String(ended.effectiveAt))<=Date.parse(at))return yield* bad("Obligation is not outstanding at event effective/knowledge time");
  const state={obligation};
  if(position.agreement!=null){
   const contract=yield* new AgreementCatalog(self.engine).state(String(position.agreement),String(state.obligation.incurredAt),ctx);
   const offer=yield* self.engine.call(ap+"Offer.get",{id:contract.agreement.offer},ctx);
   if(!contract.issuance||contract.phase!=="Active"||state.obligation.scope!==offer.scope||state.obligation.requirement!==offer.requirement||contract.agreement.supplier!==position.creditor||contract.agreement.customer!==position.debtor)return yield* bad("Position requires authoritative issued Agreement and matching parties/scope");
  }
 });}
 private lines(event:Wire,ctx:CallContext):Effect.Effect<SettlementAllocation[],ForgeError>{const self=this;return Effect.gen(function*(){
  const rows:SettlementAllocation[]=[],seen=new Set<string>();let id=String(event.head);
  while(id){if(rows.length>=16||seen.has(id))return yield* bad("Settlement event line chain must be acyclic and bounded");seen.add(id);
   const row=yield* self.call("SettlementLine.get",{id},ctx),position=yield* self.position(String(row.position),ctx);
   if(row.book!==event.book||position.book!==event.book||rows.some(r=>r.position===row.position)||toMinor(String(row.quantity),6)<=0n)return yield* bad("Invalid settlement event allocation");
   rows.push({position:String(row.position),quantity:String(row.quantity)});id=row.next==null?"":String(row.next);
  }return rows;
 });}
 admitSource(input:{book:string;key:string;kind:"Materialize"|"Settle";unit:string;quantity:string;occurredAt:string;fulfillmentEnd:string;reason:string},ctx:CallContext):Effect.Effect<Wire,ForgeError>{const self=this;return Effect.gen(function*(){
  const occurredAt=yield* self.instant(input.occurredAt),quantity=yield* Effect.try({try:()=>decodeDecimal(input.quantity,{scale:6}),catch:()=>err("ValidationFailed","Invalid source quantity")});
  if(occurredAt>(yield* self.now())||toMinor(quantity,6)<=0n)return yield* bad("Source must be observed and positive");
  const body={...input,occurredAt,quantity,fulfillmentEnd:input.fulfillmentEnd};
  if(!self.admission)return yield* bad("Trusted typed source admission is required");
  yield* self.admission(body,[],ctx,undefined,yield* self.now());
  const existing=yield* findTerminalFact(self.engine,p+"SettlementSource","key",input.key,ctx);
  if(existing){for(const[k,v]of Object.entries(body))if(existing[k]!==v)return yield* Effect.fail(err("IdempotencyMismatch","Settlement source identity changed"));return existing;}
  return yield* self.call("SettlementSource.create",body,self.clean(ctx));
 });}
 private source(event:Wire,lines:SettlementAllocation[],ctx:CallContext,knownAt?:string):Effect.Effect<void,ForgeError>{const self=this;return Effect.gen(function*(){
  if(event.kind==="Reverse"){if(event.source!=null)return yield* bad("Reversal cannot consume a new source");return;}
  if(event.source==null)return yield* bad("Settlement requires admitted quantitative source");
  const source=yield* self.call("SettlementSource.get",{id:event.source},ctx);
  if(source.book!==event.book||source.kind!==event.kind||source.occurredAt!==event.occurredAt)return yield* bad("Settlement source does not match event");
  if(Date.parse(String(event.effectiveAt))<Date.parse(String(source.occurredAt)))return yield* bad("An economic effect cannot predate its source occurrence");
  if(!self.admission)return yield* bad("Trusted typed source admission is required");
  const positions:Wire[]=[];let sum=0n;for(const line of lines){const position=yield* self.position(line.position,ctx);positions.push(position);if(position.unit!==source.unit)return yield* bad("Settlement source unit mismatch");const obligation=yield* self.engine.call(ep+"Obligation.get",{id:position.obligation},ctx);if(Date.parse(String(source.occurredAt))<Date.parse(String(obligation.incurredAt)))return yield* bad("Source occurrence predates obligation");sum+=toMinor(line.quantity,6);}
  yield* self.admission(source,positions.map((position,index)=>({position,quantity:lines[index]!.quantity})),ctx,String(event.effectiveAt),knownAt??(yield* self.now()));
  if(sum!==toMinor(String(source.quantity),6))return yield* bad("Event allocations must exactly consume source quantity");
  if(source.fulfillmentEnd==null)return yield* bad("Materialization requires performance evidence");
  if(source.fulfillmentEnd!=null){const finish=yield* self.engine.call(fp+"FulfillmentEnd.get",{id:source.fulfillmentEnd},ctx);yield* self.engine.call(fp+"Fulfillment.get",{id:finish.fulfillment},ctx);if(finish.outcome!=="completed"||!["complete","partial"].includes(String(finish.coverage))||String(finish.endedAt)>String(source.occurredAt))return yield* bad("Invalid source performance observation");}
 });}
 private history(book:string,ctx:CallContext):Effect.Effect<History[],ForgeError>{const self=this;return Effect.gen(function*(){
  yield* self.call("SettlementBook.get",{id:book},ctx);const commits=yield* self.scan("SettlementCommit",book,ctx),rows:History[]=[];
  for(const commit of commits){const previous=rows.at(-1)?.commit;
   if(commit.ordinal!==rows.length+1||(commit.previous??null)!==(previous?.id??null)||previous&&String(commit.createdAt)<String(previous.createdAt))return yield* bad("Invalid settlement commit chain");
   const event=yield* self.call("SettlementEvent.get",{id:commit.event},ctx);
   if(event.book!==book||event.key!==commit.key||String(event.occurredAt)>String(commit.createdAt))return yield* bad("Invalid settlement publication");
   const lines=yield* self.lines(event,ctx);
   for(const line of lines){const position=yield* self.position(line.position,ctx);if(Date.parse(String(position.createdAt))>Date.parse(String(commit.createdAt)))return yield* bad("Position predates publication knowledge");yield* self.admit(position,String(event.effectiveAt),ctx,String(commit.createdAt));}
   if(event.source!=null){const source=yield* self.call("SettlementSource.get",{id:event.source},ctx);if(Date.parse(String(source.createdAt))>Date.parse(String(commit.createdAt)))return yield* bad("Source was not known at publication");}if(!lines.length)return yield* bad("Empty settlement event");
   if(commit.source!==event.source)return yield* bad("Settlement source publication mismatch");yield* self.source(event,lines,ctx,String(commit.createdAt));
   if(event.kind==="Reverse"){
    const original=rows.find(r=>r.commit.id===event.reversalOf);
    if(!original||original.event.kind==="Reverse"||rows.some(r=>r.event.reversalOf===event.reversalOf)||!same(lines,original.lines)||String(event.effectiveAt)<String(original.event.effectiveAt))return yield* bad("Invalid, repeated or nested settlement reversal");
   }else if(!["Materialize","Settle"].includes(String(event.kind))||event.reversalOf!=null)return yield* bad("Invalid settlement event kind");
   if(event.source!=null&&rows.some(r=>r.event.source===event.source))return yield* bad("Source already consumed by a committed event");
   rows.push({commit,event,lines});
  }yield* self.balances(rows,ctx);return rows;
 });}
 private balances(rows:History[],ctx:CallContext):Effect.Effect<Map<string,{materialized:bigint;settled:bigint}>,ForgeError>{const self=this;return Effect.gen(function*(){
  const result=new Map<string,{materialized:bigint;settled:bigint}>();
  for(const row of [...rows].sort((a,b)=>String(a.event.effectiveAt).localeCompare(String(b.event.effectiveAt))||Number(a.commit.ordinal)-Number(b.commit.ordinal))){
   const original=row.event.kind==="Reverse"?rows.find(r=>r.commit.id===row.event.reversalOf):row;
   if(!original)return yield* bad("Reversal source missing from temporal view");
   for(const line of row.lines){const position=yield* self.position(line.position,ctx),balance=result.get(line.position)??{materialized:0n,settled:0n};const amount=toMinor(line.quantity,6)*(row.event.kind==="Reverse"?-1n:1n);
    if(original.event.kind==="Materialize")balance.materialized+=amount;else balance.settled+=amount;
    if(balance.materialized<0n||balance.materialized>toMinor(String(position.ceiling),6)||balance.settled<0n||balance.settled>balance.materialized)return yield* bad("Settlement would overdraw a temporal position balance");result.set(line.position,balance);
   }
  }return result;
 });}
 materialize(input:SettlementCommand,ctx:CallContext){return this.publish({...input,kind:"Materialize"},ctx);}
 settle(input:SettlementCommand,ctx:CallContext){return this.publish({...input,kind:"Settle"},ctx);}
 reverse(book:string,original:string,input:{key:string;occurredAt:string;effectiveAt:string;reason:string},ctx:CallContext):Effect.Effect<Wire,ForgeError>{const self=this;return Effect.gen(function*(){
  const history=yield* self.history(book,ctx),source=history.find(h=>h.commit.id===original);if(!source||source.event.kind==="Reverse")return yield* bad("Only original committed events can be reversed");
  return yield* self.publish({...input,book,kind:"Reverse",reversalOf:original,lines:source.lines},ctx);
 });}
 private publish(input:Command,ctx:CallContext):Effect.Effect<Wire,ForgeError>{const self=this;return Effect.gen(function*(){
  if(input.lines.length<1||input.lines.length>16||new Set(input.lines.map(l=>l.position)).size!==input.lines.length)return yield* bad("Event requires 1..16 distinct positions");
  const occurredAt=yield* self.instant(input.occurredAt),effectiveAt=yield* self.instant(input.effectiveAt),now=yield* self.now();
  if(occurredAt>now)return yield* bad("Occurrence cannot be later than knowledge time");
  const lines=yield* Effect.try({try:()=>input.lines.map(l=>({position:l.position,quantity:decodeDecimal(l.quantity,{scale:6})})),catch:()=>err("ValidationFailed","Invalid exact settlement quantity")});
  const history=yield* self.history(input.book,ctx),existing=history.find(h=>h.commit.key===input.key);
  const matches=(h:History)=>h.event.kind===input.kind&&h.event.occurredAt===occurredAt&&h.event.effectiveAt===effectiveAt&&h.event.reason===input.reason&&(h.event.source??null)===(input.source??null)&&(h.event.reversalOf??null)===(input.reversalOf??null)&&same(h.lines,lines);
  if(existing)return matches(existing)?existing.commit:yield* Effect.fail(err("IdempotencyMismatch","Settlement key reused with different event"));
  if(history.length>=512)return yield* Effect.fail(err("BudgetExceeded","Settlement book exceeds 512 events"));
  if(input.kind==="Reverse"){const original=history.find(h=>h.commit.id===input.reversalOf);if(!original||original.event.kind==="Reverse"||history.some(h=>h.event.reversalOf===input.reversalOf)||effectiveAt<String(original.event.effectiveAt)||!same(lines,original.lines))return yield* bad("Invalid, repeated or nested settlement reversal");}
  const absent:{resource:string;unique:string;values:Wire}[]=[];
  for(const line of lines){const position=yield* self.position(line.position,ctx);if(position.book!==input.book)return yield* bad("Cross-book settlement");yield* self.admit(position,effectiveAt,ctx);
   const ended=yield* findTerminalFact(self.engine,ep+"ObligationEnd","obligation",position.obligation,ctx);if(!ended)absent.push({resource:ep+"ObligationEnd",unique:"obligation",values:{obligation:position.obligation}});
  }
  let head:string|null=null;
  for(const line of [...lines].reverse()){const candidate:Wire=yield* self.call("SettlementLine.create",{...line,book:input.book,next:head},self.clean(ctx));head=String(candidate.id);}
  const event=yield* self.call("SettlementEvent.create",{book:input.book,key:input.key,kind:input.kind,head,source:input.source??null,occurredAt,effectiveAt,reversalOf:input.reversalOf??null,reason:input.reason},self.clean(ctx));
  yield* self.lines(event,ctx);
  yield* self.source(event,lines,ctx);
  yield* self.balances([...history,{event,lines,commit:{ordinal:history.length+1}}],ctx);
  return yield* self.engine.atomic([{operation:p+"SettlementCommit.create",input:{book:input.book,key:input.key,event:event.id,source:input.source??null,ordinal:history.length+1,previous:history.at(-1)?.commit.id??null}}],self.clean(ctx),{absent}).pipe(Effect.map(rows=>rows[0]!),Effect.catch(error=>self.history(input.book,ctx).pipe(Effect.flatMap(current=>{const winner=current.find(h=>h.commit.key===input.key);return winner?(matches(winner)?Effect.succeed(winner.commit):Effect.fail(err("IdempotencyMismatch","Settlement key reused with different event"))):Effect.fail(error);}))));
 });}
 inspect(positionId:string,query:{asOf:string;knownAt?:string;party?:string},ctx:CallContext):Effect.Effect<Wire,ForgeError>{const self=this;return Effect.gen(function*(){
  const position=yield* self.position(positionId,ctx),asOf=yield* self.instant(query.asOf),knownAt=yield* self.instant(query.knownAt??(yield* self.now()));
  if(String(position.createdAt)>knownAt)return yield* Effect.fail(err("NotFound","Position was not known at requested instant"));
  const history=yield* self.history(String(position.book),ctx),selected=history.filter(h=>String(h.commit.createdAt)<=knownAt&&String(h.event.effectiveAt)<=asOf);
  const totals=(yield* self.balances(selected,ctx)).get(positionId)??{materialized:0n,settled:0n};
  if(query.party&&query.party!==position.creditor&&query.party!==position.debtor)return yield* bad("Party is not a settlement counterparty");
  return{position:positionId,unit:position.unit,creditor:position.creditor,debtor:position.debtor,perspective:query.party?(query.party===position.creditor?"receivable":"payable"):"neutral",materialized:formatMinor(totals.materialized,6),settled:formatMinor(totals.settled,6),remaining:formatMinor(totals.materialized-totals.settled,6),dueAt:position.dueAt,overdue:position.dueAt!=null&&String(position.dueAt)<=asOf&&totals.materialized>totals.settled,asOf,knownAt,events:selected.filter(h=>h.lines.some(l=>l.position===positionId)).map(h=>({commit:h.commit.id,kind:h.event.kind,occurredAt:h.event.occurredAt,effectiveAt:h.event.effectiveAt,knownAt:h.commit.createdAt,reversalOf:h.event.reversalOf,quantity:h.lines.find(l=>l.position===positionId)!.quantity}))};
 });}
 linkLedger(commitId:string,postingId:string,reason:string,ctx:CallContext):Effect.Effect<Wire,ForgeError>{const self=this;return Effect.gen(function*(){
  const commit=yield* self.call("SettlementCommit.get",{id:commitId},ctx);yield* self.history(String(commit.book),ctx);
  const posting=yield* self.engine.call("@forgegraph/foundation/ledger/_/PostingGroup.get",{id:postingId},ctx),ledger=yield* new Ledger(self.engine).rebuild(String(posting.book),ctx);
  if(!ledger.groupIds.includes(postingId))return yield* bad("Ledger posting is not published");
  const existing=yield* findTerminalFact(self.engine,p+"SettlementLedgerLink","publication",commitId,ctx);if(existing)return existing.posting===postingId&&existing.reason===reason?existing:yield* Effect.fail(err("IdempotencyMismatch","Settlement ledger association changed"));
  return yield* self.call("SettlementLedgerLink.create",{publication:commitId,posting:postingId,reason},self.clean(ctx));
 });}
}
