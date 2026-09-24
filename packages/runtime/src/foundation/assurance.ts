import { Attestations } from "./attestation.js";
import { Evaluations } from "./evaluation.js";
import { Effect } from "effect";
import type { Engine, CallContext } from "../engine.js";
import type { Wire } from "../decode.js";
import { err, type ForgeError } from "../errors.js";
import { findTerminalFact } from "./facts.js";
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
 issue(input:{finding:string;attestation:string;finish:string;run:string},ctx:CallContext):Effect.Effect<Wire,ForgeError>{const self=this;return Effect.gen(function*(){
  yield* self.support(input,ctx);
  return yield* self.engine.call(p+'FindingAttestation.create',input,ctx);
 });}
 end(id:string,effectiveAt:string,reason:string,ctx:CallContext,replacement?:string){const self=this;return Effect.gen(function*(){
  const row=yield* self.engine.call(p+'FindingAttestation.get',{id},ctx);
  const next=replacement?yield* self.engine.call(p+'FindingAttestation.get',{id:replacement},ctx):null;
  if(next&&next.finding!==row.finding)return yield* Effect.fail(err('ValidationFailed','Replacement must concern the same finding'));
  return yield* new Attestations(self.engine).end(String(row.attestation),effectiveAt,reason,ctx,next?String(next.attestation):undefined);
 });}
 current(id:string,at:string,ctx:CallContext):Effect.Effect<Wire|null,ForgeError>{const self=this;return Effect.gen(function*(){
  const row=yield* self.engine.call(p+'FindingAttestation.get',{id},ctx);
  const assertion=yield* new Attestations(self.engine).current(String(row.attestation),at,ctx);
  if(!assertion)return null;
  yield* self.support(row,ctx);
  return {...assertion,...row};
 });}
 private support(record:Wire,ctx:CallContext):Effect.Effect<void,ForgeError>{const self=this;return Effect.gen(function*(){
  yield* self.engine.call(p+'Finding.get',{id:record.finding},ctx);
  yield* self.engine.call(evaluation+'EvaluationRun.get',{id:record.run},ctx);
  yield* new Evaluations(self.engine).result(String(record.finish),ctx);
  yield* new Attestations(self.engine).read(String(record.attestation),ctx);
 });}
}
