/**
 * X1: a synthetic but cryptographically real OAuth authorization server,
 * Authorization Code + PKCE client, RFC 9068 resource verifier, RFC 9727/9728
 * publication and AuthZEN PDP, all exercising one ForgeGraph HTTP/MCP engine.
 *
 * The AS and PDP transports are injected fixtures: this is NOT a claim about
 * interoperability with untested external providers or Gatekeeper's existing
 * restricted self-evaluation endpoint.
 */
import {readFileSync} from "node:fs";
import {resolve} from "node:path";
import {Effect} from "effect";
import {describe,expect,it} from "vitest";
import {
  Engine,MemoryStorage,Model,testLayer,
  oauthPkceClient,rfc9068AuthHost,authzenAuthorizer,
  createHttpHandler,validateApiPublication,type ApiPublicationProfile,
  type AppBundle,type OAuthPkcePending,
} from "@forgegraph/runtime";
import {createMcpServer,mcpHttp} from "../src/mcp.js";

const bundle=JSON.parse(readFileSync(resolve(import.meta.dirname,"..","..","..",
  "conformance","fixtures","acme-next.app.json"),"utf8")) as AppBundle;
const N="@acme/commerce-next/_",G="@acme/governance/_";
const issuer="https://as.example.test",resource="https://api.example.test";
const callback="https://agent.example.test/oauth/callback";
const sessionBinding="signed-in-user-session-1234567890";
const publicKeyPair=await crypto.subtle.generateKey({
  name:"RSASSA-PKCS1-v1_5",modulusLength:2048,
  publicExponent:new Uint8Array([1,0,1]),hash:"SHA-256"
},true,["sign","verify"]);
const publicJwk={...await crypto.subtle.exportKey("jwk",publicKeyPair.publicKey),
  kid:"as-key-1",alg:"RS256",use:"sig"};
const compact=(v:unknown)=>Buffer.from(JSON.stringify(v)).toString("base64url");
async function accessToken(scopes:readonly string[]):Promise<string>{
  const at=Math.floor(Date.now()/1000);
  const claims={
    iss:issuer,sub:"alice",aud:resource,
    client_id:"registered-agent",jti:crypto.randomUUID(),iat:at,exp:at+120,
    scope:scopes.join(" "),
  };
  const signing=compact({alg:"RS256",kid:"as-key-1",typ:"at+jwt"})+"."+compact(claims);
  const signature=await crypto.subtle.sign("RSASSA-PKCS1-v1_5",
    publicKeyPair.privateKey,new TextEncoder().encode(signing));
  return signing+"."+Buffer.from(signature).toString("base64url");
}
const doc=bundle.openapi as {paths:Record<string,Record<string,{operationId:string}>>};
function operationPath(operationId:string,method:string,id:string):string {
  for(const [path,verbs] of Object.entries(doc.paths)) {
    if(verbs[method]?.operationId===operationId) return path.replace("{id}",id);
  }
  throw Error("missing fixture OpenAPI binding: "+method+" "+operationId);
}
const publication:ApiPublicationProfile={
  version:"forge-api-publication/1",resource,authorizationServers:[issuer],
  scopesSupported:["contacts:read","contacts:write"],
  services:[{endpoint:resource+"/v1/contacts",serviceDesc:resource+"/forge/openapi.json",
    visibility:"public"}],
  operations:{
    [N+"/Contact.get"]:{visibility:"oauth2",scopes:["contacts:read"]},
    [N+"/Contact.update"]:{visibility:"oauth2",scopes:["contacts:write"]},
  },
};
const vetted=validateApiPublication(publication,new Set(Object.keys(publication.operations??{})));

