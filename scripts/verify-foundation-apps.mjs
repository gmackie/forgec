#!/usr/bin/env node
import {createHash,randomUUID} from 'node:crypto';
import {readFileSync,writeFileSync,mkdirSync,mkdtempSync,rmSync,realpathSync,existsSync,readdirSync} from 'node:fs';
import {resolve,dirname,join,relative,isAbsolute} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
export const applications=['kanbanger','bob','forgegraph','levelforge','stream-conductor','latchflow'];
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
export function validateDescriptor(d,slug) {
  if(!applications.includes(slug)||d?.version!==1||!/^FORGE_FOUNDATION_[A-Z_]+_ROOT$/.test(d.sourceRootEnv??'')||!new RegExp(`^test/foundation-app-${slug}\\.traces\\.ts$`).test(d.test??'')||!Array.isArray(d.requiredTests)||!d.requiredTests.length||d.requiredTests.some(t=>typeof t!=='string'||!t.trim())||new Set(d.requiredTests).size!==d.requiredTests.length||!Array.isArray(d.sourceFiles)||!d.sourceFiles.length||!/^[a-f0-9]{40}$/.test(d.sourceRevision??''))throw new Error(`Invalid ${slug} app verification descriptor`);
  const seen=new Set();
  for(const f of d.sourceFiles){if(!f||typeof f.path!=='string'||!f.path||isAbsolute(f.path)||f.path.split(/[\\/]/).some(p=>p==='..'||p==='.'||p==='')||!/^[a-f0-9]{64}$/.test(f.sha256??'')||seen.has(f.path))throw new Error('Invalid or duplicate pinned app source');seen.add(f.path);}
  return d;
}
/** Read immutable repository content without snapshotting/changing a JJ workspace. */
export function revisionSource(sourceRoot,revision,path,execute=spawnSync) {
  sourceRoot=realpathSync(sourceRoot);
  const jjRoot=execute('jj',['--ignore-working-copy','root'],{cwd:sourceRoot,encoding:'utf8'});
  let result;
  if(!jjRoot.error&&jjRoot.status===0){
    const repo=realpathSync(jjRoot.stdout.trim()),within=relative(repo,sourceRoot);
    if(within.startsWith('..')||isAbsolute(within))throw new Error('Application source root escapes repository');
    result=execute('jj',['--ignore-working-copy','file','show','-r',revision,join(within,path).split('\\').join('/')],{cwd:repo,maxBuffer:32*1024*1024});
  }else{
    const gitRoot=execute('git',['rev-parse','--show-toplevel'],{cwd:sourceRoot,encoding:'utf8'});
    if(gitRoot.error||gitRoot.status!==0)throw new Error('Application source revision requires a JJ or Git repository');
    const repo=realpathSync(gitRoot.stdout.trim()),within=relative(repo,sourceRoot);
    if(within.startsWith('..')||isAbsolute(within))throw new Error('Application source root escapes repository');
    result=execute('git',['show',`${revision}:${join(within,path).split('\\').join('/')}`],{cwd:repo,maxBuffer:32*1024*1024});
  }
  if(result.error||result.status!==0)throw new Error(`Application source revision is unavailable: ${path}`);
  return result.stdout;
}
export function verifySources(d,sourceRoot,readRevision=revisionSource) {
  if(!sourceRoot)throw new Error(`Missing ${d.sourceRootEnv}; actual application source is required`);
  const base=realpathSync(sourceRoot);
  return d.sourceFiles.map(f=>{
    const path=realpathSync(join(base,f.path)),r=relative(base,path);
    if(r.startsWith('..')||isAbsolute(r)||sha(readFileSync(path))!==f.sha256)throw new Error(`Application source drift: ${f.path}`);
    if(sha(readRevision(base,d.sourceRevision,f.path))!==f.sha256)throw new Error(`Application source revision mismatch: ${f.path}`);
    return {path:f.path,sha256:f.sha256};
  });
}
export function verifyTests(report,required) {
  const assertions=(report.testResults??[]).flatMap(s=>s.assertionResults??[]);
  if(report.success!==true||report.numFailedTests!==0||report.numPendingTests!==0||report.numTodoTests!==0||assertions.length<required.length||assertions.some(a=>a.status!=='passed')||required.some(t=>assertions.filter(a=>a.title===t).length!==1))throw new Error('Every required app trace must execute exactly once without skips');
  return required;
}
function run(cmd,args,env={}){const r=spawnSync(cmd,args,{cwd:root,env:{...process.env,...env},stdio:'inherit'});if(r.error||r.status!==0)throw new Error(`${cmd} app verification failed (${r.status??'unavailable'})`);}
/** Include transitive local packages, runtime test helpers and build configuration.
 * Hashing only the trace file misses changes to its imported fixture/adapter code. */
