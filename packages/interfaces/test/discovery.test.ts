import {describe,expect,it} from "vitest";
import {authorizationServerUrl,protectedResourceUrl,discoverApi,previewPublicCatalog,DiscoveryError,
  type DiscoveryTrust} from "../src/discovery.js";

const origin="https://api.example.test";
const resource=origin+"/orders";
const issuer="https://login.example.test/tenant";
const catalogUrl=origin+"/.well-known/api-catalog";
const resourceUrl=origin+"/.well-known/oauth-protected-resource/orders";
const issuerUrl="https://login.example.test/.well-known/oauth-authorization-server/tenant";
const catalog={
  linkset:[
    {anchor:catalogUrl,
      item:[{href:resource}],
      "api-catalog":[{href:origin+"/other/catalog"}]},
    {anchor:resource,
      "service-desc":[{href:origin+"/orders/openapi.json",type:"application/json"}],
      "service-doc":[{href:"https://docs.example.test/orders",type:"text/html"}]},
  ],
};
const resourceMetadata={
  resource,
  authorization_servers:[issuer],
  scopes_supported:["orders:read","orders:write","orders:refund"],
};
const asMetadata={
  issuer,
  authorization_endpoint:"https://login.example.test/tenant/authorize",
  token_endpoint:"https://login.example.test/tenant/token",
  jwks_uri:"https://login.example.test/tenant/keys",
  response_types_supported:["code"],
  grant_types_supported:["authorization_code","refresh_token"],
  code_challenge_methods_supported:["S256"],
};
type FixtureOptions={
  catalog?:unknown;
  resource?:unknown;
  as?:unknown;
  statuses?:Record<string,number>;
  mime?:Record<string,string>;
};
function fixture(opts:FixtureOptions={}){
  const paths:string[]=[];
  const store=new Map<string,unknown>([
    [catalogUrl,opts.catalog??catalog],
    [resourceUrl,opts.resource??resourceMetadata],
    [issuerUrl,opts.as??asMetadata],
  ]);
  const fetcher:typeof fetch=async(input,init)=>{
    const target=String(input);
    paths.push(target);
    expect(init?.redirect).toBe("manual");
    expect(init?.method).toBe("GET");
    expect(init?.credentials).toBe("omit");
    expect(init?.headers).toMatchObject({accept:target===catalogUrl?
      "application/linkset+json":"application/json"});
    if(!store.has(target))throw Error("unauthorized network fetch "+target);
    const body=store.get(target);
    const contentType=opts.mime?.[target]??(target===catalogUrl?
      "application/linkset+json":"application/json");
    return new Response(JSON.stringify(body),{
      status:opts.statuses?.[target]??200,
      headers:{"content-type":contentType},
    });
  };
  const trust:DiscoveryTrust={
    origin,resource,issuer,approvedScopes:["orders:read"],
    allowedOrigins:[origin,"https://docs.example.test"],fetcher
  };
  return {paths,trust,fetcher};
}
const rejected=async(p:Promise<unknown>,pattern?:RegExp)=>{
  await expect(p).rejects.toBeInstanceOf(DiscoveryError);
  if(pattern)await expect(p).rejects.toThrow(pattern);
};
describe("origin-first public catalog preview",()=>{
  it("discovers only a public catalog without any issuer pin or credentials",async()=>{
    const f=fixture();
    const result=await previewPublicCatalog({
      origin,allowedLinkOrigins:["https://docs.example.test"],fetcher:f.fetcher,
    });
    expect(result.reviewRequired).toBe(true);
    expect(result.services[0]?.endpoint).toBe(resource);
    expect(f.paths).toEqual([catalogUrl]);
    expect(JSON.stringify(result)).not.toContain("authorizationEndpoint");
  });
  it("rejects origin URLs, internal hostnames and cross-origin links without review",async()=>{
    const f=fixture();
    await rejected(previewPublicCatalog({origin:"https://127.0.0.1",fetcher:f.fetcher}));
    await rejected(previewPublicCatalog({origin:"http://api.example.test",fetcher:f.fetcher}));
    expect(f.paths).toEqual([]);
    await rejected(previewPublicCatalog({origin,fetcher:f.fetcher}),/unreviewed_link_origin/);
    expect(f.paths).toEqual([catalogUrl]);
  });
});
describe("trust-pinned API and OAuth discovery",()=>{
  it("generates origin-rooted and path-specific well-known locations",()=>{
    expect(protectedResourceUrl(resource)).toBe(resourceUrl);
    expect(protectedResourceUrl(origin)).toBe(origin+"/.well-known/oauth-protected-resource");
    expect(authorizationServerUrl(issuer)).toBe(issuerUrl);
    expect(authorizationServerUrl("https://login.example.test"))
      .toBe("https://login.example.test/.well-known/oauth-authorization-server");
  });
  it("fetches precisely the three approved well-known documents, never follows nested/description links",async()=>{
    const f=fixture();
    const snapshot=await discoverApi(f.trust);
    expect(f.paths).toEqual([catalogUrl,resourceUrl,issuerUrl]);
    expect(snapshot.catalogUrl).toBe(catalogUrl);
    expect(snapshot.services).toEqual([{endpoint:resource,
      descriptions:[origin+"/orders/openapi.json"],
      docs:["https://docs.example.test/orders"]}]);
    expect(snapshot.nestedCatalogs).toEqual([origin+"/other/catalog"]);
    expect(snapshot.oauth).toEqual({
      resource,issuer,
      authorizationEndpoint:asMetadata.authorization_endpoint,
      tokenEndpoint:asMetadata.token_endpoint,
      jwksUri:asMetadata.jwks_uri,
      supportedScopes:resourceMetadata.scopes_supported,pkceS256:true,
    });
    expect(JSON.stringify(snapshot)).not.toContain("access_token");
  });
  it("rejects malicious origin, resource, issuer and catalog allowlists before any fetch",async()=>{
    for(const override of [
      {origin:"http://api.example.test"},
      {origin:"https://127.0.0.1"},
      {origin:"https://api.example.test/private"},
      {resource:"https://evil.example.test/orders"},
      {issuer:"http://localhost/auth"},
      {allowedOrigins:["https://evil.example.test"]},
      {allowedOrigins:[origin,"https://127.0.0.1"]},
      {approvedScopes:["bad scope"]},
    ]) {
      const f=fixture();
      await rejected(discoverApi({...f.trust,...override}));
      expect(f.paths).toHaveLength(0);
    }
  });
  it("rejects cross-origin link injection, private link or undocumented operation enumerations",async()=>{
    const bads=[
      {linkset:[{anchor:catalogUrl,item:[{href:"https://private.internal/secrets"}]}]},
      {linkset:[{anchor:catalogUrl,item:[{href:"https://evil.example.test/hidden"}]}]},
      {linkset:[{anchor:catalogUrl,item:[{href:"http://api.example.test/orders"}]}]},
      {linkset:[{anchor:"https://evil.example.test",item:[{href:resource}]}]},
      {linkset:[]},
      {linkset:[{anchor:catalogUrl,"service-doc":[{href:"https://docs.example.test"}]}]},
    ];
    for(const value of bads) {
      const f=fixture({catalog:value});
      await rejected(discoverApi(f.trust));
      expect(f.paths).toEqual([catalogUrl]);
    }
  });
  it("rejects spoofed resource identifiers and opportunistic issuer discovery",async()=>{
    for(const value of [
      {...resourceMetadata,resource:"https://evil.example.test/orders"},
      {...resourceMetadata,authorization_servers:["https://evil.example.test"]},
      {...resourceMetadata,scopes_supported:["unknown:admin"]},
    ]) {
      const f=fixture({resource:value});
      await rejected(discoverApi(f.trust));
      expect(f.paths).toEqual([catalogUrl,resourceUrl]);
    }
  });
  it("rejects issuer mixup, off-origin endpoints and missing PKCE or code support",async()=>{
    for(const value of [
      {...asMetadata,issuer:"https://attacker.example.test"},
      {...asMetadata,token_endpoint:"https://evil.example.test/token"},
      {...asMetadata,authorization_endpoint:"https://127.0.0.1/authorize"},
      {...asMetadata,code_challenge_methods_supported:["plain"]},
      {...asMetadata,response_types_supported:["token"]},
      {...asMetadata,grant_types_supported:["client_credentials"]},
    ]) {
      const f=fixture({as:value});
      await rejected(discoverApi(f.trust));
      expect(f.paths).toEqual([catalogUrl,resourceUrl,issuerUrl]);
    }
  });
  it("rejects redirects, incorrect media types, malformed and excessive responses",async()=>{
    for(const settings of [
      {statuses:{[catalogUrl]:302}},
      {mime:{[catalogUrl]:"application/json"}},
      {mime:{[resourceUrl]:"text/html"}},
    ]) {
      const f=fixture(settings);
      await rejected(discoverApi(f.trust));
    }
    const f=fixture();
    const hugeFetch:typeof fetch=async()=>new Response("x".repeat(150000),{
      headers:{"content-type":"application/linkset+json"}
    });
    await rejected(discoverApi({...f.trust,fetcher:hugeFetch}));
  });
});
