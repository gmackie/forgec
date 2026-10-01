/** Disposable authenticated qualification host; not an application endpoint. */
import { VersionedArtifactReader } from '../../packages/runtime/src/versioned-artifacts.js';
import { cloudflareArtifactsReader, type CloudflareArtifactsBinding } from '../../packages/runtime/src/adapters/cloudflare-artifacts.js';
import { ForgeError } from '../../packages/runtime/src/errors.js';
interface Env { ARTIFACTS: CloudflareArtifactsBinding; QUALIFICATION_SECRET: string; REPO_NAME: string; REPO_ID: string }
export default { async fetch(request: Request, env: Env): Promise<Response> {
  const reply=(status:number,value:unknown)=>Response.json(value,{status,headers:{'cache-control':'no-store'}});
  if(request.headers.get('authorization')!==`Bearer ${env.QUALIFICATION_SECRET}`)return reply(401,{code:'Unauthenticated'});
  if(request.method!=='POST')return reply(405,{code:'MethodNotAllowed'});
  const raw=await request.text();if(raw.length>8192)return reply(413,{code:'PayloadTooLarge'});
  try {
    const input=JSON.parse(raw);
    const reader=new VersionedArtifactReader([{tenant:'qualification',artifact:'fixture',generation:'one',repositoryId:env.REPO_ID,provider:cloudflareArtifactsReader(env.ARTIFACTS,env.REPO_NAME)}],async()=>input.deny!==true);
    const ctx={tenant:input.tenant??'qualification',actor:'qualification',requestId:'qualification'};
    if(input.action==='resolve')return reply(200,await reader.resolve('fixture',input.selector??'main',ctx));
    if(input.action==='history')return reply(200,await reader.history(input.pin,ctx,{maxCommits:input.maxCommits??32}));
    if(input.action==='file') {const result=await reader.readFile(input.pin,input.path,ctx,{maxBytes:input.maxBytes??1024});return reply(200,{bytes:Array.from(result.bytes)});}
    return reply(400,{code:'MalformedRequest'});
  } catch(error) {
    if(error instanceof ForgeError)return reply(error.status,{code:error.code});
    return reply(500,{code:'Internal'});
  }
}};
