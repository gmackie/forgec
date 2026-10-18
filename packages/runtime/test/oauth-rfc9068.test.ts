import {describe,expect,it} from "vitest";
import {rfc9068AuthHost} from "../src/oauth-rfc9068.js";
import {checkPublishedOAuth} from "../src/oauth-operation.js";
import {validateApiPublication} from "../src/api-publication.js";
import {ForgeError} from "../src/errors.js";
import type {Principal} from "../src/http.js";

const now=1_700_000_000_000;
const issuer="https://issuer.example.test",resource="https://api.example.test/orders";
const signer=await crypto.subtle.generateKey({
  name:"RSASSA-PKCS1-v1_5",modulusLength:2048,
  publicExponent:new Uint8Array([1,0,1]),hash:"SHA-256",
},true,["sign","verify"]);
const attacker=await crypto.subtle.generateKey({
  name:"RSASSA-PKCS1-v1_5",modulusLength:2048,
  publicExponent:new Uint8Array([1,0,1]),hash:"SHA-256",
},true,["sign","verify"]);
const jwk={...await crypto.subtle.exportKey("jwk",signer.publicKey),kid:"k1",alg:"RS256",use:"sig"};
const encoder=(v:unknown)=>Buffer.from(JSON.stringify(v)).toString("base64url");
const standard={
  iss:issuer,sub:"person-1",aud:resource,client_id:"agent-1",
  jti:"issued-token-123",iat:now/1000-10,exp:now/1000+120,
  scope:"orders:read",
};
async function mint(changes:Record<string,unknown>={},header:Record<string,unknown>={},
  key:CryptoKey=signer.privateKey){
  const input=encoder({typ:"at+jwt",alg:"RS256",kid:"k1",...header})+"."+encoder({...standard,...changes});
  const signed=await crypto.subtle.sign("RSASSA-PKCS1-v1_5",key,new TextEncoder().encode(input));
  return input+"."+Buffer.from(signed).toString("base64url");
}
const request=(token:string,others:Record<string,string>={})=>new Request(resource,{
  headers:{authorization:"Bearer "+token,...others}
});
function host(onResolved?:()=>void){
  return rfc9068AuthHost({
    issuer,resource,algorithm:"RS256",publicKeys:[jwk],allowedClients:["agent-1"],now:()=>now,
    async resolvePrincipal(identity) {
      onResolved?.();
      expect(identity.issuer).toBe(issuer);
      expect(identity.subject).toBe("person-1");
      expect(identity.clientId).toBe("agent-1");
      expect(identity.audiences).toContain(resource);
      // Trusted directory mapping; do NOT trust arbitrary tenant/role JWT claims.
      return {tenant:"acme",actor:"person-1"};
    },
  });
}
const pub=validateApiPublication({
  version:"forge-api-publication/1",resource,authorizationServers:[issuer],
  scopesSupported:["orders:read","orders:write"],
  services:[{endpoint:resource,serviceDesc:"https://api.example.test/forge/openapi.json",visibility:"public"}],
  operations:{
    "Order.get":{visibility:"oauth2",scopes:["orders:read"]},
    "Order.create":{visibility:"oauth2",scopes:["orders:write"]},
  },
},new Set(["Order.get","Order.create"]));

describe("RFC 9068 JWT access-token AuthHost",()=>{
  it("verifies signature/type/issuer/audience/scopes and populates the shared OAuth gate",async()=>{
    const verified=await host().authenticate(request(await mint({tenant:"forged",roles:["admin"]})));
    expect(verified).not.toBeInstanceOf(ForgeError);
    const principal=verified as Principal;
    expect(principal.tenant).toBe("acme");
    expect(principal.actor).toBe("person-1");
    expect(principal.verifiedOAuth).toMatchObject({
      tokenType:"access-token",issuer,clientId:"agent-1",
      audiences:[resource],scopes:["orders:read"],
    });
    expect(checkPublishedOAuth(pub,"Order.get",principal.verifiedOAuth,now)).toBeNull();
    expect(checkPublishedOAuth(pub,"Order.create",principal.verifiedOAuth,now)?.code).toBe("NotPermitted");
    expect(JSON.stringify(principal)).not.toContain("forged");
  });
  it("never calls trusted PIP mapping for invalid signatures, clients, token profiles or claims",async()=>{
    let calls=0;
    const adapter=host(()=>calls++);
    const altered=[
      await mint({iss:"https://evil.example.test"}),
      await mint({aud:"https://other.example.test"}),
      await mint({client_id:"unknown-agent"}),
      await mint({sub:""}),
      await mint({jti:""}),
      await mint({scope:"orders:read  orders:write"}),
      await mint({exp:now/1000-1}),
      await mint({iat:now/1000+120}),
      await mint({exp:now/1000+10000}),
      await mint({nonce:"oidc"}),
      await mint({cnf:{jkt:"unverified"}}),
      await mint({act:{sub:"unverified-agent"}}),
      await mint({}, {typ:"JWT"}),
      await mint({}, {kid:"unknown"}),
      await mint({}, {jku:"https://evil.example.test/keys"}),
      await mint({}, {}, attacker.privateKey),
    ];
    for(const t of altered) {
      const result=await adapter.authenticate(request(t));
      expect(result).toBeInstanceOf(ForgeError);
      expect((result as ForgeError).code).toBe("Unauthenticated");
    }
    expect(calls).toBe(0);
  });
  it("rejects mixed authentication, malformed bearer and PIP unavailability",async()=>{
    const token=await mint();
    const adapter=host();
    expect(await adapter.authenticate(request(token,{
      "cf-access-jwt-assertion":"bogus",
    }))).toBeInstanceOf(ForgeError);
    expect(await adapter.authenticate(new Request(resource,{headers:{authorization:"Bearer bad token"}}))).toBeInstanceOf(ForgeError);
    const unavailable=rfc9068AuthHost({
      issuer,resource,algorithm:"RS256",publicKeys:[jwk],now:()=>now,
      async resolvePrincipal(){throw new Error("Directory unavailable");},
    });
    expect(await unavailable.authenticate(request(token))).toBeInstanceOf(ForgeError);
  });
  it("refuses untrusted signing keys and invalid host configuration up front",()=>{
    expect(()=>rfc9068AuthHost({
      issuer,resource,algorithm:"RS256",publicKeys:[{...jwk,d:"private-secret"}],
      resolvePrincipal:async()=>({tenant:"acme",actor:"alice"}),
    })).toThrow();
    expect(()=>rfc9068AuthHost({
      issuer:"http://localhost",resource,algorithm:"RS256",publicKeys:[jwk],
      resolvePrincipal:async()=>({tenant:"acme",actor:"alice"}),
    })).toThrow();
  });
});
