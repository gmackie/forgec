import { Effect } from "effect";
import { it, expect } from "vitest";
import { Evidence } from "../src/foundation/evidence.js";
import { Artifacts } from "../src/foundation/artifact.js";
import { localAuthorizer } from "../src/gatekeeper.js";
import { foundation } from "./helpers/foundation.js";
const p="@forgegraph/foundation/evidence/_/", a="@forgegraph/foundation/artifact/_/", d="@fixture/evidence-consumer/_/";
for(const adapter of ['memory','sqlite']) {
 it(`${adapter}: immutable evidence, typed domain satellites, idempotency and confidentiality`,async()=>{
  const f=foundation('evidence',adapter,true);const {call,ctx,engine}=f;
  try {
   const bundle=await call(p+'EvidenceBundle.create',{key:'verification',label:'Private supporting evidence'});
   const source=await call(p+'EvidenceSource.create',{key:'lab',label:'Typed laboratory source'});
   const service=new Evidence(engine);
   const input={bundle:String(bundle.id),source:String(source.id),sourceRecord:'measurement-1',kind:'measurement',observedAt:'2026-01-01T00:00:00Z',provenance:'Instrument run at immutable source revision'};
   const record=await Effect.runPromise(service.record(input,{...ctx,idempotencyKey:'observation-1'}));
   expect(await Effect.runPromise(service.record(input,{...ctx,idempotencyKey:'observation-1'}))).toEqual(record);
   await expect(Effect.runPromise(service.record({...input,kind:'tampered'},{...ctx,idempotencyKey:'observation-1'}))).rejects.toThrow();
   await expect(Effect.runPromise(service.record(input,ctx))).rejects.toThrow();
   for(const [type,payload] of [['DeploymentVerification',{commit:'a'.repeat(40)}],['ManufacturingInspection',{lot:'L001'}],['AgentReview',{agent:'reviewer'}]] as const) {
    expect(await call(d+type+'.create',{evidence:bundle.id,...payload})).toMatchObject({evidence:bundle.id});
   }
   expect(await call(d+'MeasurementEvidence.create',{item:record.id,measuredValue:'12.500',unit:'mm'})).toMatchObject({item:record.id});
   for(const op of ['update','delete'])await expect(call(p+'EvidenceItem.'+op,{id:record.id,patch:{kind:'changed'}})).rejects.toThrow();
   await expect(Effect.runPromise(service.record({...input,sourceRecord:'cross-tenant'},{...ctx,tenant:'other'}))).rejects.toThrow();
   expect(await Effect.runPromise(service.artifact(String(record.id),ctx))).toBeNull();
   engine.gatekeeper.authorizer=localAuthorizer({policies:[],pips:[],epoch:1,knownObligations:[]});
   await expect(Effect.runPromise(service.artifact(String(record.id),ctx))).rejects.toMatchObject({code:'NotFound'});
  } finally {f.close();}
 });
 it(`${adapter}: artifact revisions and provenance stay pinned and mismatched digests fail`,async()=>{
  const f=foundation('evidence',adapter);const {call,ctx,engine,objects}=f;
  try {
   const bundle=await call(p+'EvidenceBundle.create',{key:'build',label:'Build evidence'});
   const source=await call(p+'EvidenceSource.create',{key:'build-server',label:'Build server'});
   const artifact=await call(a+'Artifact.create',{key:'report',label:'Report'});
   const content=await call(a+'ArtifactContent.create',{});
   const upload=await call(a+'ArtifactContent.beginUpload',{id:content.id,expectedVersion:1,mediaType:'text/plain',byteCount:5});
   await objects.simulateUpload((upload.upload as {url:string}).url,new TextEncoder().encode('proof'),'text/plain');
   const sealed=await call(a+'ArtifactContent.finalizeUpload',{id:content.id,expectedVersion:2});
   const revision=await Effect.runPromise(new Artifacts(engine).publish({artifact:String(artifact.id),content:String(content.id),digest:String(sealed.digest)},ctx));
   const input={bundle:String(bundle.id),source:String(source.id),sourceRecord:'build-1',kind:'report',observedAt:'2026-01-01T00:00:00Z',provenance:'Build commit '+ 'b'.repeat(40),revision:String(revision.id),digest:String(revision.digest)};
   await expect(call(p+'EvidenceItem.create',{...input,digest:'sha256:'+'c'.repeat(64)})).rejects.toThrow();
   const service=new Evidence(engine);const item=await Effect.runPromise(service.record(input,ctx));
   expect(await Effect.runPromise(service.artifact(String(item.id),ctx))).toMatchObject({id:revision.id,digest:revision.digest});
   await expect(call(p+'EvidenceItem.create',{...input,sourceRecord:'invalid',observedAt:'yesterday'})).rejects.toThrow();
   await expect(call(a+'ArtifactRevision.delete',{id:revision.id})).rejects.toThrow();
  } finally {f.close();}
 });
}
