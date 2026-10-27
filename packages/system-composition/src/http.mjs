/**
 * Host-facing HTTP adapters. Trusted identity, producer verification and policy
 * checks are host ports, never fields parsed from a body or transport headers.
 * Native Forge/Effect hosts may mount the same callable services instead.
 */
import { mcpDescriptors, callMcpTool } from './system-gateway.mjs';

const maxBody = 128 * 1024;
const outputHeaders = {'content-type':'application/json; charset=utf-8','cache-control':'no-store','x-content-type-options':'nosniff','vary':'Authorization'};
function reply(status,payload) {return new Response(JSON.stringify(payload),{status,headers:outputHeaders});}
function code(error) {
  const reason=String(error?.message??'');
  if (/unauthenticated/.test(reason)) return [401,'unauthenticated'];
  if (/invalid producer signature|stale signature|bad timestamp|invalid signature|unknown trusted producer/.test(reason)) return [403,'forbidden'];
  if (/not authorized/.test(reason)) return [403,'forbidden'];
  if (/not found|not installed|unknown MCP tool|not available/.test(reason)) return [404,'not_found'];
  if (/revision|conflict|stale|gap/.test(reason)) return [409,'conflict'];
  if (error instanceof TypeError || /invalid |missing |unknown |extra field/.test(reason)) return [422,'validation_failed'];
  return [503,'dependency_unavailable'];
}
async function readJson(request) {
  if (!/^application\/json(?:;|$)/i.test(request.headers.get('content-type')??'')) throw new TypeError('application/json required');
  const length=Number(request.headers.get('content-length')??0);
  if (Number.isFinite(length)&&length>maxBody) throw new TypeError('payload too large');
  const reader=request.body?.getReader();
  if (!reader) throw new TypeError('empty body');
  const parts=[];let bytes=0;
  while(true) {
    const {done,value}=await reader.read();if(done)break;
    bytes+=value.byteLength;
    if(bytes>maxBody){await reader.cancel();throw new TypeError('payload too large');}
    parts.push(value);
  }
  const merged=new Uint8Array(bytes);let offset=0;
  for(const part of parts){merged.set(part,offset);offset+=part.length;}
  const text=new TextDecoder('utf-8',{fatal:true}).decode(merged);
  let data;try{data=JSON.parse(text);}catch{throw new TypeError('invalid JSON');}
  if (!data||typeof data!=='object'||Array.isArray(data)) throw new TypeError('object payload required');
  return {data,bytes:merged};
}
function checkOrigin(request,allowOrigins) {
  const origin=request.headers.get('origin');
  if (origin && !allowOrigins.includes(origin)) throw new Error('not authorized: origin');
}
function verifiedPrincipal(value) {
  if (!value || value.verified!==true || typeof value.tenant!=='string'||!value.tenant || typeof value.actor!=='string'||!value.actor) throw new Error('unauthenticated');
  return value;
}
const guard=async(authenticate,request)=>verifiedPrincipal(await authenticate(request));

/** Callable under a Fetch API runtime (Node, Workers, etc.). No cookie
 * authentication is supplied: the host's authenticate() must validate CSRF/
 * token/issuer/audience/scopes and return a verified principal. */
