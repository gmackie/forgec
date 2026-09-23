import { Effect } from "effect";
import type { Engine, CallContext } from "../engine.js";
import type { Wire } from "../decode.js";
import { err, type ForgeError } from "../errors.js";
import { Clock } from "../services.js";
import { toMinor } from "../codecs.js";
import { Decisions } from "./decision.js";
import { AgreementCatalog } from "./agreement-catalog.js";
import { Evidence } from "./evidence.js";
import { findTerminalFact } from "./facts.js";
const p="@forgegraph/foundation/selection/_/",e="@forgegraph/foundation/evaluation/_/",part="@forgegraph/foundation/participation/_/";
const bad=(detail:string)=>Effect.fail(err("ValidationFailed",detail));
/** Explicit, bounded scored shortlists. Domain applications own submissions and
 * scoring policy; Decision owns the vote and Agreement owns accepted terms. */
export class Selection{
 constructor(private readonly engine:Engine){}
 private call(op:string,input:Wire,ctx:CallContext):Effect.Effect<Wire,ForgeError>{return this.engine.call(p+op,input,ctx);}
 private clean(ctx:CallContext){const{idempotencyKey:_receipt,...rest}=ctx;return rest;}
 private now(){return Effect.gen(function*(){return(yield* Clock).now();}).pipe(Effect.provide(this.engine.layer));}
 private solicitation(id:string,ctx:CallContext){const self=this;return Effect.gen(function*(){const row=yield* self.call("Solicitation.get",{id},ctx);for(const field of ["criteria","terms"])yield* self.engine.call("@forgegraph/foundation/specification/_/SpecificationPin.get",{id:row[field]},ctx);yield* self.engine.call(part+"ParticipationSet.get",{id:row.participants},ctx);return row;});}
 private submission(id:string,ctx:CallContext){const self=this;return Effect.gen(function*(){
  const row=yield* self.call("Submission.get",{id},ctx),solicitation=yield* self.solicitation(String(row.solicitation),ctx),member=yield* self.engine.call(part+"Participation.get",{id:row.participant},ctx);
  const end=yield* findTerminalFact(self.engine,part+"ParticipationEnd","participation",member.id,ctx);
  if(member.participationSet!==solicitation.participants||String(member.validFrom)>String(row.createdAt)||member.validUntil!=null&&String(member.validUntil)<=String(row.createdAt)||end&&String(end.effectiveAt)<=String(row.createdAt))return yield* bad("Submitter was ineligible at submission");
  yield* self.engine.call("@forgegraph/foundation/party/_/Party.get",{id:member.participant},ctx);yield* self.engine.call(part+"ParticipationRole.get",{id:member.role},ctx);yield* self.engine.call(e+"EvaluationSet.get",{id:row.evaluationSet},ctx);
  return{row,solicitation,member};
 });}
 submit(input:{solicitation:string;key:string;participant:string;evaluationSet:string},ctx:CallContext):Effect.Effect<Wire,ForgeError>{const self=this;return Effect.gen(function*(){
  const solicitation=yield* self.solicitation(input.solicitation,ctx),member=yield* self.engine.call(part+"Participation.get",{id:input.participant},ctx),now=yield* self.now();
  const end=yield* findTerminalFact(self.engine,part+"ParticipationEnd","participation",member.id,ctx);
  if(member.participationSet!==solicitation.participants||String(member.validFrom)>now||member.validUntil!=null&&String(member.validUntil)<=now||end&&String(end.effectiveAt)<=now)return yield* bad("Submitter is ineligible");
  yield* self.engine.call(e+"EvaluationSet.get",{id:input.evaluationSet},ctx);
  yield* self.engine.call("@forgegraph/foundation/party/_/Party.get",{id:member.participant},ctx);
  yield* self.engine.call(part+"ParticipationRole.get",{id:member.role},ctx);
  return yield* self.call("Submission.create",input,self.clean(ctx));
 });}
 private score(id:string,ctx:CallContext){return this.call("SubmissionScore.get",{id},ctx).pipe(Effect.flatMap(row=>this.validateScore(row,ctx)));}
 private validateScore(row:Wire,ctx:CallContext){const self=this;return Effect.gen(function*(){
  const submission=yield* self.submission(String(row.submission),ctx),finish=yield* self.engine.call(e+"EvaluationFinish.get",{id:row.finish},ctx),run=yield* self.engine.call(e+"EvaluationRun.get",{id:finish.run},ctx);
  if(run.evaluationSet!==submission.row.evaluationSet||run.definition!==submission.solicitation.criteria||finish.outcome!=="Completed"||finish.start==null)return yield* bad("Scoring requires completed evaluation against pinned criteria");
  const start=yield* self.engine.call(e+"EvaluationStart.get",{id:finish.start},ctx);
  if(start.run!==run.id||String(finish.finishedAt)<String(start.startedAt))return yield* bad("Invalid evaluation chronology");
  yield* self.engine.call(e+"EvaluationExecutor.get",{id:run.executor},ctx);
  if(finish.support!=null){const seal=yield* self.engine.call("@forgegraph/foundation/evidence/_/EvidenceSeal.get",{id:finish.support},ctx);yield* new Evidence(self.engine).sealedItems(String(seal.bundle),ctx);}
  return{row,submission:submission.row,solicitation:submission.solicitation,member:submission.member};
 });}
 scoreSubmission(submission:string,finish:string,score:string,rationale:string,ctx:CallContext):Effect.Effect<Wire,ForgeError>{const self=this;return Effect.gen(function*(){
  yield* self.submission(submission,ctx);
  yield* self.validateScore({submission,finish,score,rationale},ctx);
  return yield* self.call("SubmissionScore.create",{submission,finish,score,rationale},self.clean(ctx));
 });}
 shortlist(solicitation:string,decisionCase:string,scores:readonly string[],ctx:CallContext):Effect.Effect<Wire,ForgeError>{const self=this;return Effect.gen(function*(){
  if(!scores.length||scores.length>16||new Set(scores).size!==scores.length)return yield* bad("Shortlist requires 1..16 distinct scored submissions");
  const request=yield* self.solicitation(solicitation,ctx);if((yield* self.now())<String(request.closesAt))return yield* bad("Shortlist closes only after submission deadline");
  const decision=yield* new Decisions(self.engine).state(decisionCase,ctx);if(decision.events.length||decision.terminal||decision.options.length!==scores.length)return yield* bad("Bind a fresh decision with one option per shortlisted submission");
  const ranked: {row:Wire;submission:Wire;solicitation:Wire;member:Wire}[]=[];for(const id of scores){const fact=yield* self.score(id,ctx);if(fact.solicitation.id!==solicitation)return yield* bad("Foreign shortlist submission");ranked.push(fact);}
  ranked.sort((a,b)=>{const x=toMinor(String(a.row.score),6),y=toMinor(String(b.row.score),6);return x>y?-1:x<y?1:String(a.submission.key)<String(b.submission.key)?-1:1;});
  if(request.tiePolicy==="reject"&&ranked.some((r,i)=>i>0&&r.row.score===ranked[i-1]!.row.score))return yield* bad("Tied scores require an explicit tiebreak policy");
  let head:string|null=null;
  for(let i=ranked.length-1;i>=0;i--){const node:Wire=yield* self.call("ShortlistMember.create",{score:ranked[i]!.row.id,option:decision.options[i]!.id,next:head},self.clean(ctx));head=String(node.id);}
  return yield* self.call("SelectionShortlist.create",{solicitation,decisionCase,head},self.clean(ctx));
 });}
 private readShortlist(shortlistId:string,ctx:CallContext){const self=this;return Effect.gen(function*(){
  const shortlist=yield* self.call("SelectionShortlist.get",{id:shortlistId},ctx),solicitation=yield* self.solicitation(String(shortlist.solicitation),ctx),decision=yield* new Decisions(self.engine).state(String(shortlist.decisionCase),ctx);
  if(String(shortlist.createdAt)<String(solicitation.closesAt)||decision.events[0]&&String(shortlist.createdAt)>String(decision.events[0].createdAt))return yield* bad("Shortlist must bind after closing and before decision responses");
  const rows: {score:Wire;submission:Wire;member:Wire;option:Wire}[]=[],seen=new Set<string>();let id=String(shortlist.head);
  while(id){if(rows.length>=16||seen.has(id))return yield* bad("Invalid shortlist chain");seen.add(id);const node=yield* self.call("ShortlistMember.get",{id},ctx),score=yield* self.score(String(node.score),ctx),option=decision.options[rows.length];
   if(score.solicitation.id!==solicitation.id||!option||node.option!==option.id||rows.some(r=>r.submission.id===score.submission.id))return yield* bad("Shortlist option/submission binding mismatch");
   rows.push({score:score.row,submission:score.submission,member:score.member,option});id=node.next==null?"":String(node.next);
  }
  if(rows.length!==decision.options.length)return yield* bad("Incomplete shortlist");
  for(let i=1;i<rows.length;i++){const previous=rows[i-1]!,current=rows[i]!,x=toMinor(String(previous.score.score),6),y=toMinor(String(current.score.score),6);if(x<y||x===y&&(solicitation.tiePolicy==="reject"||String(previous.submission.key)>=String(current.submission.key)))return yield* bad("Invalid shortlist ranking");}
  return{shortlist,solicitation,decision,rows};
 });}
 award(shortlist:string,agreement:string,ctx:CallContext):Effect.Effect<Wire,ForgeError>{const self=this;return Effect.gen(function*(){
  const state=yield* self.readShortlist(shortlist,ctx),winner=state.rows.find(row=>row.option.id===state.decision.outcome?.selected);if(!winner||!state.decision.outcome)return yield* bad("Decision has no validated winning submission");
  const contract=yield* new AgreementCatalog(self.engine).state(agreement,yield* self.now(),ctx);
  if(!contract.issuance||contract.agreement.supplier!==winner.member.participant||contract.agreement.terms!==state.solicitation.terms)return yield* bad("Agreement must be issued to winning supplier with pinned terms");
  const body={solicitation:state.solicitation.id,shortlist,submission:winner.score.submission,outcome:state.decision.outcome.id,agreement};
  const existing=yield* findTerminalFact(self.engine,p+"SelectionAward","solicitation",state.solicitation.id,ctx);if(existing)return Object.entries(body).every(([k,v])=>existing[k]===v)?existing:yield* Effect.fail(err("IdempotencyMismatch","Solicitation already awarded differently"));
  return yield* self.call("SelectionAward.create",body,self.clean(ctx));
 });}
 inspectAward(solicitation:string,ctx:CallContext):Effect.Effect<Wire,ForgeError>{const self=this;return Effect.gen(function*(){const award=yield* findTerminalFact(self.engine,p+"SelectionAward","solicitation",solicitation,ctx);if(!award)return yield* bad("Solicitation has no award");return yield* self.award(String(award.shortlist),String(award.agreement),ctx);});}
}
