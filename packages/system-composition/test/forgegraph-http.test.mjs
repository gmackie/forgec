import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {createForgeGraphReader} from '../src/forgegraph-http.mjs';
async function host(run,repo='repo1') {
  const calls=[];
  const server=createServer((req,res)=>{
    calls.push({path:req.url,token:req.headers.authorization});res.setHeader('content-type','application/json');
    if(req.url==='/api/fg/changesets/123')res.end(JSON.stringify({
      id:'123',repositoryId:repo,headSha:'abc123',status:'merged',
      identities:[{kind:'jj_change_id',value:'jj123'}],
      builds:[{id:'build',pipelineName:'CI',status:'passed',metadata:{secret:'hidden'}}],
      testRuns:[{id:'run',suiteName:'unit',status:'passed',passedTests:12,failedTests:0}],
      artifacts:[{id:'a1',kind:'nix',digest:'sha256:abc'}]
    }));
    else if(req.url==='/api/fg/evidence?changesetId=123')res.end(JSON.stringify({evidence:[{id:'build',type:'build',status:'passed',name:'CI'}]}));
    else {res.statusCode=404;res.end('{}');}
  });server.listen(0,'127.0.0.1');await once(server,'listening');
  try{await run('http://127.0.0.1:'+server.address().port+'/',calls);}
  finally{server.close();await once(server,'close');}
}
const reader=(baseUrl,allowed=true)=>createForgeGraphReader({baseUrl,tenant:'t1',repositoryId:'repo1',allowInsecureLoopback:true,
  credentialForActor:async()=> 'actor-token',authorize:async({actor})=>actor==='alice',assertRepositoryScope:async()=>allowed});
test('real ForgeGraph detail and evidence routes preserve scope and never assert deployment',async()=>{
  await host(async(baseUrl,calls)=>{
    const fg=reader(baseUrl);
    const change=await fg.changeset({tenant:'t1',actor:'alice',changesetId:'123'});
    assert.equal(change.headSha,'abc123');assert.equal(change.tests[0].passed,12);
    assert.equal(change.deploymentVerified,false);assert.equal(JSON.stringify(change).includes('hidden'),false);
    assert.equal((await fg.evidence({tenant:'t1',actor:'alice',changesetId:'123'})).evidence.length,1);
    assert.deepEqual(calls.map(c=>c.path),['/api/fg/changesets/123','/api/fg/changesets/123','/api/fg/evidence?changesetId=123']);
    assert.ok(calls.every(c=>c.token==='Bearer actor-token'));
    await assert.rejects(()=>fg.changeset({tenant:'t2',actor:'alice',changesetId:'123'}),/not authorized/);
    await assert.rejects(()=>fg.changeset({tenant:'t1',actor:'other',changesetId:'123'}),/not authorized/);
    await assert.rejects(()=>fg.changeset({tenant:'t1',actor:'alice',changesetId:'../admin'}),/invalid changeset ID/);
  });
});
test('changeset bearer GET needs independent repository assertion',async()=>{
  await host(async(baseUrl)=>{
    await assert.rejects(()=>reader(baseUrl,false).changeset({tenant:'t1',actor:'alice',changesetId:'123'}),/not authorized/);
  });
  await host(async(baseUrl)=>{
    await assert.rejects(()=>reader(baseUrl).changeset({tenant:'t1',actor:'alice',changesetId:'123'}),/repository mismatch/);
  },'different-repo');
});
test('ForgeGraph reader refuses untrusted HTTP origins without loopback opt-in',()=>{
  assert.throws(()=>createForgeGraphReader({baseUrl:'http://other.example/',tenant:'t1',repositoryId:'repo1',credentialForActor:async()=> 'x',authorize:async()=>true,assertRepositoryScope:async()=>true}),/invalid or untrusted/);
});
