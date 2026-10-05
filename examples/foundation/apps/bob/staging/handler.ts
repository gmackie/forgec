import { timingSafeEqual } from 'node:crypto';
export interface Binding { taskRunId:string;userId:string;workspaceId:string;sessionId:string;planningItemId:string;fulfillmentId:string }
export interface Fact { taskRunId:string;userId:string;workspaceId:string;sessionId:string;planningItemId:string;completedAt:string }
export function completionHandler(secret:string,bindings:Binding[],record:(binding:Binding,fact:Fact)=>Promise<{fulfillmentEndId:string;runLinkId:string}>) {
 if(secret.length<1) throw new Error('Service secret required');
 return async(request:Request):Promise<Response>=>{
  const reply=(status:number,body:unknown)=>Response.json(body,{status,headers:{'cache-control':'private, no-store'}});
  const a=Buffer.from(request.headers.get('authorization')??''),b=Buffer.from('Bearer '+secret);
  if(a.length!==b.length||!timingSafeEqual(a,b))return reply(401,{error:'Unauthorized'});
  if(request.method!=='POST'||new URL(request.url).pathname!=='/completion')return reply(404,{error:'Not found'});
  let fact:Fact;
  try{
   const raw=await request.text();if(raw.length>8192)return reply(413,{error:'Too large'});
   const v=JSON.parse(raw);const keys=['taskRunId','userId','workspaceId','sessionId','planningItemId','completedAt'];
   if(!v||Object.keys(v).length!==keys.length||keys.some(k=>typeof v[k]!=='string'||!v[k])||!Number.isFinite(Date.parse(v.completedAt)))return reply(400,{error:'Invalid completion fact'});
   fact=v;
  }catch{return reply(400,{error:'Invalid completion fact'});}
  const binding=bindings.find(b=>['taskRunId','userId','workspaceId','sessionId','planningItemId'].every(k=>b[k as keyof Binding]===fact[k as keyof Fact]));
  if(!binding)return reply(403,{error:'No trusted run binding'});
  try{return reply(200,await record(binding,fact));}catch{return reply(503,{error:'Reconciliation failed; retry persisted run'});}
 };
}
