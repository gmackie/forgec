import {describe, expect, it} from "vitest";
import {checkPublishedOAuth, type VerifiedOAuthAccess} from "../src/oauth-operation.js";
import {validateApiPublication, type ApiPublicationProfile} from "../src/api-publication.js";

const publication: ApiPublicationProfile = {
  version:"forge-api-publication/1",
  resource:"https://api.example.test/orders",
  authorizationServers:["https://login.example.test"],
  scopesSupported:["orders:read","orders:write"],
  services:[{endpoint:"https://api.example.test/orders",serviceDesc:"https://api.example.test/forge/openapi.json",visibility:"public"}],
  operations:{
    "orders.list":{visibility:"oauth2",scopes:["orders:read"]},
    "orders.create":{visibility:"oauth2",scopes:["orders:write"]},
    "health.read":{visibility:"public",scopes:[]},
    "orders.internal":{visibility:"private",scopes:[]},
  },
};
const p=validateApiPublication(publication,new Set(Object.keys(publication.operations??{})));
const now=1_700_000_000_000;
const token: VerifiedOAuthAccess={tokenType:"access-token",issuer:"https://login.example.test",audiences:[publication.resource],
  scopes:["orders:read"],clientId:"agent-1",expiresAt:now+300_000};
const check=(op:string, t?: VerifiedOAuthAccess)=>checkPublishedOAuth(p,op,t,now)?.code;

describe("verified OAuth publication enforcement",()=>{
  it("permits only reviewed public operations anonymously",()=>{
    expect(check("health.read")).toBeUndefined();
    expect(check("orders.list")).toBe("Unauthenticated");
    expect(check("orders.internal",token)).toBe("NotPermitted");
    expect(check("unknown",token)).toBe("NotPermitted");
  });
  it("requires issuer, audience, access-token type, expiry, client and exact scopes",()=>{
    expect(check("orders.list",token)).toBeUndefined();
    expect(check("orders.create",token)).toBe("NotPermitted");
    expect(check("orders.create",{...token,scopes:["orders:read","orders:write"]})).toBeUndefined();
    expect(check("orders.list",{...token,issuer:"https://evil.test"})).toBe("Unauthenticated");
    expect(check("orders.list",{...token,audiences:["https://api.example.test/other"]})).toBe("Unauthenticated");
    expect(check("orders.list",{...token,expiresAt:now-1})).toBe("Unauthenticated");
    expect(check("orders.list",{...token,clientId:""})).toBe("Unauthenticated");
    expect(check("orders.list",{...token,tokenType:"id-token" as "access-token"})).toBe("Unauthenticated");
  });
});
