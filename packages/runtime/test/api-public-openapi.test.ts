import {describe,expect,it} from "vitest";
import {validateApiPublication,type ApiPublicationProfile} from "../src/api-publication.js";
import {projectReviewedPublicOpenApi} from "../src/api-public-openapi.js";

const url="https://api.example.test";
const publication:ApiPublicationProfile={
  version:"forge-api-publication/1",resource:url,
  authorizationServers:["https://login.example.test"],
  scopesSupported:["orders:read","orders:write","admins:delete"],
  services:[{endpoint:url+"/orders",serviceDesc:url+"/forge/openapi.json",visibility:"public"}],
  operations:{
    "orders.list":{visibility:"oauth2",scopes:["orders:read"]},
    "orders.internal":{visibility:"private",scopes:[]},
  },
};
const verified=validateApiPublication(publication,new Set(Object.keys(publication.operations??{})));
const auth={
  issuer:"https://login.example.test",
  authorizationUrl:"https://login.example.test/authorize",
  tokenUrl:"https://login.example.test/token",
  scopeDescriptions:{"orders:read":"Read orders","orders:write":"Write orders","admins:delete":"Delete admins"},
};
function source():Record<string,unknown>{
  return {
    openapi:"3.1.0",
    info:{title:"Internal App",version:"0.5.0",description:"Secret description"},
    "x-internal-system":"not for public",
    paths:{
      "/orders":{
        get:{operationId:"orders.list",summary:"List orders",
          "x-debug-private-id":"SENSITIVE",
          responses:{"200":{description:"OK",content:{
            "application/json":{schema:{$ref:"#/components/schemas/Order"}}
          }}}},
        post:{operationId:"orders.internal",summary:"Internal create",
          responses:{"200":{description:"OK",content:{
            "application/json":{schema:{$ref:"#/components/schemas/AdminSecret"}}
          }}}},
      },
      "/private/admin":{
        delete:{operationId:"hidden.delete",summary:"Never published",
          responses:{"204":{description:"Deleted"}},
        },
      },
    },
    components:{schemas:{
      Order:{type:"object","x-internal":"secret",properties:{
        id:{type:"string",example:"leaked-id"},
        customer:{$ref:"#/components/schemas/Customer"},
      }},
      Customer:{type:"object",properties:{name:{type:"string"}}},
      AdminSecret:{type:"object",properties:{apiKey:{type:"string",default:"private-key"}}},
      UnusedInternal:{type:"object",properties:{password:{type:"string"}}},
    }},
  };
}
describe("public OpenAPI projection is review-first and redacted",()=>{
  it("returns only approved operations, transitive schemas and exact OAuth scopes",()=>{
    const original=source(),before=JSON.stringify(original);
    const projected=projectReviewedPublicOpenApi(original,verified,auth) as any;
    expect(JSON.stringify(original)).toBe(before);
    expect(Object.keys(projected.paths)).toEqual(["/orders"]);
    expect(Object.keys(projected.paths["/orders"])).toEqual(["get"]);
    expect(projected.paths["/orders"].get.security).toEqual([{forgeOAuth:["orders:read"]}]);
    expect(projected.components.securitySchemes.forgeOAuth.flows.authorizationCode.scopes)
      .toEqual({"orders:read":"Read orders"});
    expect(Object.keys(projected.components.schemas).sort()).toEqual(["Customer","Order"]);
    expect(projected.components.schemas.Order.properties.id.example).toBeUndefined();
    const raw=JSON.stringify(projected);
    for(const sensitive of ["AdminSecret","UnusedInternal","hidden.delete","private-key",
      "Internal App","not for public","SENSITIVE","leaked-id","admins:delete","orders:write"])
      expect(raw).not.toContain(sensitive);
    expect(projected.servers).toEqual([{url}]);
  });
  it("rejects unreviewed access-control overrides and external references",()=>{
    const preexisting=source() as any;
    preexisting.paths["/orders"].get.security=[];
    expect(()=>projectReviewedPublicOpenApi(preexisting,verified,auth))
      .toThrow(/unreviewed operation security/);
    const external=source() as any;
    external.components.schemas.Order.properties.customer.$ref="https://evil.example.test/schema";
    expect(()=>projectReviewedPublicOpenApi(external,verified,auth)).toThrow(/external or unresolved/);
    const missing=source() as any;
    missing.components.schemas.Order.properties.customer.$ref="#/components/schemas/NotFound";
    expect(()=>projectReviewedPublicOpenApi(missing,verified,auth)).toThrow(/missing referenced/);
  });
  it("rejects profiles referencing missing reviewed operations",()=>{
    const wrong=validateApiPublication({
      ...publication,operations:{
        ...publication.operations,
        "missing.read":{visibility:"oauth2",scopes:["orders:read"]},
      },
    },new Set([...Object.keys(publication.operations??{}),"missing.read"]));
    expect(()=>projectReviewedPublicOpenApi(source(),wrong,auth))
      .toThrow(/reviewed public operation missing/);
  });
});
