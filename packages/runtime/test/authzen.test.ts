import {describe, expect, it} from "vitest";
import {Effect} from "effect";
import {authzenAuthorizer} from "../src/authzen.js";
import type {AuthzRequest} from "../src/gatekeeper.js";
import {ForgeError} from "../src/errors.js";

const req: AuthzRequest = {
  principal: {tenant:"acme",actor:"subject-123",issuer:"https://id.example.test"},
  action:"orders.cancel",kind:"write",resource:"orders",
  current:{id:"order-1",status:"pending"},
  candidate:{id:"order-1",status:"cancelled"},
  purpose:"customer-support",attributes:[],requestId:"req-1",
};
const endpoint = "https://pdp.example.test/access/v1/evaluation";
const opts = (fetcher: typeof fetch) => ({endpoint,epoch:12,credential:async()=> "trusted-pdp-token",fetcher});

describe("standards-first AuthZEN client",()=>{
  it("emits an AuthZEN 1.0 request with server-only authorization and no record contents",async()=>{
    let called = 0;
    const fetcher: typeof fetch = async (input,init)=>{
      called++;
      expect(input).toBe(endpoint);
      expect(init?.redirect).toBe("manual");
      expect((init?.headers as Record<string,string>).authorization).toBe("Bearer trusted-pdp-token");
      const body = JSON.parse(String(init?.body));
      expect(body).toEqual({
        subject:{type:"user",id:"subject-123",properties:{tenant:"acme",issuer:"https://id.example.test"}},
        action:{name:"orders.cancel"},resource:{type:"orders",id:"order-1"},
        context:{tenant:"acme",operation:"orders.cancel",kind:"write",purpose:"customer-support"},
      });
      expect(JSON.stringify(body)).not.toContain("pending");
      return Response.json({decision:true});
    };
    const authorizer=authzenAuthorizer(opts(fetcher));
    const result=await Effect.runPromise(authorizer.decide(req));
    expect(result.effect).toBe("allow");
    expect(authorizer.liveAttributes).toBe(true);
    expect(authorizer.rowFilterFor(req.action,undefined,[])).toBeNull();
    await Effect.runPromise(authorizer.decide(req));
    expect(called).toBe(2);
  });
  it("maps a standard false decision to deny",async()=>{
    const a=authzenAuthorizer(opts(async()=>Response.json({decision:false})));
    expect((await Effect.runPromise(a.decide(req))).effect).toBe("deny");
  });
  it("fails closed on invalid, redirected, denied and malformed PDP replies",async()=>{
    const responses=[
      new Response("",{status:503,headers:{"content-type":"application/json"}}),
      Response.json({result:true}),
      new Response(JSON.stringify({decision:"yes"}),{headers:{"content-type":"application/json"}}),
      new Response('{"decision":true}',{headers:{"content-type":"text/html"}}),
      new Response(JSON.stringify({decision:true}),{headers:{"content-type":"application/json","content-length":"100000"}}),
    ];
    for (const response of responses) {
      const a=authzenAuthorizer(opts(async()=>response));
      await expect(Effect.runPromise(a.decide(req))).rejects.toBeInstanceOf(ForgeError);
    }
    const failed=authzenAuthorizer(opts(async()=>{throw new Error("offline");}));
    await expect(Effect.runPromise(failed.decide(req))).rejects.toBeInstanceOf(ForgeError);
  });
  it("requires explicit, canonical HTTPS PDP endpoint and valid epoch",()=>{
    expect(()=>authzenAuthorizer({...opts(async()=>Response.json({decision:true})),endpoint:"http://pdp.example.test/access/v1/evaluation"})).toThrow(/HTTPS/);
    expect(()=>authzenAuthorizer({...opts(async()=>Response.json({decision:true})),endpoint:"https://pdp.example.test/path?token=secret"})).toThrow(/HTTPS/);
    expect(()=>authzenAuthorizer({...opts(async()=>Response.json({decision:true})),epoch:-1})).toThrow(/epoch/);
  });
});
