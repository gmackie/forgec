import {test} from 'node:test';
import assert from 'node:assert/strict';
import {configuration,dynamoDefinition,provision} from '../foundation-test-infra.mjs';
import {mkdtempSync,mkdirSync,chmodSync,symlinkSync,writeFileSync,readFileSync,existsSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {validDynamoTable} from '../../conformance/foundation/providers/dynamo-schema.mjs';
test('provisioning requires explicit dedicated resources and region',()=>{
 assert.throws(()=>configuration(['--provider','d1','--name','production','--state-dir','/tmp/test']));
 assert.throws(()=>configuration(['--provider','dynamodb','--name','forge-foundation-test-example','--state-dir','/tmp/test']));
 assert.equal(configuration(['--provider','d1','--name','forge-foundation-test-example','--state-dir','/tmp/test','--profile','ledger']).profile,'ledger');
});
test('unknown profiles fail configuration for both providers before provisioning',()=>{
 for(const provider of ['d1','dynamodb'])assert.throws(()=>configuration(['--provider',provider,'--name','forge-foundation-test-profile','--state-dir','/tmp/unused-foundation-state','--region','us-east-1','--profile','unknown-package']),/profile/i);
});
function privateState(t){const dir=mkdtempSync(join(tmpdir(),'foundation-infra-test-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));return dir;}
function stateConfig(directory){return configuration(['--provider','d1','--name','forge-foundation-test-state','--state-dir',directory]);}
test('rejects a nonprivate existing directory before recording or provisioning',t=>{
 const dir=privateState(t);chmodSync(dir,0o755);
 assert.throws(()=>provision(stateConfig(dir)),/State directory must/);
 assert.equal(existsSync(join(dir,'infrastructure.json')),false);
});
test('rejects a symlink state directory without changing its private target',t=>{
 const dir=privateState(t),target=join(dir,'target'),link=join(dir,'link');mkdirSync(target,{mode:0o700});symlinkSync(target,link);
 assert.throws(()=>provision(stateConfig(link)),/State directory must/);
 assert.equal(existsSync(join(target,'infrastructure.json')),false);
});
test('refuses to replace an existing resource receipt',t=>{
 const dir=privateState(t),receipt=join(dir,'infrastructure.json'),original='{"databaseId":"already-owned"}\n';writeFileSync(receipt,original,{mode:0o600});
 assert.throws(()=>provision(stateConfig(dir)),/State already exists/);
 assert.equal(readFileSync(receipt,'utf8'),original);
});
test('exclusive receipt creation rejects dangling symlinks before provisioning',t=>{
 const dir=privateState(t),target=join(dir,'missing-target');symlinkSync(target,join(dir,'infrastructure.json'));
 assert.throws(()=>provision(stateConfig(dir)),{code:'EEXIST'});
 assert.equal(existsSync(target),false);
});
test('table definition matches runtime keys and sparse pending index',()=>{
 const d=dynamoDefinition('forge-foundation-test-example');
 assert.equal(validDynamoTable({...d,TableStatus:'ACTIVE',TableArn:'arn:aws:dynamodb:test'}),true);
 assert.deepEqual(d.GlobalSecondaryIndexes[0].KeySchema,[{AttributeName:'pendingShard',KeyType:'HASH'},{AttributeName:'pendingAt',KeyType:'RANGE'}]);
 assert.equal(d.BillingMode,'PAY_PER_REQUEST');
});
