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
   engine.gatekeeper.authorizer=localAuthorizer({policies:[{id:'evidence-only',actions:[p+'EvidenceItem.*'],requires:[],where:[]}],pips:[],epoch:2,knownObligations:[]});
   await expect(Effect.runPromise(service.artifact(String(item.id),ctx))).rejects.toThrow();
  } finally {f.close();}
 });
}

for (const adapter of ['memory', 'sqlite']) {
 it(`${adapter}: seals pin bounded typed membership and successors preserve old evidence`, async () => {
  const f=foundation('evidence',adapter);const {call,ctx,engine}=f;
  try {
   const service=new Evidence(engine);
   const bundle=await call(p+'EvidenceBundle.create',{key:'sealed',label:'Selected support'});
   const other=await call(p+'EvidenceBundle.create',{key:'other',label:'Other support'});
   const source=await call(p+'EvidenceSource.create',{key:'instrument',label:'Instrument'});
   const input={bundle:String(bundle.id),source:String(source.id),sourceRecord:'one',kind:'measurement',observedAt:'2026-01-01T00:00:00Z',provenance:'Typed source instrument, recorded separately from observation time'};
   const first=await Effect.runPromise(service.record(input,ctx));
   const head=await Effect.runPromise(service.member(String(bundle.id),String(first.id),null,ctx));
   await expect(Effect.runPromise(service.sealedItems(String(bundle.id),ctx))).rejects.toMatchObject({code:'InvalidTransition'});
   await expect(call(p+'EvidenceMember.create',{bundle:other.id,item:first.id,next:null,depth:1})).rejects.toThrow();
   await expect(call(p+'EvidenceMember.create',{bundle:bundle.id,item:first.id,next:head.id,depth:1})).rejects.toThrow();
   await expect(call(p+'EvidenceMember.create',{bundle:bundle.id,item:first.id,next:null,depth:129})).rejects.toThrow();
   await expect(call(p+'EvidenceSeal.create',{bundle:other.id,head:head.id,recordedBy:ctx.actor})).rejects.toThrow();
   const seals=await Promise.allSettled(Array.from({length:6},()=>Effect.runPromise(service.seal(String(bundle.id),String(head.id),ctx))));
   expect(seals.filter(x=>x.status==='fulfilled')).toHaveLength(1);
   const seal=(seals.find(x=>x.status==='fulfilled') as PromiseFulfilledResult<Record<string,unknown>>).value;
   // Candidates and new chains after sealing cannot change authoritative support.
   const later=await Effect.runPromise(service.record({...input,sourceRecord:'later'},ctx));
   await Effect.runPromise(service.member(String(bundle.id),String(later.id),String(head.id),ctx));
   expect((await Effect.runPromise(service.sealedItems(String(bundle.id),ctx))).map(x=>x.id)).toEqual([first.id]);
   expect((await Effect.runPromise(service.items(String(bundle.id),ctx))).items).toHaveLength(2);
   const next=await Effect.runPromise(service.successor(String(seal.id),'corrected','Corrected support',ctx));
   expect(next.predecessor).toBe(seal.id);
   const correction=await Effect.runPromise(service.record({...input,bundle:String(next.id),sourceRecord:'correction'},ctx));
   const correctedHead=await Effect.runPromise(service.member(String(next.id),String(correction.id),null,ctx));
   await Effect.runPromise(service.seal(String(next.id),String(correctedHead.id),ctx));
   expect((await Effect.runPromise(service.sealedItems(String(next.id),ctx))).map(x=>x.id)).toEqual([correction.id]);
   expect((await Effect.runPromise(service.sealedItems(String(bundle.id),ctx))).map(x=>x.id)).toEqual([first.id]);
   for(const [resource,id] of [['EvidenceSeal',seal.id],['EvidenceMember',head.id],['EvidenceBundle',bundle.id]]) {
    await expect(call(p+resource+'.update',{id,patch:{head:null}})).rejects.toThrow();
    await expect(call(p+resource+'.delete',{id})).rejects.toThrow();
   }
   await expect(Effect.runPromise(service.seal(String(other.id),String(head.id),{...ctx,tenant:'foreign'}))).rejects.toThrow();
   await Effect.runPromise(service.seal(String(other.id),null,ctx));
   expect(await Effect.runPromise(service.sealedItems(String(other.id),ctx))).toEqual([]);
  } finally {f.close();}
 });
 it(`${adapter}: classified provenance retains metadata while every sealed read enforces independent access policies`,async()=>{
  const f=foundation('evidence',adapter);const {call,ctx,engine}=f;
  try {
   const service=new Evidence(engine);
   expect(engine.model.dataClasses).toContainEqual(expect.objectContaining({id:p+'EvidenceNarrative',extends:'data.communication.content'}));
   expect(engine.model.resource(p+'EvidenceItem').fields.find(field=>field.name==='provenance')?.type).toMatchObject({dataClass:p+'EvidenceNarrative'});
   const bundle=await call(p+'EvidenceBundle.create',{key:'private',label:'Private support'});
   const source=await call(p+'EvidenceSource.create',{key:'clinical',label:'Clinical source'});
   const item=await Effect.runPromise(service.record({bundle:String(bundle.id),source:String(source.id),sourceRecord:'observation',kind:'measurement',observedAt:'2026-01-01T00:00:00Z',provenance:'Confidential source narrative'},ctx));
   const member=await Effect.runPromise(service.member(String(bundle.id),String(item.id),null,ctx));
   await Effect.runPromise(service.seal(String(bundle.id),String(member.id),ctx));
   const resources=['EvidenceBundle','EvidenceSeal','EvidenceMember','EvidenceItem','EvidenceSource'];
   for(const hidden of resources) {
    engine.gatekeeper.authorizer=localAuthorizer({policies:resources.filter(name=>name!==hidden).map(name=>({id:name,actions:[p+name+'.*'],requires:[],where:[]})),pips:[],epoch:resources.indexOf(hidden)+1,knownObligations:[]});
    await expect(Effect.runPromise(service.sealedItems(String(bundle.id),ctx))).rejects.toThrow();
   }
   // A classification annotates meaning; it is not itself an access grant.
   engine.gatekeeper.authorizer=localAuthorizer({policies:[],pips:[],epoch:99,knownObligations:[]});
   await expect(Effect.runPromise(service.items(String(bundle.id),ctx))).rejects.toThrow();
   expect((await call(p+'EvidenceItem.list.byBundle',{params:{bundle:bundle.id}})).items).toEqual([]);
  }finally{f.close();}
 });
}
