#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { profiles, sourceFingerprint, validateResult } from './verify-foundation-providers.mjs';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const sha = value => createHash('sha256').update(value).digest('hex');
const providers = ['postgres', 'd1', 'dynamodb'];
const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const same = (a,b) => JSON.stringify(a) === JSON.stringify(b);
const requireThat = (condition,message) => { if (!condition) throw new Error(message); };
/** Validate evidence content independently of filesystem traversal and compilation. */
export function validateCertificationReceipt(receipt, reportBytes, expected) {
  const { slug, provider, fingerprint, artifacts, harnessSha256 } = expected;
  const profile = profiles[slug];
  requireThat(profile && providers.includes(provider), 'Unknown certification cell');
  requireThat(receipt.version === 1 && receipt.suite === 'providers' && receipt.status === 'passing', 'Missing passing provider receipt');
  requireThat(receipt.profile === `foundation-${slug}-invariants/1` && receipt.provider === provider, 'Receipt profile/provider mismatch');
  requireThat(receipt.sourceFingerprint === fingerprint, 'Stale source fingerprint');
  requireThat(same(receipt.artifacts,artifacts), 'Generated artifacts do not match current compiler/source');
  requireThat(same(receipt.coverageCriteria,profile.criteria), 'Criterion coverage differs from profile');
  requireThat(same(receipt.requestedTraces,profile.requiredTraces) && same(receipt.passedTraces,profile.requiredTraces), 'Required trace set differs from profile');
  requireThat(digest(receipt.testReportSha256) && receipt.testReportSha256 === sha(reportBytes), 'Raw test report digest mismatch');
  validateResult(JSON.parse(reportBytes.toString()),profile.requiredTraces);
  requireThat(/^[a-f0-9-]{36}$/.test(receipt.runId) && Number.isFinite(Date.parse(receipt.verifiedAt)) && Date.parse(receipt.verifiedAt) <= Date.now()+60000, 'Invalid run identity or verification time');
  requireThat(digest(receipt.targetHash), 'Missing target identity hash');
  const identity=receipt.identity, observed=identity?.observed;
  requireThat(identity?.provider===provider && identity.runId===receipt.runId && identity.tenantPrefix===`foundation-cert-${receipt.runId}`, 'Provider identity/run namespace mismatch');
  requireThat(identity.objectStore==='memory object-store test double; database durability only', 'Object-store scope is missing or overstated');
  if(provider==='postgres') requireThat(['native-postgres-local','native-postgres-remote'].includes(receipt.topology) && observed?.driver==='pg' && typeof observed.serverVersion==='string' && observed.serverVersion.length>0,'Native PostgreSQL observation missing');
  if(provider==='dynamodb') requireThat(receipt.topology==='aws-dynamodb-hosted' && observed?.service==='aws-dynamodb' && observed.tableStatus==='ACTIVE' && /^[a-z]{2}(?:-[a-z]+)+-\d$/.test(observed.region) && digest(observed.tableArnHash),'Hosted DynamoDB observation missing');
  if(provider==='d1') requireThat(receipt.topology==='cloudflare-d1-hosted' && observed?.protocol==='foundation-d1/1' && observed.provider==='cloudflare-d1-hosted' && observed.bundleSha256===artifacts[0].sha256 && observed.harnessSha256===harnessSha256 && typeof observed.colo==='string' && /^[A-Z]{3}$/.test(observed.colo),'Hosted D1 deployment/bundle identity mismatch');
  return {slug,provider,runId:receipt.runId,criteria:profile.criteria,sourceFingerprint:fingerprint,artifacts,testReportSha256:receipt.testReportSha256,targetHash:receipt.targetHash};
}
export function validateCertificationMatrix(cells) {
  const keys=cells.map(cell=>`${cell.slug}/${cell.provider}`);
  const required=Object.keys(profiles).flatMap(slug=>providers.map(provider=>`${slug}/${provider}`));
  requireThat(keys.length===required.length && new Set(keys).size===required.length && required.every(key=>keys.includes(key)),'Certification requires exactly every profile/provider cell');
  for(const slug of Object.keys(profiles)) {
    const set=cells.filter(cell=>cell.slug===slug);
    requireThat(set.every(cell=>cell.sourceFingerprint===set[0].sourceFingerprint && same(cell.artifacts,set[0].artifacts)),`${slug}: provider evidence does not describe identical source/artifacts`);
  }
  return cells;
}
export function certify({receiptDirectory,output}) {
  const out=mkdtempSync(join(tmpdir(),'forge-foundation-certification-'));
  const harnessSha256=sha(readFileSync(join(root,'conformance/foundation/providers/d1-worker.mjs')));
  const candidates=readdirSync(receiptDirectory).filter(name=>name.endsWith('.json')&&!name.endsWith('.vitest.json')).flatMap(name=>{
    try {return [{name,bytes:readFileSync(join(receiptDirectory,name)),receipt:JSON.parse(readFileSync(join(receiptDirectory,name),'utf8'))}];}catch{return [];}
  });
  const cells=[], missing=[];
  try {
    for(const [slug,profile] of Object.entries(profiles)) {
      const fingerprint=sourceFingerprint(slug),bundle=join(out,slug);
      const built=spawnSync('cargo',['run','--quiet','-p','forgegraph-cli','--','build',profile.fixture,'--out',bundle],{cwd:root,stdio:'inherit'});
      requireThat(built.status===0,`Cannot rebuild ${slug} certification artifacts`);
      const artifacts=['app.json','d1/0001_init.sql','postgres/0001_init.sql'].map(path=>({path,sha256:sha(readFileSync(join(bundle,path)))}));
      for(const provider of providers) {
        let accepted;
        const reasons=[];
        for(const candidate of candidates.filter(c=>c.receipt.profile===`foundation-${slug}-invariants/1`&&c.receipt.provider===provider).sort((a,b)=>String(b.receipt.verifiedAt).localeCompare(String(a.receipt.verifiedAt)))) {
          try {
            requireThat(/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(candidate.receipt.runId), 'Invalid receipt run identity');
            const reportName=`${provider}-${candidate.receipt.runId}.vitest.json`;
            const cell=validateCertificationReceipt(candidate.receipt,readFileSync(join(receiptDirectory,reportName)),{slug,provider,fingerprint,artifacts,harnessSha256});
            accepted={...cell,receiptFile:candidate.name,receiptSha256:sha(candidate.bytes),reportFile:reportName};break;
          }catch(error){reasons.push(error.message);}
        }
        if(accepted)cells.push(accepted);else missing.push({slug,provider,reasons:[...new Set(reasons)].slice(0,4)});
      }
      requireThat(sourceFingerprint(slug)===fingerprint,'Source changed during aggregate certification');
    }
    requireThat(!missing.length,`Provider certification incomplete: ${JSON.stringify(missing)}`);
    validateCertificationMatrix(cells);
    requireThat(cells.every(cell=>sourceFingerprint(cell.slug)===cell.sourceFingerprint),'Source changed before certification publication');
    const receipt={version:1,suite:'provider-certification',status:'passing',verifiedAt:new Date().toISOString(),scope:'Foundation database durability only; object bytes use memory test doubles; receipts are local integrity evidence, not cryptographic provider attestation',profileCount:Object.keys(profiles).length,providerCount:providers.length,cells};
    writeFileSync(output,JSON.stringify(receipt,null,2)+'\n');
    console.log(JSON.stringify({status:'passing',receipt:output,cells:cells.length}));
    return receipt;
  }catch(error){
    writeFileSync(output,JSON.stringify({version:1,suite:'provider-certification',status:'failed',failedAt:new Date().toISOString(),missing,failure:error.message},null,2)+'\n');
    throw error;
  }finally{rmSync(out,{recursive:true,force:true});}
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  try{
    let receiptDirectory,output;
    const args=process.argv.slice(2);
    for(let i=0;i<args.length;i++){if(args[i]==='--receipt-dir')receiptDirectory=resolve(args[++i]);else if(args[i]==='--out')output=resolve(args[++i]);else throw new Error(`Unknown argument: ${args[i]}`);}
    requireThat(receiptDirectory&&output,'Usage: --receipt-dir <provider receipts> --out <aggregate receipt>');
    certify({receiptDirectory,output});
  }catch(error){console.error(error.message);process.exitCode=1;}
}
