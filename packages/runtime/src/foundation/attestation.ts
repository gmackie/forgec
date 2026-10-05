import { Effect } from "effect";
import type { Engine, CallContext } from "../engine.js";
import type { Wire } from "../decode.js";
import { decodeDatetime } from "../codecs.js";
import { err, type ForgeError } from "../errors.js";
import { Evidence } from "./evidence.js";
import { findTerminalFact } from "./facts.js";
const p = "@forgegraph/foundation/attestation/_/";
export interface AttestationInput {
 issuer: string; subject: string; issuerRecord: string; specification: string;
 issuedAt: string; validFrom: string; validUntil?: string;
 conclusion: string; source: string; support?: string; proof?: string;
}
/** Assertions are independent of evaluations, findings and cryptographic formats. */
export class Attestations {
 constructor(private readonly engine: Engine) {}
 private dependencies(row: Wire, ctx: CallContext): Effect.Effect<void, ForgeError> {
  const self=this;return Effect.gen(function*(){
   for(const id of [row.issuer,row.subject])yield* self.engine.call(p+'AttestationSubject.get',{id},ctx);
   yield* self.engine.call('@forgegraph/foundation/specification/_/SpecificationPin.get',{id:row.specification},ctx);
   if(row.support!=null){const seal=yield* self.engine.call('@forgegraph/foundation/evidence/_/EvidenceSeal.get',{id:row.support},ctx);yield* new Evidence(self.engine).sealedItems(String(seal.bundle),ctx);}
   if(row.proof!=null)yield* self.engine.call('@forgegraph/foundation/artifact/_/ArtifactRevision.get',{id:row.proof},ctx);
  });
 }
 issue(input: AttestationInput,ctx:CallContext) {
  const self=this;return Effect.gen(function*(){
   const body={...input,validUntil:input.validUntil??null,support:input.support??null,proof:input.proof??null};
   yield* self.dependencies(body,ctx);
   return yield* self.engine.call(p+'Attestation.create',body,ctx);
  });
 }
 end(attestation:string,effectiveAt:string,reason:string,ctx:CallContext,replacement?:string) {
  const self=this;return Effect.gen(function*(){
   yield* self.read(attestation,ctx);if(replacement)yield* self.read(replacement,ctx);
   return yield* self.engine.call(p+'AttestationEnd.create',{attestation,effectiveAt,reason,recordedBy:ctx.actor,replacement:replacement??null},ctx);
  });
 }
 read(id:string,ctx:CallContext) {
  const self=this;return Effect.gen(function*(){const row=yield* self.engine.call(p+'Attestation.get',{id},ctx);yield* self.dependencies(row,ctx);return row;});
 }
 current(id:string,at:string,ctx:CallContext) {
  const self=this;return Effect.gen(function*(){
   const instant=yield* Effect.try({try:()=>Date.parse(decodeDatetime(at)),catch:()=>err('ValidationFailed','Invalid attestation instant')});
   const row=yield* self.read(id,ctx),end=yield* findTerminalFact(self.engine,p+'AttestationEnd','attestation',id,ctx);
   return instant<Date.parse(String(row.validFrom))||row.validUntil!=null&&instant>=Date.parse(String(row.validUntil))||end&&instant>=Date.parse(String(end.effectiveAt))?null:row;
  });
 }
 qualification(link:string,at:string,ctx:CallContext) {
  const self=this;return Effect.gen(function*(){
   const row=yield* self.engine.call(p+'QualificationAttestation.get',{id:link},ctx);
   const qp='@forgegraph/foundation/qualification/_/';
   const qualification=yield* self.engine.call(qp+'Qualification.get',{id:row.qualification},ctx);
   yield* self.engine.call(qp+'QualificationDefinition.get',{id:row.definition},ctx);
   for(const [resource,id] of [['AttestationQualificationSubject',row.subject],['AttestationPartySubject',row.issuer]])yield* self.engine.call(p+resource+'.get',{id},ctx);
   const revoked=yield* findTerminalFact(self.engine,qp+'QualificationRevocation','qualification',qualification.id,ctx);
   const attestation=yield* self.current(String(row.attestation),at,ctx),instant=Date.parse(decodeDatetime(at));
   return {qualification,attestation,valid:!!attestation&&instant>=Date.parse(String(qualification.issuedAt))&&(qualification.expiresAt==null||instant<Date.parse(String(qualification.expiresAt)))&&(!revoked||instant<Date.parse(String(revoked.effectiveAt)))};
  });
 }
}
