#!/usr/bin/env node
/** Verified Git history interchange. Callers fence writes and retain unpublished work. */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdtemp,readFile,writeFile,mkdir,rm,link,lstat } from 'node:fs/promises';
import { resolve,join,dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
const exec=promisify(execFile);
const env={...Object.fromEntries(Object.entries(process.env).filter(([k])=>!k.startsWith('GIT_'))),GIT_CONFIG_GLOBAL:'/dev/null',GIT_CONFIG_NOSYSTEM:'1',GIT_TERMINAL_PROMPT:'0',LC_ALL:'C'};
async function git(directory,args,maxBuffer=16*1024*1024){
 try{return (await exec('git',['--no-replace-objects','-C',directory,'-c','core.hooksPath=/dev/null',...args],{env,encoding:'buffer',maxBuffer,timeout:60000})).stdout;}
 catch{throw Error('Git history operation failed');}
}
async function digest(path){const hash=createHash('sha256');for await(const bytes of createReadStream(path))hash.update(bytes);return hash.digest('hex');}
const equal=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
export async function inventoryHistory(directory){
 if((await git(directory,['rev-parse','--is-bare-repository'])).toString().trim()!=='true')throw Error('History inventory requires a bare repository');
 if((await git(directory,['rev-parse','--is-shallow-repository'])).toString().trim()!=='false')throw Error('Shallow history cannot be exported as complete');
 const health=(await git(directory,['fsck','--full','--no-reflogs','--unreachable'])).toString();
 if(/(?:unreachable|dangling) commit /.test(health))throw Error('Unreferenced commits must be retained under refs before export');
 const format=(await git(directory,['rev-parse','--show-object-format'])).toString().trim();
 const head=(await git(directory,['symbolic-ref','HEAD'])).toString().trim();
 if((await git(directory,['for-each-ref','--format=%(symref)'])).toString().trim())throw Error('Symbolic non-HEAD refs require explicit inventory support');
 const refs=(await git(directory,['for-each-ref','--format=%(refname) %(objectname)'])).toString().trim().split('\n').filter(Boolean).sort();
 if(!refs.length||refs.length>4096||refs.some(r=>r.startsWith('refs/replace/')))throw Error('Unsupported history ref inventory');
 const ids=(await git(directory,['rev-list','--objects','--all','--no-object-names'])).toString().trim().split('\n').filter(Boolean);
 const unique=[...new Set(ids)].sort();if(unique.length>100000)throw Error('History object budget exceeded');
 const objects=[];let total=0;
 for(const oid of unique){
  const type=(await git(directory,['cat-file','-t',oid])).toString().trim();
  const size=Number((await git(directory,['cat-file','-s',oid])).toString());total+=size;
  if(!Number.isSafeInteger(size)||size<0||size>32*1024*1024||total>256*1024*1024)throw Error('History byte budget exceeded');
  const bytes=await git(directory,['cat-file',type,oid],32*1024*1024+1);
  if(bytes.length!==size)throw Error('History object size mismatch');
  if(type==='blob'&&bytes.subarray(0,80).toString().startsWith('version https://git-lfs.github.com/spec/v1\n'))throw Error('LFS payload inventory is required before export');
  if(type==='tree'){let offset=0;while(offset<bytes.length){const end=bytes.indexOf(0,offset);if(end<0)throw Error('Invalid tree');if(bytes.subarray(offset,end).toString().startsWith('160000 '))throw Error('Submodule inventory is required before export');offset=end+1+(format==='sha1'?20:32);}}
  objects.push({oid,type,size,sha256:createHash('sha256').update(bytes).digest('hex')});
 }
 return {format,head,refs,objects};
}
export async function exportHistory(directory,bundlePath){
 const target=resolve(bundlePath);try{await lstat(target);throw Error('Export target already exists');}catch(e){if(e.code!=='ENOENT')throw e;}
 const inventory=await inventoryHistory(directory),temporary=await mkdtemp(join(dirname(target),'.forge-export-'));
 try{
  const bundle=join(temporary,'history.bundle');await git(directory,['bundle','create',bundle,'--all']);
  if(!equal(inventory,await inventoryHistory(directory)))throw Error('Source changed during export');
  const manifest={version:'forge-history/1',scope:'All refs and their complete reachable object graph; excludes reflogs and unreferenced objects',bundleSha256:await digest(bundle),inventory};
  const verify=join(temporary,'verify.git');await restoreHistory(bundle,verify,manifest);await link(bundle,target);return manifest;
 }finally{await rm(temporary,{recursive:true,force:true});}
}
export async function restoreHistory(bundlePath,destination,manifest){
 if(manifest.version!=='forge-history/1'||!manifest.inventory||await digest(bundlePath)!==manifest.bundleSha256)throw Error('History bundle digest mismatch');
 // Exclusive directory creation prevents replacing an existing application repo.
 await mkdir(destination,{recursive:false});
 try{
  await git(destination,['init','--bare','--object-format='+manifest.inventory.format]);
  await git(destination,['bundle','verify',resolve(bundlePath)]);
  await git(destination,['fetch','--no-tags','--',resolve(bundlePath),'+refs/*:refs/*']);
  if(!/^refs\/heads\//.test(manifest.inventory.head))throw Error('Invalid default branch');
  await git(destination,['symbolic-ref','HEAD',manifest.inventory.head]);
  if(!equal(await inventoryHistory(destination),manifest.inventory))throw Error('Restored history differs from inventory');
 }catch(error){await rm(destination,{recursive:true,force:true});throw error;}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
 const [command,source,target,manifestPath]=process.argv.slice(2);
 try{
  if(!source||!target||!manifestPath)throw Error('Usage: artifact-history.mjs export <bare-repo> <bundle> <manifest> | restore <bundle> <new-directory> <manifest>');
  if(command==='export'){const manifest=await exportHistory(source,target);await writeFile(manifestPath,JSON.stringify(manifest,null,2)+'\n',{flag:'wx',mode:0o600});console.log('Export verified');}
  else if(command==='restore'){await restoreHistory(source,target,JSON.parse(await readFile(manifestPath,'utf8')));console.log('Restore verified');}
  else throw Error('Unknown history command');
 }catch(error){console.error(error.message);process.exitCode=1;}
}
