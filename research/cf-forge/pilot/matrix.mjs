import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,readdirSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {resolve} from 'node:path';
import {createConnector} from './connector.mjs';
import {sdkTransport} from './sdk-transport.mjs';
import {invokeApplication} from './runtime.mjs';
const state=process.env.FORGE_CONNECTOR_PILOT_STATE;if(!state)throw Error('Explicit state required');
const config=JSON.parse(readFileSync(`${state}/wrangler.json`));
assert.equal(config.name,'forge-connector-pilot-189-20261001');assert.equal(config.account_id,'c07a7e704db1808e1fff91bed2b1cd49');
const credential=async()=>readFileSync(`${process.env.HOME}/.wrangler/config/default.toml`,'utf8').match(/^oauth_token\s*=\s*"([^"]+)"/m)?.[1];
const ctx={tenant:'connector-certification',actor:'certification',requestId:'matrix'};
const treeHash=root=>{const h=createHash('sha256');const walk=(dir,relative='')=>{for(const item of readdirSync(dir,{withFileTypes:true}).sort((a,b)=>a.name.localeCompare(b.name))){const path=`${dir}/${item.name}`,name=`${relative}/${item.name}`;if(item.isDirectory())walk(path,name);else{h.update(name);h.update(readFileSync(path));}}};walk(root);return h.digest('hex');};
const marker=JSON.parse(readFileSync(new URL('./live-evidence.json',import.meta.url))).marker;
const results=[];
for(const [runtime,root] of [['prior',`${state}/prior-runtime`],['current',process.cwd()]]) {
 for(const [generator,dir] of [['prior','pilot-sdk'],['current','pilot-sdk-current']]) {
  const sdk=resolve(`research/cf-forge/.cache/${dir}/sdk`),{CloudflareApiClient}=await import(pathToFileURL(`${sdk}/Client.ts`));
  const map=JSON.parse(readFileSync(`${sdk}/sdk-map.json`));let reads=0;
  const connector=createConnector({tenant:ctx.tenant,account:config.account_id,script:config.name,credential,transport:sdkTransport(async(url,init)=>{assert.equal(init.method,'GET');reads++;return fetch(url,init);},CloudflareApiClient,map)});
  const result=await invokeApplication(root,async(input,callCtx)=>{const result=await connector.read({},callCtx);return result.ok&&result.value.tags?.includes(input.tag)?{ok:true,value:{applied:true}}:{ok:false,code:'ReleaseNotObserved'};},marker,ctx);
  assert.deepEqual(result,{applied:true});assert.equal(reads,1);
  results.push({runtime,generator,result,liveReads:reads,sdkTreeSha256:treeHash(sdk),runtimeFunctionsSha256:createHash('sha256').update(readFileSync(`${root}/packages/runtime/src/functions.ts`)).digest('hex')});
 }
}
assert.equal(results[0].sdkTreeSha256,results[1].sdkTreeSha256);
const evidence={version:'connector-matrix/1',verifiedAt:new Date().toISOString(),scope:'Two pinned ForgeGraph source snapshots × two independently generated SDKs; current upstream generator source differs only in README, not a second binary release',priorGeneratorRevision:'cfe397c296a5e6d9fce01eb335ed805821e5547c',currentGeneratorRevision:'056b13e10e35672480de15955aefd8ade03a9732',priorRuntimeRevision:'de65061f3f57b3c099c72b3eb1989615b7b9bf4e',currentRuntimeRevision:'8ee7caeb6373',comparisonWrites:0,results};
writeFileSync(new URL('./matrix-evidence.json',import.meta.url),JSON.stringify(evidence,null,2)+'\n');console.log(JSON.stringify(evidence));