export function fingerprint(example,test,repositoryRoot=root){
  const files=new Set();
  const ignored=new Set(['node_modules','generated','target','dist','.git','.jj','coverage','.next']);
  const walk=p=>{for(const e of readdirSync(p,{withFileTypes:true})){if(ignored.has(e.name))continue;const q=join(p,e.name);if(e.isSymbolicLink())throw new Error(`Symlink in verification source: ${relative(repositoryRoot,q)}`);if(e.isDirectory())walk(q);else if(e.isFile())files.add(q);}};
  for(const p of [example,join(repositoryRoot,'packages'),join(repositoryRoot,'conformance/foundation/apps'),join(repositoryRoot,'crates'),join(repositoryRoot,'scripts')])walk(p);
  for(const p of ['packages/runtime/'+test,'package.json','pnpm-workspace.yaml','pnpm-lock.yaml','Cargo.toml','Cargo.lock','tsconfig.base.json'])files.add(join(repositoryRoot,p));
  const h=createHash('sha256');for(const p of [...files].sort())h.update(relative(repositoryRoot,p)).update('\0').update(readFileSync(p)).update('\0');return h.digest('hex');
}

/** Every emitted artifact matters, including API descriptions and generated metadata. */
export function artifactManifest(directory){
  const files=[];
  const walk=p=>{for(const e of readdirSync(p,{withFileTypes:true})){const q=join(p,e.name);if(e.isSymbolicLink())throw new Error('Generated artifacts cannot contain symlinks');if(e.isDirectory())walk(q);else if(e.isFile())files.push({path:relative(directory,q).split('\\').join('/'),sha256:sha(readFileSync(q))});}};
  walk(directory);
  for(const path of ['app.json','d1/0001_init.sql','postgres/0001_init.sql','client.ts','source-map.json'])if(!files.some(file=>file.path===path))throw new Error(`Missing generated artifact ${path}`);
  return files.sort((a,b)=>a.path.localeCompare(b.path));
}
export function verifyArtifacts(first,second){
  const manifest=artifactManifest(first);
  if(JSON.stringify(manifest)!==JSON.stringify(artifactManifest(second)))throw new Error('Nondeterministic generated artifacts');
  return manifest;
}
export function runApps(args){
  let app,receiptDir=join(root,'conformance/reports/foundation/apps');
  for(let i=0;i<args.length;i++){if(args[i]==='--app')app=args[++i];else if(args[i]==='--receipt-dir')receiptDir=resolve(args[++i]);else throw new Error(`Unknown argument: ${args[i]}`);}
  const chosen=app==='all'?applications:[app];
  const tasks=chosen.map(slug=>{if(!applications.includes(slug))throw new Error('Choose --app '+applications.join('|')+'|all');const example=join(root,'examples/foundation/apps',slug),descriptor=validateDescriptor(JSON.parse(readFileSync(join(example,'verification.json'))),slug),sourceRoot=process.env[descriptor.sourceRootEnv];return {slug,example,descriptor,sourceRoot,sources:verifySources(descriptor,sourceRoot)};});
  for(const {slug,example,descriptor,sourceRoot,sources} of tasks){
    const out=mkdtempSync(join(tmpdir(),'forge-app-'+slug+'-')),id=randomUUID(),sourceFingerprint=fingerprint(example,descriptor.test);
    const receipt={version:1,suite:'applications',application:slug,status:'running',runId:id,sourceRevision:descriptor.sourceRevision,sourceRevisionScope:"Pinned files verified against immutable revision; unrelated working-copy files are not certified",sourceFiles:sources,sourceFingerprint,scope:'Local opt-in integration with pinned actual application source; not deployed adoption'};
    mkdirSync(receiptDir,{recursive:true});const receiptPath=join(receiptDir,`${slug}-${id}.json`),reportPath=join(out,'vitest.json');
    try{
      for(const dir of ['first','second'])run('cargo',['run','--quiet','-p','forgegraph-cli','--','build',example,'--out',join(out,dir)]);
      receipt.artifacts=verifyArtifacts(join(out,'first'),join(out,'second'));
      run('pnpm',['--filter','@forgegraph/runtime','exec','vitest','run','--config',join(root,'conformance/foundation/apps/vitest.config.mjs'),'--reporter=default','--reporter=json',`--outputFile=${reportPath}`],{[descriptor.sourceRootEnv]:sourceRoot,FORGE_FOUNDATION_APP_TEST:descriptor.test,FORGE_FOUNDATION_FIXTURE:join(out,'first'),[`FORGE_FOUNDATION_${slug.toUpperCase().replaceAll('-','_')}_BUNDLE`]:join(out,'first')});
      const bytes=readFileSync(reportPath);receipt.passedTests=verifyTests(JSON.parse(bytes),descriptor.requiredTests);verifySources(descriptor,sourceRoot);
      if(JSON.stringify(receipt.artifacts)!==JSON.stringify(verifyArtifacts(join(out,'first'),join(out,'second'))))throw new Error('Generated artifacts changed during application verification');
      if(fingerprint(example,descriptor.test)!==sourceFingerprint)throw new Error('Source changed during application verification');
      receipt.status='passing';receipt.verifiedAt=new Date().toISOString();receipt.testReportSha256=sha(bytes);
    }catch(e){receipt.status='failed';receipt.failure='Required source/build/integration verification failed';throw e;}
    finally{if(existsSync(reportPath))writeFileSync(join(receiptDir,`${slug}-${id}.vitest.json`),readFileSync(reportPath));writeFileSync(receiptPath,JSON.stringify(receipt,null,2)+'\n');rmSync(out,{recursive:true,force:true});}
    console.log(JSON.stringify({application:slug,status:receipt.status,receipt:receiptPath}));
  }
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){try{runApps(process.argv.slice(2));}catch(e){console.error(e.message);process.exitCode=1;}}
