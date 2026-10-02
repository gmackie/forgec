import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,rmSync,readFileSync,writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { exportHistory,restoreHistory,inventoryHistory } from '../artifact-history.mjs';
test('exports and restores exact merge ancestry, refs, binary trees and later rollback writes',async t=>{
 const root=mkdtempSync(join(tmpdir(),'forge-history-'));t.after(()=>rmSync(root,{recursive:true,force:true}));const source=join(root,'source');
 const git=(dir,args,input)=>execFileSync('git',['-C',dir,...args],{input,encoding:'utf8',env:{...process.env,GIT_CONFIG_GLOBAL:'/dev/null',GIT_CONFIG_NOSYSTEM:'1',GIT_AUTHOR_NAME:'Fixture',GIT_AUTHOR_EMAIL:'test@example.invalid',GIT_COMMITTER_NAME:'Fixture',GIT_COMMITTER_EMAIL:'test@example.invalid'},stdio:['pipe','pipe','pipe']}).trim();
 git(root,['init','--bare','source']);const blob=git(source,['hash-object','-w','--stdin'],Buffer.from([0,128,255]));const tree=git(source,['mktree'],`100755 blob ${blob}\trun\n`);
 const commit=(parents,text)=>git(source,['commit-tree',tree,...parents.flatMap(p=>['-p',p])],text+'\n');
 const a=commit([],'root'),b=commit([a],'left'),c=commit([a],'right'),m=commit([b,c],'merge');git(source,['update-ref','refs/heads/main',m]);git(source,['update-ref','refs/heads/draft',c]);git(source,['symbolic-ref','HEAD','refs/heads/main']);
 const bundle=join(root,'history.bundle');const manifest=await exportHistory(source,bundle);const restored=join(root,'restored');await restoreHistory(bundle,restored,manifest);assert.deepEqual(await inventoryHistory(restored),manifest.inventory);
 const post=git(restored,['commit-tree',tree,'-p',m],'post-cutover\n');git(restored,['update-ref','refs/heads/main',post]);const rollback=join(root,'rollback.bundle'),next=await exportHistory(restored,rollback);await restoreHistory(rollback,join(root,'rollback'),next);assert.equal(git(join(root,'rollback'),['rev-parse','main']),post);
 const damaged=join(root,'damaged.bundle');writeFileSync(damaged,readFileSync(bundle).subarray(0,100));await assert.rejects(restoreHistory(damaged,join(root,'bad'),manifest),/digest/);
 await assert.rejects(restoreHistory(bundle,source,manifest),/exist/);
});

test('refuses unreferenced commits and external LFS or submodule payloads', async t => {
 const root=mkdtempSync(join(tmpdir(),'forge-history-refusal-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
 const git=(dir,args,input)=>execFileSync('git',['-C',dir,...args],{input,encoding:'utf8',env:{...process.env,GIT_CONFIG_GLOBAL:'/dev/null',GIT_CONFIG_NOSYSTEM:'1',GIT_AUTHOR_NAME:'Fixture',GIT_AUTHOR_EMAIL:'test@example.invalid',GIT_COMMITTER_NAME:'Fixture',GIT_COMMITTER_EMAIL:'test@example.invalid'},stdio:['pipe','pipe','pipe']}).trim();
 git(root,['init','--bare','source']);const source=join(root,'source');
 const blob=git(source,['hash-object','-w','--stdin'],'hello');
 const tree=git(source,['mktree'],`100644 blob ${blob}\tfile\n`);
 const first=git(source,['commit-tree',tree],'root\n');git(source,['update-ref','refs/heads/main',first]);git(source,['symbolic-ref','HEAD','refs/heads/main']);
 const dangling=git(source,['commit-tree',tree,'-p',first],'unpublished\n');
 await assert.rejects(exportHistory(source,join(root,'unpublished.bundle')),/Unreferenced commits/);
 git(source,['update-ref','refs/heads/retained',dangling]);
 await exportHistory(source,join(root,'retained.bundle'));
 const lfs=git(source,['hash-object','-w','--stdin'],'version https://git-lfs.github.com/spec/v1\noid sha256:'+'a'.repeat(64)+'\nsize 42\n');
 const lfsTree=git(source,['mktree'],`100644 blob ${lfs}\tlarge\n`);
 const lfsCommit=git(source,['commit-tree',lfsTree,'-p',first],'lfs\n');git(source,['update-ref','refs/heads/lfs',lfsCommit]);
 await assert.rejects(exportHistory(source,join(root,'lfs.bundle')),/LFS payload inventory/);
 // Separate repository keeps rejected LFS history out of the submodule case.
 git(root,['init','--bare','submodule']);const sub=join(root,'submodule');
 const subTree=git(sub,['mktree'],`160000 commit ${first}\tnested\n`);
 const subCommit=git(sub,['commit-tree',subTree],'submodule\n');git(sub,['update-ref','refs/heads/main',subCommit]);git(sub,['symbolic-ref','HEAD','refs/heads/main']);
 await assert.rejects(exportHistory(sub,join(root,'submodule.bundle')),/Submodule inventory/);
});
