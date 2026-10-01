import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { expect, it } from 'vitest';
import { VersionedArtifactReader } from '../src/versioned-artifacts.js';
import { cloudflareArtifactsReader } from '../src/adapters/cloudflare-artifacts.js';

it('reads real Git merge ancestry and pinned binary bytes through the binding contract',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'forge-artifact-read-'));
  const git=(args:string[],input?:string|Uint8Array)=>new Promise<Buffer>((resolve,reject)=>{
    const child=execFile('git',['--no-replace-objects','-C',dir,...args],{encoding:'buffer',env:{...process.env,GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null',GIT_AUTHOR_NAME:'Fixture',GIT_AUTHOR_EMAIL:'fixture@example.invalid',GIT_COMMITTER_NAME:'Fixture',GIT_COMMITTER_EMAIL:'fixture@example.invalid'}},(error,stdout)=>error?reject(error):resolve(stdout));
    child.stdin!.on('error',reject);child.stdin!.end(input);
  });
  const text=async(args:string[],input?:string|Uint8Array)=>(await git(args,input)).toString('utf8').trim();
  try{
    await git(['init','--bare']);const bytes=new Uint8Array([0,1,2,128,255]);
    const blob=await text(['hash-object','-w','--stdin'],bytes);
    const tree=await text(['mktree'],`100644 blob ${blob}\tdata.bin\n`);
    const commit=(parents:string[],message:string)=>text(['commit-tree',tree,...parents.flatMap(p=>['-p',p])],message+'\n');
    const root=await commit([],'root'),left=await commit([root],'left'),right=await commit([root],'right'),merge=await commit([left,right],'merge');
    await git(['update-ref','refs/heads/main',merge]);
    // A real Git fixture behind a Cloudflare-shaped boundary, not a hosted-service claim.
    let released=0;
    const provider=cloudflareArtifactsReader({get:async()=>({
      info:async()=>({id:'immutable-repo-id',name:'fixture'}),
      log:async({ref})=>[{hash:await text(['rev-parse','--verify','--end-of-options',ref+'^{commit}'])}],
      readCommit:async oid=>{
        const lines=(await text(['cat-file','commit',oid])).split('\n');
        return{hash:oid,treeHash:lines.find(l=>l.startsWith('tree '))!.slice(5),parents:lines.filter(l=>l.startsWith('parent ')).map(l=>l.slice(7))};
      },
      readFile:async({ref,path})=>new Blob([new Uint8Array(await git(['cat-file','blob',ref+':'+path]))]),
      [Symbol.dispose]:()=>{released++;},
    })},'fixture');
    const reader=new VersionedArtifactReader([{tenant:'tenant',artifact:'source',generation:'one',repositoryId:'immutable-repo-id',provider}],async()=>true);
    const ctx={tenant:'tenant',actor:'user',requestId:'fixture'},pin=await reader.resolve('source','main',ctx);
    await git(['update-ref','refs/heads/main',right]);
    expect((await reader.readFile(pin,'data.bin',ctx)).bytes).toEqual(bytes);
    expect((await reader.history(pin,ctx)).map(c=>c.oid)).toEqual([merge,left,root,right]);
    expect((await reader.resolve('source','main',ctx)).oid).toBe(right);expect(released).toBe(4);
  }finally{await rm(dir,{recursive:true,force:true});}
});
