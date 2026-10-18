import {readFileSync} from "node:fs";
import {resolve} from "node:path";
import {Effect} from "effect";
import {describe,expect,it} from "vitest";
import {Engine,MemoryStorage,Model,createHttpHandler,err,localAuthorizer,testLayer,validateApiPublication,
  type ApiPublicationProfile,type AuthHost,type AppBundle,type Principal} from "@forgegraph/runtime";
import {createMcpServer,mcpHttp} from "../src/mcp.js";

const bundle=JSON.parse(readFileSync(resolve(import.meta.dirname,"..","..","..","conformance","fixtures","acme-next.app.json"),"utf8")) as AppBundle;
const N="@acme/commerce-next/_", G="@acme/governance/_";
const target="https://api.example.test";
const profile:ApiPublicationProfile={
  version:"forge-api-publication/1",resource:target,authorizationServers:["https://id.example.test"],
  scopesSupported:["contact:read","contact:write"],
  services:[{endpoint:target+"/v1",serviceDesc:target+"/forge/openapi.json",visibility:"public"}],
  operations:{
    [N+"/Contact.get"]:{visibility:"oauth2",scopes:["contact:read"]},
    [N+"/Contact.update"]:{visibility:"oauth2",scopes:["contact:write"]},
  },
};
const pub=validateApiPublication(profile,new Set(Object.keys(profile.operations??{})));
const token=(scopes:string[]):NonNullable<Principal["verifiedOAuth"]>=>({
  tokenType:"access-token",issuer:"https://id.example.test",audiences:[target],scopes,
  clientId:"test-agent",expiresAt:Date.now()+300_000,
});
const auth:AuthHost={
  scheme:"bearer",
  async authenticate(request) {
    const credential=request.headers.get("authorization");
    if(!["Bearer read","Bearer write"].includes(credential??"")) return err("Unauthenticated","test verifier refused token");
    return {tenant:"t",actor:"agent-7",purposes:[G+"/CustomerSupport"],
      verifiedOAuth:token(credential==="Bearer read"?["contact:read"]:["contact:write"])};
  },
};
const getRoute=():string=>{
  const paths=(bundle.openapi as {paths:Record<string,Record<string,{operationId:string}>>}).paths;
  for(const [path,verbs] of Object.entries(paths))if(verbs.get?.operationId===N+"/Contact.get")return path;
  throw new Error("contact GET route missing in fixture");
};

describe("OAuth security parity through shared Engine.call",()=>{
  it("checks the same required scope for HTTP, MCP listings, and direct MCP calls",async()=>{
    const model=new Model(bundle),engine=new Engine(model,testLayer(new MemoryStorage()),{oauthPublication:pub});
    engine.gatekeeper.authorizer=localAuthorizer({epoch:1,knownObligations:[],pips:[],policies:[
      {id:"contact-policy",actions:[N+"/Contact.*"],requires:[],where:[]},
      {id:"customer-policy",actions:[N+"/Customer.*"],requires:[],where:[]},
    ]});
    const seed={tenant:"t",actor:"maintenance",requestId:"seed",maintenance:true};
    const customer=await Effect.runPromise(engine.call(N+"/Customer.create",{code:"AAA",name:"A"},seed));
    const contact=await Effect.runPromise(engine.call(N+"/Contact.create",{customer:customer.id,name:"Ann",email:"ann@example.test"},seed));
    const server=createMcpServer({engine});
    const handle=createHttpHandler(model,engine,{auth,mounts:{"/forge/mcp":mcpHttp(server)}});
    const path=getRoute().replace("{id}",contact.id);
    const headers=(credential:string)=>({authorization:credential,"x-forge-purpose":G+"/CustomerSupport"});
    const good=await handle(new Request(target+path,{headers:headers("Bearer read")}));
    expect(good.status).toBe(200);
    expect(await good.json()).toMatchObject({id:contact.id});
    const noRead=await handle(new Request(target+path,{headers:headers("Bearer write")}));
    expect(noRead.status).toBe(403);
    const rpc=async(credential:string,method:string,params:unknown)=>handle(new Request(target+"/forge/mcp",{
      method:"POST",headers:{...headers(credential),"content-type":"application/json"},
      body:JSON.stringify({jsonrpc:"2.0",id:1,method,params}),
    }));
    const listed=await (await rpc("Bearer read","tools/list",{})).json() as any;
    expect(listed.result.tools.map((t:{name:string})=>t.name)).toContain("contact_get");
    expect(listed.result.tools.map((t:{name:string})=>t.name)).not.toContain("contact_update");
    const listedWrite=await (await rpc("Bearer write","tools/list",{})).json() as any;
    expect(listedWrite.result.tools.map((t:{name:string})=>t.name)).not.toContain("contact_get");
    const invoke=await (await rpc("Bearer read","tools/call",{name:"contact_get",arguments:{id:contact.id}})).json() as any;
    expect(invoke.result.structuredContent).toMatchObject({id:contact.id});
    const denied=await (await rpc("Bearer write","tools/call",{name:"contact_get",arguments:{id:contact.id}})).json() as any;
    expect(denied.result.isError).toBe(true);
    const schema=await (await rpc("Bearer read","resources/read",{uri:"forge://openapi"})).json() as any;
    expect(schema.error.code).toBe(-32001);
    const unreviewed=engine.call(N+"/Customer.create",{code:"XYZ",name:"X"},{
      tenant:"t",actor:"agent-7",requestId:"unreviewed",verifiedOAuth:token(["contact:read"]),
    });
    await expect(Effect.runPromiseExit(unreviewed).then(x=>x._tag)).resolves.toBe("Failure");
  });
});
