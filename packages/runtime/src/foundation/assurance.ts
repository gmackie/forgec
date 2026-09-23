import { Effect } from "effect";
import type { Engine, CallContext } from "../engine.js";
import type { Wire } from "../decode.js";
import { decodeDatetime } from "../codecs.js";
import { err, type ForgeError } from "../errors.js";
import { findTerminalFact } from "./facts.js";
import { Evidence } from "./evidence.js";
const p="@forgegraph/foundation/assurance/_/", evaluation="@forgegraph/foundation/evaluation/_/";
export type DispositionKind="Remediate"|"Accepted"|"FalsePositive"|"Waived"|"Deferred";
export class Assurance {
 constructor(private readonly engine:Engine){}
 disposition(finding:string,kind:DispositionKind,reason:string,ctx:CallContext){return this.engine.call(p+'Disposition.create',{finding,kind,reason,recordedBy:ctx.actor},ctx);}
 findingPhase(finding:string,ctx:CallContext):Effect.Effect<string,ForgeError>{const self=this;return Effect.gen(function*(){
  yield* self.engine.call(p+'Finding.get',{id:finding},ctx);
  const closure=yield* findTerminalFact(self.engine,p+'FindingClosure','finding',finding,ctx);
  if(closure)return 'Closed';
  const disposition=yield* findTerminalFact(self.engine,p+'Disposition','finding',finding,ctx);
  return disposition?String(disposition.kind):'Open';
 });}
 remediationPhase(remediation:string,ctx:CallContext):Effect.Effect<string,ForgeError>{const self=this;return Effect.gen(function*(){
  yield* self.engine.call(p+'Remediation.get',{id:remediation},ctx);
  const finish=yield* findTerminalFact(self.engine,p+'RemediationFinish','remediation',remediation,ctx);
  return finish?String(finish.outcome):'Planned';
 });}
 issue(input:{finding:string;issuer:string;issuerRecord:string;specification:string;finish:string;run:string;support:string;artifact?:string;conclusion:string;validFrom:string;validUntil?:string},ctx:CallContext):Effect.Effect<Wire,ForgeError>{const self=this;return Effect.gen(function*(){
  yield* self.support(input,ctx);
  return yield* self.engine.call(p+'Attestation.create',{...input,artifact:input.artifact??null,validUntil:input.validUntil??null},ctx);
 });}
 end(attestation:string,effectiveAt:string,reason:string,ctx:CallContext,replacement?:string){return this.engine.call(p+'AttestationEnd.create',{attestation,effectiveAt,reason,replacement:replacement??null},ctx);}
 current(attestation:string,at:string,ctx:CallContext):Effect.Effect<Wire|null,ForgeError>{const self=this;return Effect.gen(function*(){
  const instant=yield* Effect.try({try:()=>Date.parse(decodeDatetime(at)),catch:()=>err('ValidationFailed','Invalid attestation instant')});
  const record=yield* self.engine.call(p+'Attestation.get',{id:attestation},ctx);
  if(instant<Date.parse(String(record.validFrom))||record.validUntil!=null&&instant>=Date.parse(String(record.validUntil)))return null;
  const ended=yield* findTerminalFact(self.engine,p+'AttestationEnd','attestation',attestation,ctx);
  if(ended&&instant>=Date.parse(String(ended.effectiveAt)))return null;
  yield* self.support(record,ctx);
  return record;
 });}
 private support(record:Wire,ctx:CallContext):Effect.Effect<void,ForgeError>{const self=this;return Effect.gen(function*(){
  yield* self.engine.call(p+'Finding.get',{id:record.finding},ctx);
  yield* self.engine.call(p+'AssuranceIssuer.get',{id:record.issuer},ctx);
  yield* self.engine.call('@forgegraph/foundation/specification/_/SpecificationPin.get',{id:record.specification},ctx);
  yield* self.engine.call(evaluation+'EvaluationRun.get',{id:record.run},ctx);
  yield* self.engine.call(evaluation+'EvaluationFinish.get',{id:record.finish},ctx);
  const seal=yield* self.engine.call('@forgegraph/foundation/evidence/_/EvidenceSeal.get',{id:record.support},ctx);
  yield* new Evidence(self.engine).sealedItems(String(seal.bundle),ctx);
  if(record.artifact!=null)yield* self.engine.call('@forgegraph/foundation/artifact/_/ArtifactRevision.get',{id:record.artifact},ctx);
 });}
}
