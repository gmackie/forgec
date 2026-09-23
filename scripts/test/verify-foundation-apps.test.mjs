import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,rmSync,symlinkSync,mkdirSync,realpathSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
import {validateDescriptor,verifySources,verifyTests,revisionSource,fingerprint,artifactManifest,verifyArtifacts} from '../verify-foundation-apps.mjs';
const descriptor=()=>({version:1,sourceRootEnv:'FORGE_FOUNDATION_BOB_ROOT',test:'test/foundation-app-bob.traces.ts',requiredTests:['actual flow'],sourceRevision:'a'.repeat(40),sourceFiles:[{path:'source.ts',sha256:createHash('sha256').update('actual source').digest('hex')}]});
test('app descriptor pins actual source and explicit required traces',()=>{
 assert.equal(validateDescriptor(descriptor(),'bob').version,1);
 for(const change of [d=>d.sourceFiles[0].path='../escape',d=>d.sourceFiles.push({...d.sourceFiles[0]}),d=>d.sourceRevision='main',d=>d.requiredTests=[],d=>d.test='test/foundation-app-other.traces.ts']){const d=descriptor();change(d);assert.throws(()=>validateDescriptor(d,'bob'));}
});
test('missing, changed or escaping app sources fail closed',()=>{
 const dir=mkdtempSync(join(tmpdir(),'app-sources-')),outside=mkdtempSync(join(tmpdir(),'app-outside-'));
 try{const d=descriptor();assert.throws(()=>verifySources(d,undefined),/Missing/);writeFileSync(join(dir,'source.ts'),'actual source');assert.equal(verifySources(d,dir,()=>Buffer.from('actual source')).length,1);writeFileSync(join(dir,'source.ts'),'changed');assert.throws(()=>verifySources(d,dir,()=>Buffer.from('actual source')),/drift/);rmSync(join(dir,'source.ts'));writeFileSync(join(outside,'source.ts'),'actual source');symlinkSync(join(outside,'source.ts'),join(dir,'source.ts'));assert.throws(()=>verifySources(d,dir,()=>Buffer.from('actual source')),/drift/);}finally{rmSync(dir,{recursive:true,force:true});rmSync(outside,{recursive:true,force:true});}
});
test('application success requires each declared test exactly once and no skip',()=>{
 const good={success:true,numFailedTests:0,numPendingTests:0,numTodoTests:0,testResults:[{assertionResults:[{title:'actual flow',status:'passed'}]}]};
 assert.deepEqual(verifyTests(good,['actual flow']),['actual flow']);
 assert.throws(()=>verifyTests({...good,numPendingTests:1},['actual flow']));
 assert.throws(()=>verifyTests(good,['other']));
 assert.throws(()=>verifyTests({...good,testResults:[{assertionResults:[...good.testResults[0].assertionResults,...good.testResults[0].assertionResults]}]},['actual flow']));
});

