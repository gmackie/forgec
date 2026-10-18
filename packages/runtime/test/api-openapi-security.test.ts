import {describe, expect, it} from "vitest";
import {validateApiPublication, type ApiPublicationProfile} from "../src/api-publication.js";
import {projectOpenApiOAuthSecurity, type OAuthServerPublication} from "../src/api-openapi-security.js";

const publication: ApiPublicationProfile = {
  version:"forge-api-publication/1",
  resource:"https://api.example.test/orders",
  authorizationServers:["https://login.example.test/tenant"],
  scopesSupported:["orders:read","orders:write"],
  services:[{endpoint:"https://api.example.test/orders",serviceDesc:"https://api.example.test/forge/openapi.json",visibility:"public"}],
  operations:{
    "acme.Order.list": {visibility:"oauth2",scopes:["orders:read"]},
    "acme.Order.create": {visibility:"oauth2",scopes:["orders:write"]},
    "acme.health": {visibility:"public",scopes:[]},
  },
};
const prof=validateApiPublication(publication,new Set(Object.keys(publication.operations??{})));
const issuer: OAuthServerPublication = {
  issuer:"https://login.example.test/tenant",
  authorizationUrl:"https://login.example.test/tenant/authorize",
  tokenUrl:"https://login.example.test/tenant/token",
  scopeDescriptions:{"orders:read":"Read orders","orders:write":"Create orders"},
};
const doc=() => ({
  openapi:"3.1.0",info:{title:"Orders",version:"1"},
  paths:{
    "/orders":{
      get:{operationId:"acme.Order.list",responses:{"200":{description:"OK"}}},
      post:{operationId:"acme.Order.create",responses:{"201":{description:"Created"}}},
    },
    "/health":{get:{operationId:"acme.health",responses:{"200":{description:"Healthy"}}}},
  },
  components:{schemas:{Order:{type:"object",properties:{id:{type:"string"}}}}},
});

describe("reviewed OAuth OpenAPI 3.1 security projection",()=>{
  it("adds exact scope requirements and retains unrelated contract fields without mutation",()=>{
    const input=doc(), before=JSON.stringify(input);
    const rendered=projectOpenApiOAuthSecurity(input,prof,issuer) as any;
    expect(JSON.stringify(input)).toBe(before);
    expect(rendered.paths["/orders"].get.security).toEqual([{forgeOAuth:["orders:read"]}]);
    expect(rendered.paths["/orders"].post.security).toEqual([{forgeOAuth:["orders:write"]}]);
    expect(rendered.paths["/health"].get.security).toEqual([]);
    expect(rendered.components.securitySchemes.forgeOAuth).toEqual({
      type:"oauth2",
      description:"Access tokens must target the published protected resource and satisfy server-side policy.",
      flows:{authorizationCode:{
        authorizationUrl:issuer.authorizationUrl,tokenUrl:issuer.tokenUrl,
        scopes:{"orders:read":"Read orders","orders:write":"Create orders"},
      }},
    });
    expect(rendered.components.schemas.Order).toEqual(input.components.schemas.Order);
  });
  it("fails rather than publishing inferred/mismatched security contracts",()=>{
    const bad=(profile=prof,document:unknown=doc(),auth=issuer)=>()=>projectOpenApiOAuthSecurity(document,profile,auth);
    expect(bad(prof,{...doc(),openapi:"3.2.0"})).toThrow(/OpenAPI 3.1/);
    const unknown:any=doc();unknown.paths["/orders"].get.operationId="unknown";
    expect(bad(prof,unknown)).toThrow(/unmapped operation/);
    const duplicate:any=doc();duplicate.paths["/health"].get.operationId="acme.Order.list";
    expect(bad(prof,duplicate)).toThrow(/duplicate/);
    const prior:any=doc();prior.paths["/orders"].get.security=[];
    expect(bad(prof,prior)).toThrow(/already declares security/);
    const wrongServer={...issuer,tokenUrl:"https://evil.example.test/token"};
    expect(bad(prof,doc(),wrongServer)).toThrow(/pinned issuer origin/);
    expect(bad(prof,doc(),{...issuer,issuer:"https://evil.example.test"})).toThrow(/unknown issuer/);
    const wrongRules=validateApiPublication({...publication,operations:{
      ...publication.operations,"not.in.openapi":{visibility:"oauth2",scopes:["orders:read"]},
    }},new Set([...Object.keys(publication.operations??{}),"not.in.openapi"]));
    expect(bad(wrongRules)).toThrow(/not in OpenAPI/);
    const privateRules=validateApiPublication({...publication,operations:{
      ...publication.operations,"acme.Order.list":{visibility:"private",scopes:[]},
    }},new Set(Object.keys(publication.operations??{})));
    expect(bad(privateRules)).toThrow(/private operation/);
    const collision:any=doc();collision.components.securitySchemes={forgeOAuth:{type:"apiKey"}};
    expect(bad(prof,collision)).toThrow(/already in use/);
  });
});
