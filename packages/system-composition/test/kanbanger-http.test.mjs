import test from 'node:test';import assert from 'node:assert/strict';
import {createServer} from 'node:http';import {once} from 'node:events';
import {createKanbangerReader} from '../src/kanbanger-http.mjs';
const issueId='aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';const ws='ws1';
test('real KanBanger typed HTTP paths are workspace pinned and delivery is redacted',async()=>{
  const called=[];
  const server=createServer((req,res)=>{
    called.push({url:req.url,authorization:req.headers.authorization});
    res.setHeader('content-type','application/json');
    if(req.url===`/api/workspaces/ws1/issues/${issueId}`)res.end(JSON.stringify({issue:{id:issueId,title:'Fix auth bug'}}));
    else if(req.url===`/api/workspaces/ws1/issues/${issueId}/delivery`)res.end(JSON.stringify({prs:[{workspaceId:ws,issueId,kind:'pr',status:'opened',subject:'PR',changesetId:'jj-1',updatedAt:'2026-10-27',payload:{secret:'do-not-copy'}}],checks:[],evidence:[],deploys:[]}));
    else if(req.url==='/api/workspaces/ws1/delivery/needs-me')res.end(JSON.stringify({readyForReview:[{workspaceId:ws,issueId,kind:'review_request',status:'ready',subject:'review'}],failing:[],changesRequested:[]}));
    else{res.statusCode=404;res.end(JSON.stringify({error:'not found'}));}
  });
  server.listen(0,'127.0.0.1');await once(server,'listening');
  const baseUrl=`http://127.0.0.1:${server.address().port}/`;
  try{
    const k=createKanbangerReader({baseUrl,tenant:'t1',workspaceId:ws,credentialForActor:async()=> 'token',authorize:async({actor})=>actor==='alice',allowInsecureLoopback:true});
    assert.equal((await k.issue({tenant:'t1',actor:'alice',issueId})).issue.id,issueId);
    const delivery=await k.delivery({tenant:'t1',actor:'alice',issueId});assert.equal(delivery.prs[0].changesetId,'jj-1');assert.equal(JSON.stringify(delivery).includes('do-not-copy'),false);
    assert.equal((await k.needsMe({tenant:'t1',actor:'alice'})).readyForReview.length,1);
    assert.ok(called.every(x=>x.authorization==='Bearer token'));
    await assert.rejects(()=>k.issue({tenant:'t1',actor:'bob',issueId}),/not authorized/);
    await assert.rejects(()=>k.needsMe({tenant:'other',actor:'alice'}),/not authorized/);
    await assert.rejects(()=>k.issue('../../admin'),/invalid path ID/);
  }finally{server.close();await once(server,'close');}
});
test('KanBanger reader refuses arbitrary/HTTP origins without explicit localhost test opt-in',()=>{
  assert.throws(()=>createKanbangerReader({baseUrl:'http://evil.example/',tenant:'t1',workspaceId:'ws1',credentialForActor:async()=> 'x',authorize:async()=>true}),/invalid or untrusted/);
  assert.throws(()=>createKanbangerReader({baseUrl:'https://example.com/a/',tenant:'t1',workspaceId:'ws1',credentialForActor:async()=> 'x',authorize:async()=>true}),/invalid or untrusted/);
  assert.throws(()=>createKanbangerReader({baseUrl:'http://127.0.0.1/',tenant:'t1',workspaceId:'ws1',credentialForActor:async()=> 'x',authorize:async()=>true}),/invalid or untrusted/);
});
