import {describe,expect,it} from "vitest";
import {oauthPkceClient,type OAuthPkceConfig,type OAuthPkcePending} from "../src/oauth-code-pkce.js";

const issuer="https://id.example.test/tenant";
const resource="https://api.example.test/orders";
const callback="https://client.example.test/oauth/callback";
const now=1700000000000;
const sessionBinding="trusted-session-12345678901234567890";
function fixture(overrides:Partial<OAuthPkceConfig>={},result:Record<string,unknown>={
  access_token:"opaque-access",token_type:"Bearer",expires_in:120,scope:"orders:read",
}){
  const pending=new Map<string,OAuthPkcePending>();
  const exchanges:{url:string;body:URLSearchParams;init:RequestInit}[]=[];
  const config:OAuthPkceConfig={
    issuer,clientId:"registered-public-agent",
    authorizationEndpoint:"https://id.example.test/tenant/authorize",
    tokenEndpoint:"https://id.example.test/tenant/token",
    redirectUri:callback,resource,allowedScopes:["orders:read","orders:write"],
    now:()=>now,
    store:{
      put:async(entry)=>{if(pending.has(entry.state))throw Error("duplicate state");pending.set(entry.state,entry);},
      take:async(state)=>{const existing=pending.get(state)??null;pending.delete(state);return existing;},
    },
    fetcher:async(input,init)=>{
      exchanges.push({url:String(input),body:new URLSearchParams(String(init?.body)),init:init??{}});
      return Response.json(result);
    },
    ...overrides,
  };
  const rawClient=oauthPkceClient(config);
  return {pending,exchanges,rawClient,client:{
    start:(scopes:readonly string[])=>rawClient.start(scopes,sessionBinding),
    callback:(url:string)=>rawClient.callback(url,sessionBinding),
  }};
}
const response=(state:string,params:Record<string,string>={})=>{
  const url=new URL(callback);
  url.searchParams.set("state",state);
  url.searchParams.set("code","opaque-authorization-code");
  url.searchParams.set("iss",issuer);
  for(const [k,v] of Object.entries(params))url.searchParams.set(k,v);
  return url.href;
};
describe("registered OAuth Code + PKCE + resource client",()=>{
  it("publishes S256 only and redeems single-use verified state and issuer",async()=>{
    const f=fixture();
    const started=await f.client.start(["orders:read"]);
    const url=new URL(started.url);
    expect(url.origin).toBe("https://id.example.test");
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("client_id")).toBe("registered-public-agent");
    expect(url.searchParams.get("redirect_uri")).toBe(callback);
    expect(url.searchParams.get("scope")).toBe("orders:read");
    expect(url.searchParams.get("resource")).toBe(resource);
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(started.state).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const entry=f.pending.get(started.state)!;
    const digest=await crypto.subtle.digest("SHA-256",new TextEncoder().encode(entry.verifier));
    expect(url.searchParams.get("code_challenge")).toBe(Buffer.from(digest).toString("base64url"));
    expect(started.url).not.toContain(entry.verifier);
    const token=await f.client.callback(response(started.state));
    expect(token).toMatchObject({
      tokenType:"Bearer",issuer,resource,scopes:["orders:read"],accessToken:"opaque-access",
    });
    expect(f.exchanges).toHaveLength(1);
    expect(f.exchanges[0]!.body.get("code_verifier")).toBe(entry.verifier);
    expect(f.exchanges[0]!.body.get("grant_type")).toBe("authorization_code");
    expect(f.exchanges[0]!.body.get("resource")).toBe(resource);
    expect(f.exchanges[0]!.init.redirect).toBe("manual");
    await expect(f.client.callback(response(started.state))).rejects.toThrow(/state/);
    expect(f.exchanges).toHaveLength(1);
  });
  it("rejects scope expansion before beginning the flow",async()=>{
    const f=fixture();
    await expect(f.client.start(["admin:*"])).rejects.toThrow(/scope/);
    await expect(f.client.start(["orders:read","orders:read"])).rejects.toThrow(/scope/);
    expect(f.pending.size).toBe(0);
  });
  it("rejects callback issuer mixup, csrf and redirect substitutions",async()=>{
    const f=fixture();
    const one=await f.client.start(["orders:read"]);
    await expect(f.client.callback(response(one.state,{iss:"https://evil.example.test"}))).rejects.toThrow(/issuer/);
    await expect(f.client.callback(response(one.state))).rejects.toThrow(/state/);
    const two=await f.client.start(["orders:read"]);
    await expect(f.client.callback(response(two.state).replace("client.example.test","other.example.test"))).rejects.toThrow(/redirect/);
    const three=await f.client.start(["orders:read"]);
    const u=new URL(response(three.state));u.searchParams.delete("iss");
    await expect(f.client.callback(u.href)).rejects.toThrow(/issuer/);
    expect(f.exchanges).toHaveLength(0);
  });
  it("refuses tokens with expanded scopes, bad types, refresh tokens or TTL",async()=>{
    for(const bad of [
      {access_token:"tok",token_type:"Bearer",expires_in:100,scope:"orders:read orders:write"},
      {access_token:"tok",token_type:"DPoP",expires_in:100,scope:"orders:read"},
      {access_token:"tok",token_type:"Bearer",expires_in:4000,scope:"orders:read"},
      {access_token:"tok",token_type:"Bearer",expires_in:100,scope:"orders:read",refresh_token:"surprise"},
      {access_token:"",token_type:"Bearer",expires_in:100,scope:"orders:read"},
    ]){
      const f=fixture({},bad),started=await f.client.start(["orders:read"]);
      await expect(f.client.callback(response(started.state))).rejects.toThrow();
    }
  });
  it("fails closed for missing codes, stale state and unexpected callback params",async()=>{
    let clock=now;
    const f=fixture({ttlMs:10_000,now:()=>clock});
    const started=await f.client.start(["orders:read"]);
    clock+=20_000;
    await expect(f.client.callback(response(started.state))).rejects.toThrow(/expired or replayed/);
    const fresh=await f.client.start(["orders:read"]);
    const codeMissing=new URL(response(fresh.state));codeMissing.searchParams.delete("code");
    await expect(f.client.callback(codeMissing.href)).rejects.toThrow();
    const f2=fixture();
    const next=await f2.client.start(["orders:read"]);
    const noisy=response(next.state,{token:"from-url"});
    await expect(f2.client.callback(noisy)).rejects.toThrow(/parameters/);
    expect(f2.exchanges).toHaveLength(0);
  });
  it("binds callbacks to the initiating authenticated browser session",async()=>{
    const f=fixture();
    const started=await f.client.start(["orders:read"]);
    await expect(f.rawClient.callback(response(started.state),"different-session-12345678901234567890")).rejects.toThrow(/state/);
    await expect(f.client.callback(response(started.state))).rejects.toThrow(/state/);
    expect(f.exchanges).toHaveLength(0);
  });
  it("does not trust AS endpoint URLs from callbacks or unreviewed origins",()=>{
    expect(()=>fixture({tokenEndpoint:"https://evil.example.test/token"})).toThrow(/issuer origin/);
    expect(()=>fixture({redirectUri:"http://localhost/cb"})).toThrow(/HTTPS/);
  });
});
