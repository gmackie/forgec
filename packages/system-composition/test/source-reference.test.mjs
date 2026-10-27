import test from 'node:test';import assert from 'node:assert/strict';
import {SourceReferenceResolver} from '../src/source-reference.mjs';
const anchor={id:'anchor-1',kind:'configuration',tenant:'t1',providerVerified:true,origin:{repositoryId:'repo1',revision:'original',path:'infra/worker.ts',startLine:10,endLine:18,contentHash:'sha256-old'},semanticId:'urn:cdk:ApiWorker'};
function fixture({results=[{path:'infra/api/worker.ts',startLine:24,endLine:32,semanticId:'urn:cdk:ApiWorker'}],indexComplete=true,authorize=async()=>true}={}) {
 return new SourceReferenceResolver({authorize,
  getAnchor:async()=>anchor,
  getSnapshot:async({repositoryId,revision})=>({tenant:'t1',providerVerified:true,repositoryId,revision,indexComplete}),
  resolveSemantic:async({targetRevision})=>results.map(x=>({repositoryId:'repo1',revision:targetRevision,providerVerified:true,...x})),
 });
}
const req={tenant:'t1',actor:'alice',anchorId:'anchor-1',targetRevision:'new'};
test('pinned source remains exact and a unique semantic relocation is advisory',async()=>{
 assert.equal((await fixture().resolve({...req,targetRevision:'original'})).status,'exact');
 const r=await fixture().resolve(req);assert.equal(r.status,'relocated');assert.equal(r.location.path,'infra/api/worker.ts');
});
test('renamed/duplicated resource anchors are ambiguous rather than guessed',async()=>{
 const duplicate=[{path:'a.ts',startLine:2,endLine:4,semanticId:anchor.semanticId},{path:'b.ts',startLine:6,endLine:9,semanticId:anchor.semanticId}];
 assert.equal((await fixture({results:duplicate}).resolve(req)).status,'ambiguous');
 assert.equal((await fixture({results:[],indexComplete:false}).resolve(req)).status,'unavailable');
 assert.equal((await fixture({results:[],indexComplete:true}).resolve(req)).status,'deleted-or-rewritten');
});
test('source anchor access is independently checked from task visibility',async()=>{
 await assert.rejects(()=>fixture({authorize:async()=>false}).resolve(req),/not authorized/);
 await assert.rejects(()=>fixture({results:[{path:'a.ts',startLine:2,endLine:4,repositoryId:'other',semanticId:anchor.semanticId}]}).resolve(req),/untrusted/);
});
