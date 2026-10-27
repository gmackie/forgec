import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {SqliteActionLedger} from '../src/sqlite-ledger.mjs';
import {DurableActionCenter} from '../src/durable-action-center.mjs';
import {SystemGateway} from '../src/system-gateway.mjs';
import {createSystemHttpHandler,createMcpHttpHandler} from '../src/http.mjs';
import {createProducerHmacVerifier,signProducerEvent} from '../src/producer-hmac.mjs';
const catalog=JSON.parse(readFileSync(new URL('../catalog/systems.json',import.meta.url)));
const secret='A'.repeat(64);
const now=1800000000;
function env() {
  const ledger=new SqliteActionLedger();let forwarded=0;
  const authenticate=async request=>request.headers.get('authorization')==='Bearer alice' ? {verified:true,tenant:'t1',actor:'alice'} : null;
  const actionCenter=new DurableActionCenter({ledger,producers:{approvals:{kinds:['approval']}},authorize:async x=>x.actor==='alice',dispatch:async()=>({accepted:true,receiptId:'provider-receipt'})});
  const gateway=new SystemGateway({catalog,ledger,authorize:async ctx=>ctx.actor==='alice',bindings:{'action-center/list-pending':{
    owner:'routing',inputSchema:{type:'object',properties:{},additionalProperties:false},validate:x=>{if(Object.keys(x??{}).length)throw TypeError('unexpected input');return {};},execute:async()=>{forwarded++;return [{count:1}]},project:x=>x,
  }}});
  const verifyProducer=createProducerHmacVerifier({config:{approvals:{tenant:'t1',secrets:[secret]}},now:()=>now});
  const api=createSystemHttpHandler({gateway,actionCenter,authenticate,verifyProducer,allowOrigins:['https://allowed.example']});
  const mcp=createMcpHttpHandler({gateway,authenticate,canDiscover:async ctx=>ctx.principal.actor==='alice',allowOrigins:['https://allowed.example']});
  return {ledger,api,mcp,forwarded:()=>forwarded};
}
const url=p=>`http://127.0.0.1${p}`;
const request=(method,path,{token='Bearer alice',headers={},body}={})=>new Request(url(path),{method,headers:{authorization:token,...headers,...(body?{'content-type':'application/json'}:{})},body:body?JSON.stringify(body):undefined});
test('HTTP ingress returns real authorization-filtered action and dispatch receipt',async()=>{
  const x=env();
  const body={eventId:'evt-1',payload:{tenant:'t1',subject:'approval-1',kind:'approval',label:'Review request',status:'pending',revision:1,assignees:['alice'],actions:['decide']}};
  const raw=new TextEncoder().encode(JSON.stringify(body));
  const signature=await signProducerEvent({source:'approvals',timestamp:String(now),rawBody:raw,secret});
  const authHeaders={'x-forge-timestamp':String(now),'x-forge-signature':`v1=${signature}`};
  assert.equal((await x.api(request('POST','/v1/producers/approvals/events',{token:'',headers:authHeaders,body}))).status,202);
  const read=await x.api(request('GET','/v1/actions'));
  assert.equal(read.status,200);assert.equal((await read.json()).actions.length,1);
  const invoke=await x.api(request('POST','/v1/actions/invoke',{body:{source:'approvals',subject:'approval-1',revision:1,action:'decide',purpose:'approvals.decide'},headers:{'idempotency-key':'req-123'}}));
  assert.equal(invoke.status,202);assert.equal((await invoke.json()).state,'acknowledged');
  assert.equal((await (await x.api(request('GET','/v1/actions'))).json()).actions.length,1); // still pending until provider event
  const forbidden=await x.api(request('GET','/v1/actions',{token:'Bearer wrong'}));assert.equal(forbidden.status,401);
  x.ledger.close();
});
test('HMAC rejects tampering, wrong tenant and late timestamps',async()=>{
  const x=env();const body={eventId:'evt-1',payload:{tenant:'t2',subject:'approval-1',kind:'approval',label:'Review request',status:'pending',revision:1,assignees:['alice'],actions:['decide']}};
  const raw=new TextEncoder().encode(JSON.stringify(body));
  const sig=await signProducerEvent({source:'approvals',timestamp:String(now),rawBody:raw,secret});
  const headers={'x-forge-timestamp':String(now),'x-forge-signature':`v1=${sig}`};
  assert.equal((await x.api(request('POST','/v1/producers/approvals/events',{token:'',headers,body}))).status,403);
  body.payload.tenant='t1';
  assert.equal((await x.api(request('POST','/v1/producers/approvals/events',{token:'',headers,body}))).status,403);
  assert.equal((await x.api(request('POST','/v1/producers/approvals/events',{token:'',headers:{...headers,'x-forge-timestamp':String(now-1000)},body}))).status,403);
  x.ledger.close();
});
test('REST system operations use authenticated source of principal and closed schemas',async()=>{
  const x=env();const good=await x.api(request('POST','/v1/systems/action-center/operations/list-pending',{body:{input:{}}}));
  assert.equal(good.status,200);assert.equal((await good.json()).state,'queried');assert.equal(x.forwarded(),1);
  assert.equal((await x.api(request('POST','/v1/systems/action-center/operations/list-pending',{body:{input:{},tenant:'other'}}))).status,422);
  assert.equal((await x.api(request('POST','/v1/systems/action-center/operations/list-pending',{token:'Bearer bad',body:{input:{}}}))).status,401);
  assert.equal((await x.api(request('POST','/v1/systems/action-center/operations/list-pending',{headers:{Origin:'https://evil.example'},body:{input:{}}}))).status,403);
  x.ledger.close();
});
test('MCP initialize, tool discovery, and tools/call share one authorized gateway',async()=>{
  const x=env();const headers={
    'mcp-protocol-version':'2026-07-28','mcp-method':'initialize',
  };
  const init=await x.mcp(request('POST','/mcp',{headers,body:{jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2026-07-28',capabilities:{},clientInfo:{name:'test',version:'1'}}}}));
  assert.equal(init.status,200);assert.equal((await init.json()).result.protocolVersion,'2026-07-28');
  const tools=await x.mcp(request('POST','/mcp',{headers:{...headers,'mcp-method':'tools/list'},body:{jsonrpc:'2.0',id:2,method:'tools/list',params:{}}}));
  const named=(await tools.json()).result.tools;assert.equal(named.length,1);
  assert.equal(named[0].inputSchema.required[0],'input');
  const toolName=named[0].name;
  const invoke=await x.mcp(request('POST','/mcp',{headers:{...headers,'mcp-method':'tools/call','mcp-name':toolName},body:{jsonrpc:'2.0',id:3,method:'tools/call',params:{name:toolName,arguments:{input:{}}}}}));
  assert.equal(invoke.status,200);assert.equal((await invoke.json()).result.structuredContent.state,'queried');
  assert.equal(x.forwarded(),1);
  assert.equal((await x.mcp(request('GET','/mcp'))).status,405);
  x.ledger.close();
});
test('real loopback HTTP request exercises fetch-compatible handler without network service dependency',async()=>{
  const x=env();
  const server=createServer(async (req,res)=>{
    const chunks=[];for await(const part of req)chunks.push(part);
    const body=Buffer.concat(chunks);
    const request=new Request(`http://127.0.0.1${req.url}`,{method:req.method,headers:req.headers,body:req.method==='GET'?undefined:body});
    const answer=await x.api(request);
    res.writeHead(answer.status,Object.fromEntries(answer.headers));res.end(Buffer.from(await answer.arrayBuffer()));
  });
  server.listen(0,'127.0.0.1');await once(server,'listening');
  try{
    const response=await fetch(`http://127.0.0.1:${server.address().port}/v1/systems/action-center/operations/list-pending`,{
      method:'POST',headers:{authorization:'Bearer alice','content-type':'application/json'},body:JSON.stringify({input:{}})
    });
    assert.equal(response.status,200);assert.deepEqual((await response.json()).data,[{count:1}]);
  }finally{server.close();await once(server,'close');x.ledger.close();}
});