async function createFixture(){
  const stored=new Map<string,OAuthPkcePending>();
  const grants=new Map<string,{challenge:string;scopes:string[]}>();
  const tokenRequests:string[]=[];
  const decisions:{subject:string;action:string}[]=[];
  let allowWrites=false,pdpOnline=true,accountActive=true;
  const client=oauthPkceClient({
    issuer,resource,clientId:"registered-agent",
    authorizationEndpoint:issuer+"/authorize",tokenEndpoint:issuer+"/token",
    redirectUri:callback,allowedScopes:["contacts:read","contacts:write"],
    store:{
      async put(entry){if(stored.has(entry.state))throw Error("replayed state");stored.set(entry.state,entry);},
      async take(state){const value=stored.get(state)??null;stored.delete(state);return value;},
    },
    fetcher:async(input,init)=>{
      expect(String(input)).toBe(issuer+"/token");
      expect(init?.redirect).toBe("manual");
      const params=new URLSearchParams(String(init?.body));
      const code=params.get("code")??"";
      const state=code.startsWith("auth-code-")?code.slice(10):"";
      const grant=grants.get(state);
      expect(grant).toBeDefined();
      expect(params.get("resource")).toBe(resource);
      const verifier=params.get("code_verifier")??"";
      const digest=await crypto.subtle.digest("SHA-256",new TextEncoder().encode(verifier));
      expect(Buffer.from(digest).toString("base64url")).toBe(grant!.challenge);
      grants.delete(state);
      tokenRequests.push(state);
      return Response.json({
        access_token:await accessToken(grant!.scopes),
        token_type:"Bearer",expires_in:120,scope:grant!.scopes.join(" "),
      });
    },
  });
  const issue=async(scopes:string[])=>{
    const started=await client.start(scopes,sessionBinding);
    const params=new URL(started.url).searchParams;
    const state=params.get("state")!;
    grants.set(state,{
      challenge:params.get("code_challenge")!,scopes:params.get("scope")!.split(" "),
    });
    const url=new URL(callback);
    url.searchParams.set("state",state);
    url.searchParams.set("code","auth-code-"+state);
    url.searchParams.set("iss",issuer);
    const result=await client.callback(url.href,sessionBinding);
    return result.accessToken;
  };
  const model=new Model(bundle);
  const engine=new Engine(model,testLayer(new MemoryStorage()),{oauthPublication:vetted});
  const maintenance={tenant:"t",actor:"maintenance",requestId:"seed",maintenance:true};
  const customer=await Effect.runPromise(engine.call(N+"/Customer.create",{
    code:"AAA",name:"A"
  },maintenance));
  const contact=await Effect.runPromise(engine.call(N+"/Contact.create",{
    customer:customer.id,name:"Ann",email:"ann@example.com"
  },maintenance));
  engine.gatekeeper.authorizer=authzenAuthorizer({
    endpoint:"https://pdp.example.test/access/v1/evaluation",epoch:1,
    credential:async()=> "server-owned-pdp-token",
    fetcher:async(input,init)=>{
      expect(String(input)).toBe("https://pdp.example.test/access/v1/evaluation");
      expect((init?.headers as Record<string,string>).authorization)
        .toBe("Bearer server-owned-pdp-token");
      if(!pdpOnline) throw Error("PDP temporarily unavailable");
      const body=JSON.parse(String(init?.body)) as {
        subject:{id:string};action:{name:string};
      };
      decisions.push({subject:body.subject.id,action:body.action.name});
      const denyWrite=body.action.name===N+"/Contact.update"&&!allowWrites;
      return Response.json({decision:!denyWrite});
    },
  });
  const auth=rfc9068AuthHost({
    issuer,resource,algorithm:"RS256",publicKeys:[publicJwk],
    allowedClients:["registered-agent"],
    async resolvePrincipal(identity){
      if(!accountActive || identity.subject!=="alice" ||
         identity.clientId!=="registered-agent") return null;
      return {tenant:"t",actor:"agent-7",purposes:[G+"/CustomerSupport"]};
    },
  });
  const mcp=createMcpServer({engine});
  const http=createHttpHandler(model,engine,{auth,publication,
    mounts:{"/forge/mcp":mcpHttp(mcp)}});
  const headers=(token:string)=>({
    authorization:"Bearer "+token,"x-forge-purpose":G+"/CustomerSupport",
  });
  const getPath=operationPath(N+"/Contact.get","get",contact.id);
  const updatePath=operationPath(N+"/Contact.update","patch",contact.id);
  const rpc=async(token:string,method:string,params:unknown={})=>{
    const res=await http(new Request(resource+"/forge/mcp",{
      method:"POST",headers:{...headers(token),"content-type":"application/json"},
      body:JSON.stringify({jsonrpc:"2.0",id:1,method,params}),
    }));
    expect(res.status).toBe(200);
    return res.json() as Promise<any>;
  };
  return {engine,http,issue,headers,contact,getPath,updatePath,rpc,
    tokenRequests,decisions,
    setPolicyAllowWrites:(v:boolean)=>{allowWrites=v;},
    setPdpOnline:(v:boolean)=>{pdpOnline=v;},
    setAccountActive:(v:boolean)=>{accountActive=v;},
  };
}