export function createSystemHttpHandler({ gateway, actionCenter, authenticate, verifyProducer, allowOrigins=[] }) {
  if (typeof authenticate!=='function') throw new TypeError('trusted authenticate port required');
  return async request=>{
    try {
      checkOrigin(request,allowOrigins);
      const url=new URL(request.url);
      if (request.method==='GET' && url.pathname==='/v1/systems') {
        await guard(authenticate,request);
        return reply(200,{operations:gateway.operations().map(({inputSchema,...fields})=>fields)});
      }
      if (request.method==='POST' && url.pathname.startsWith('/v1/systems/')) {
        const segments=url.pathname.split('/').filter(Boolean);
        if (segments.length!==5 || segments[0]!=='v1' || segments[1]!=='systems' || segments[3]!=='operations') return reply(404,{error:{code:'not_found'}});
        const principal=await guard(authenticate,request);
        const {data}=await readJson(request);
        if (Object.keys(data).some(x=>x!=='input')) throw new TypeError('unexpected outer fields');
        const value=await gateway.invoke({principal,systemId:segments[2],operationId:segments[4],input:data.input,idempotencyKey:request.headers.get('idempotency-key')??undefined});
        return reply(value.state==='queried'?200:202,value);
      }
      if (request.method==='GET' && url.pathname==='/v1/actions') {
        const principal=await guard(authenticate,request);
        return reply(200,{actions:await actionCenter.list({tenant:principal.tenant,actor:principal.actor})});
      }
      if (request.method==='POST' && url.pathname==='/v1/actions/invoke') {
        const principal=await guard(authenticate,request);
        const {data}=await readJson(request);
        if (Object.keys(data).some(x=>!['source','subject','revision','action','purpose'].includes(x))) throw new TypeError('unexpected action fields');
        const result=await actionCenter.invoke({tenant:principal.tenant,actor:principal.actor,...data,idempotencyKey:request.headers.get('idempotency-key')});
        return reply(202,result);
      }
      if (request.method==='POST' && url.pathname.startsWith('/v1/producers/')) {
        const segments=url.pathname.split('/').filter(Boolean);
        if (segments.length!==4 || segments[3]!=='events' || !verifyProducer) return reply(404,{error:{code:'not_found'}});
        const source=segments[2];
        const {data,bytes}=await readJson(request);
        const proof=await verifyProducer({request,source,rawBody:bytes});
        if (!proof || proof.verified!==true || proof.source!==source || proof.tenant!==data.payload?.tenant) throw new Error('not authorized');
        if (Object.keys(data).some(x=>!['eventId','payload'].includes(x))) throw new TypeError('unexpected event fields');
        return reply(202,actionCenter.ingest(source,data.eventId,data.payload));
      }
      return reply(404,{error:{code:'not_found'}});
    } catch(error) {
      const [status,kind]=code(error);
      return reply(status,{error:{code:kind}});
    }
  };
}

/** Minimal JSON-RPC Streamable HTTP MCP endpoint for 2026-07-28.
 * Call authorization goes through gateway.invoke; discovery is separately
 * filterable and never assumes a tool implies permission to a resource. */
export function createMcpHttpHandler({gateway,authenticate,canDiscover=async()=>false,allowOrigins=[]}) {
  if (typeof authenticate!=='function'||typeof canDiscover!=='function') throw new TypeError('authenticated MCP ports required');
  const descriptors=mcpDescriptors(gateway);
  return async request=>{
    try {
      checkOrigin(request,allowOrigins);
      if(request.method!=='POST') return reply(405,{error:{code:'method_not_allowed'}});
      if(request.headers.get('mcp-protocol-version')!=='2026-07-28') return reply(400,{error:{code:'unsupported_protocol'}});
      const {data}=await readJson(request);
      if(data.jsonrpc!=='2.0'||typeof data.method!=='string'||request.headers.get('mcp-method')!==data.method) return reply(400,{error:{code:'invalid_jsonrpc'}});
      if(data.method==='tools/call' && request.headers.get('mcp-name')!==data.params?.name) return reply(400,{error:{code:'mcp_name_mismatch'}});
      const principal=await guard(authenticate,request);
      if(data.id===undefined) return new Response(null,{status:202,headers:{'cache-control':'no-store'}});
      let result;
      if(data.method==='initialize') {
        result={protocolVersion:'2026-07-28',capabilities:{tools:{listChanged:false}},serverInfo:{name:'forge-composed-systems',version:'0.1.0'}};
      } else if(data.method==='tools/list') {
        const tools=[];
        for(const descriptor of descriptors) {
          if(await canDiscover({principal,systemId:descriptor._binding.systemId,operationId:descriptor._binding.operationId})===true) {
            const {_binding,...publicTool}=descriptor;tools.push(publicTool);
          }
        }
        result={tools};
      } else if(data.method==='tools/call') {
        const tool=descriptors.find(t=>t.name===data.params?.name);
        if(!tool || await canDiscover({principal,systemId:tool._binding.systemId,operationId:tool._binding.operationId})!==true) throw new Error('operation not installed');
        const input=data.params?.arguments;
        if (!input||typeof input!=='object'||Array.isArray(input) ||Object.keys(input).some(x=>!['input','idempotencyKey'].includes(x))) throw new TypeError('invalid tool envelope');
        const value=await callMcpTool({gateway,descriptors,principal,toolName:tool.name,arguments:input.input,idempotencyKey:input.idempotencyKey});
        result={content:[{type:'text',text:JSON.stringify(value)}],structuredContent:value,isError:false};
      } else return reply(400,{jsonrpc:'2.0',id:data.id,error:{code:-32601,message:'Method not found'}});
      return reply(200,{jsonrpc:'2.0',id:data.id,result});
    } catch(error) {
      const [status,kind]=code(error);
      return reply(status,{error:{code:kind}});
    }
  };
}