test('a matching working file cannot claim an unrelated immutable source revision',()=>{
 const dir=mkdtempSync(join(tmpdir(),'app-revision-'));
 try{
  writeFileSync(join(dir,'source.ts'),'actual source');
  const d=descriptor();let read;
  verifySources(d,dir,(base,revision,path)=>{read={base,revision,path};return Buffer.from('actual source');});
  assert.deepEqual(read,{base:realpathSync(dir),revision:d.sourceRevision,path:'source.ts'});
  assert.throws(()=>verifySources(d,dir,()=>Buffer.from('different historical source')),/revision mismatch/);
  assert.throws(()=>verifySources(d,dir,()=>{throw new Error('revision unavailable');}),/revision unavailable/);
 }finally{rmSync(dir,{recursive:true,force:true});}
});
test('revision reads are read-only and preserve nested application-root paths',()=>{
 const repo=mkdtempSync(join(tmpdir(),'app-vcs-')),nested=join(repo,'nested');mkdirSync(nested);
 try{
  const calls=[];
  const execute=(cmd,args,opts)=>{calls.push({cmd,args,opts});return args.includes('root')?{status:0,stdout:repo+'\n'}:{status:0,stdout:Buffer.from('revision bytes')};};
  assert.equal(revisionSource(nested,'a'.repeat(40),'source.ts',execute).toString(),'revision bytes');
  assert.deepEqual(calls[1].args,['--ignore-working-copy','file','show','-r','a'.repeat(40),'nested/source.ts']);
  assert.equal(calls[1].opts.cwd,realpathSync(repo));
 }finally{rmSync(repo,{recursive:true,force:true});}
});
test('source fingerprints include imported test helpers, local package code and workspace configuration',()=>{
 const repo=mkdtempSync(join(tmpdir(),'app-fingerprint-')),example=join(repo,'examples/app');
 const put=(path,body)=>{const target=join(repo,path);mkdirSync(join(target,'..'),{recursive:true});writeFileSync(target,body);};
 try{
  for(const dir of ['examples/app','packages/runtime/test/helpers','packages/contracts/shared/src','conformance/foundation/apps','crates','scripts'])mkdirSync(join(repo,dir),{recursive:true});
  for(const path of ['packages/runtime/test/trace.ts','package.json','pnpm-workspace.yaml','pnpm-lock.yaml','Cargo.toml','Cargo.lock','tsconfig.base.json'])put(path,'initial');
  let previous=fingerprint(example,'test/trace.ts',repo);
  for(const path of ['packages/runtime/test/helpers/foundation.ts','packages/contracts/shared/src/runtime.ts','packages/runtime/vitest.config.ts','scripts/shared-build.mjs','pnpm-workspace.yaml']){
   put(path,'changed');const next=fingerprint(example,'test/trace.ts',repo);assert.notEqual(next,previous,path);previous=next;
  }
 }finally{rmSync(repo,{recursive:true,force:true});}
});
test('all generated artifacts are deterministic and later mutation is detectable',()=>{
 const root=mkdtempSync(join(tmpdir(),'app-artifacts-')),first=join(root,'first'),second=join(root,'second');
 const put=(dir,path,body)=>{const target=join(dir,path);mkdirSync(join(target,'..'),{recursive:true});writeFileSync(target,body);};
 try{
  for(const path of ['app.json','d1/0001_init.sql','postgres/0001_init.sql','client.ts','source-map.json','openapi.json','api.smithy'])for(const dir of [first,second])put(dir,path,path);
  const before=verifyArtifacts(first,second);assert.equal(before.length,7);
  put(second,'api.smithy','changed');assert.throws(()=>verifyArtifacts(first,second),/Nondeterministic/);
  put(first,'api.smithy','changed');assert.notDeepEqual(verifyArtifacts(first,second),before);
  put(second,'unexpected.txt','new');assert.throws(()=>verifyArtifacts(first,second),/Nondeterministic/);
  rmSync(join(first,'app.json'));assert.throws(()=>artifactManifest(first),/Missing generated/);
 }finally{rmSync(root,{recursive:true,force:true});}
});
test('Git-only application revisions use the exact immutable blob and fail unavailable reads',()=>{
 const repo=mkdtempSync(join(tmpdir(),'app-git-'));
 try{
  const calls=[];
  const execute=(cmd,args)=>{calls.push([cmd,args]);if(cmd==='jj')return {status:1,stdout:''};if(args[0]==='rev-parse')return {status:0,stdout:repo+'\n'};return {status:0,stdout:Buffer.from('git bytes')};};
  assert.equal(revisionSource(repo,'b'.repeat(40),'source.ts',execute).toString(),'git bytes');
  assert.deepEqual(calls.at(-1),['git',['show','b'.repeat(40)+':source.ts']]);
  assert.throws(()=>revisionSource(repo,'b'.repeat(40),'source.ts',(cmd,args)=>args[0]==='show'?{status:128,stdout:''}:execute(cmd,args)),/unavailable/);
 }finally{rmSync(repo,{recursive:true,force:true});}
});