describe("X1 standards-first discovery → PKCE → JWT → AuthZEN → HTTP/MCP",()=>{
  it("serves public RFC 9727/9728 metadata while protecting runtime discovery",async()=>{
    const f=await createFixture();
    const catalog=await f.http(new Request(resource+"/.well-known/api-catalog"));
    expect(catalog.status).toBe(200);
    expect(catalog.headers.get("content-type")).toContain("application/linkset+json");
    const links=JSON.stringify(await catalog.json());
    expect(links).toContain("service-desc");
    expect(links).toContain("/v1/contacts");
    const head=await f.http(new Request(resource+"/.well-known/api-catalog",{method:"HEAD"}));
    expect(head.headers.get("link")).toContain("api-catalog");
    expect(await head.text()).toBe("");
    const meta=await f.http(new Request(resource+"/.well-known/oauth-protected-resource"));
    expect(await meta.json()).toMatchObject({resource,authorization_servers:[issuer]});
    const privateDiscovery=await f.http(new Request(resource+"/forge/discovery"));
    expect(privateDiscovery.status).toBe(401);
  });

  it("requires real scoped OAuth authorization AND AuthZEN policy across HTTP and MCP",async()=>{
    const f=await createFixture();
    const reader=await f.issue(["contacts:read"]);
    const got=await f.http(new Request(resource+f.getPath,{headers:f.headers(reader)}));
    expect(got.status).toBe(200);
    expect(await got.json()).toMatchObject({id:f.contact.id});
    const deniedScope=await f.http(new Request(resource+f.updatePath,{
      method:"PATCH",headers:{...f.headers(reader),"content-type":"application/json","if-match":"1"},
      body:JSON.stringify({email:"denied@example.com"}),
    }));
    expect(deniedScope.status).toBe(403);
    expect(deniedScope.headers.get("www-authenticate")).toContain("insufficient_scope");
    const toolsRead=await f.rpc(reader,"tools/list");
    expect(toolsRead.result.tools.map((t:{name:string})=>t.name)).toContain("contact_get");
    expect(toolsRead.result.tools.map((t:{name:string})=>t.name)).not.toContain("contact_update");
    const forgedToolCall=await f.rpc(reader,"tools/call",{
      name:"contact_update",arguments:{id:f.contact.id,expectedVersion:1,
        patch:{email:"mcp-scope-bypass@example.com"}},
    });
    expect(forgedToolCall.result.isError).toBe(true);
    const writer=await f.issue(["contacts:write"]);
    const deniedPolicy=await f.http(new Request(resource+f.updatePath,{
      method:"PATCH",headers:{...f.headers(writer),"content-type":"application/json","if-match":"1"},
      body:JSON.stringify({email:"policy-denied@example.com"}),
    }));
    expect(deniedPolicy.status).not.toBe(200);
    const unchanged=await f.http(new Request(resource+f.getPath,{headers:f.headers(reader)}));
    expect(unchanged.status).toBe(200);
    expect(await unchanged.json()).toMatchObject({email:"ann@example.com",version:1});
    f.setPolicyAllowWrites(true);
    const write=await f.http(new Request(resource+f.updatePath,{
      method:"PATCH",headers:{...f.headers(writer),"content-type":"application/json","if-match":"1"},
      body:JSON.stringify({email:"updated@example.com"}),
    }));
    expect(write.status).toBe(200);
    expect(await write.json()).toMatchObject({email:"updated@example.com",version:2});
    const visible=await f.rpc(writer,"tools/list");
    expect(visible.result.tools.map((t:{name:string})=>t.name)).toContain("contact_update");
    const mcpWrite=await f.rpc(writer,"tools/call",{
      name:"contact_update",arguments:{id:f.contact.id,expectedVersion:2,
        patch:{email:"via-mcp@example.com"}},
    });
    expect(mcpWrite.result.structuredContent).toMatchObject({
      email:"via-mcp@example.com",version:3,
    });
    const staleRetry=await f.rpc(writer,"tools/call",{
      name:"contact_update",arguments:{id:f.contact.id,expectedVersion:2,
        patch:{email:"duplicate-effect@example.com"}},
    });
    expect(staleRetry.result.isError).toBe(true);
    const stillCurrent=await f.http(new Request(resource+f.getPath,{headers:f.headers(reader)}));
    expect(await stillCurrent.json()).toMatchObject({email:"via-mcp@example.com",version:3});
    expect(f.tokenRequests).toHaveLength(2);
    expect(f.decisions.some(x=>x.subject==="agent-7" && x.action===N+"/Contact.update")).toBe(true);
  });

  it("rejects invalid credentials, revoked membership and unavailable PDP",async()=>{
    const f=await createFixture();
    const valid=await f.issue(["contacts:read"]);
    const bad=await f.http(new Request(resource+f.getPath,{headers:f.headers("untrusted-jwt")}));
    expect(bad.status).toBe(401);
    f.setAccountActive(false);
    const revoked=await f.http(new Request(resource+f.getPath,{headers:f.headers(valid)}));
    expect(revoked.status).toBe(401);
    f.setAccountActive(true);
    f.setPdpOnline(false);
    const unavailable=await f.http(new Request(resource+f.getPath,{headers:f.headers(valid)}));
    expect(unavailable.status).toBe(503);
  });
});
