import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,chmodSync} from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
import {createHash} from 'node:crypto';
import {createConnector} from './connector.mjs';
import {sdkTransport} from './sdk-transport.mjs';
const state=process.env.FORGE_CONNECTOR_PILOT_STATE;
if(!state)throw Error('Explicit FORGE_CONNECTOR_PILOT_STATE required');
const config=JSON.parse(readFileSync(`${state}/wrangler.json`));
assert.equal(config.name,'forge-connector-pilot-189-20261001');
assert.equal(config.account_id,'c07a7e704db1808e1fff91bed2b1cd49');
const credential=async()=>{
 const text=readFileSync(`${process.env.HOME}/.wrangler/config/default.toml`,'utf8');
 const token=text.match(/^oauth_token\s*=\s*"([^"]+)"/m)?.[1];if(!token)throw Error('Wrangler login missing');return token;
};
const db=new DatabaseSync(`${state}/journal.sqlite`);chmodSync(`${state}/journal.sqlite`,0o600);
db.exec('CREATE TABLE IF NOT EXISTS writes (key TEXT PRIMARY KEY, record TEXT NOT NULL)');
const journal={read:async key=>{const row=db.prepare('SELECT record FROM writes WHERE key=?').get(key);return row&&JSON.parse(row.record);},create:async(key,record)=>Number(db.prepare('INSERT OR IGNORE INTO writes VALUES (?,?)').run(key,JSON.stringify(record)).changes)===1,write:async(key,record)=>{db.prepare('UPDATE writes SET record=? WHERE key=?').run(JSON.stringify(record),key);}};
const requests=[];let loseResponse=false;
const observedFetch=async(url,init)=>{
 const response=await fetch(url,init);requests.push({method:init?.method??'GET',status:response.status});
 if(loseResponse&&init?.method==='PATCH'&&response.ok){loseResponse=false;await response.text();throw Error('Injected response loss after vendor accepted write');}
 return response;
};
const options={tenant:'connector-certification',account:config.account_id,script:config.name,credential,journal,transport:sdkTransport(observedFetch)};
const ctx={tenant:'connector-certification',actor:'certification',requestId:'pilot-189'};
const c=createConnector(options), checks=[];
const before=await c.read({},ctx);assert.equal(before.ok,true,JSON.stringify(before));checks.push('live typed SDK read');
const count=requests.length;assert.equal((await c.read({},{tenant:'foreign'})).code,'ConnectionScopeMismatch');assert.equal(requests.length,count);checks.push('tenant isolation before traffic');
const denied=createConnector({...options,credential:async()=>{
 const text=readFileSync(`${process.env.HOME}/Library/Preferences/.wrangler/config/default.toml`,'utf8');
 return text.match(/^oauth_token\s*=\s*"([^"]+)"/m)?.[1];
}});assert.deepEqual(await denied.read({},ctx),{ok:false,code:'ExternalCredentialsRejected'});assert.equal((await c.read({},ctx)).ok,true);checks.push('expired prior Wrangler credential redacted; current credential reselected');
const key='pilot-'+Date.now(),tag='release:'+key;loseResponse=true;
const uncertain=await c.mark({key,tag},ctx);assert.equal(uncertain.code,'ExternalOutcomeUnknown');assert.equal((await journal.read(key)).status,'uncertain');
const writes=requests.filter(x=>x.method==='PATCH').length;
const restarted=createConnector(options);assert.deepEqual(await restarted.mark({key,tag},ctx),{ok:true,value:{tag,reconciled:true}});assert.equal(requests.filter(x=>x.method==='PATCH').length,writes);checks.push('accepted write with lost response persisted and reconciled without duplicate PATCH');
const controller=new AbortController();controller.abort();const cancelledAt=requests.length;assert.equal((await c.read({},ctx,controller.signal)).code,'ExternalCancelled');assert.equal(requests.length,cancelledAt);checks.push('pre-dispatch cancellation sends no request');
const token=await credential();const prior=await fetch(`https://api.cloudflare.com/client/v4/accounts/${config.account_id}/workers/scripts/${config.name}/script-settings`,{headers:{Authorization:`Bearer ${token}`}});const envelope=await prior.json();assert.equal(envelope.success,true);const observed=await c.read({},ctx);assert.deepEqual(observed.value.tags,envelope.result.tags);checks.push('prior direct adapter shadow read agrees; writes never shadowed');
const hash=path=>createHash('sha256').update(readFileSync(new URL(path,import.meta.url))).digest('hex');
const result={version:'connector-pilot-evidence/1',verifiedAt:new Date().toISOString(),capability:'deployment.release-marker/1',marker:{key,tag},vendor:'Cloudflare Workers script settings',host:'Node 24 against live Cloudflare API',account:config.account_id,worker:config.name,credentialReference:'existing local Wrangler OAuth login (value omitted)',checks,requests,hashes:{spec:hash('./vendor.json'),adapter:hash('./connector.mjs'),transport:hash('./sdk-transport.mjs'),operationMap:hash('../.cache/pilot-sdk/sdk/sdk-map.json')},limitations:['Node host only; no deployed connector Worker/AWS claim','Single-writer disposable Worker; no generic PATCH idempotency','Expired prior Wrangler login tested; current OAuth token was not revoked','Prior/current generator/runtime release matrix remains required'],cleanup:'pending'};
writeFileSync(new URL('./live-evidence.json',import.meta.url),JSON.stringify(result,null,2)+'\n');db.close();console.log(JSON.stringify(result));
