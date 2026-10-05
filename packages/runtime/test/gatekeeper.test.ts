/**
 * M13 (PAR-108..115): trusted invocation context, typed authorizer decisions
 * with PIPs and obligations, per-record enforcement on current and candidate
 * state, decision-cache epochs, idempotency-receipt re-authorization, bounded
 * policy filtering, and honest assurance profiles.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Cause, Effect } from "effect";
import { beforeEach, describe, expect, it } from "vitest";
import { Model, type AppBundle } from "../src/model.js";
import { Engine, type CallContext } from "../src/engine.js";
import { ForgeError } from "../src/errors.js";
import { MemoryStorage } from "../src/adapters/memory.js";
import { testLayer } from "../src/testing.js";
import { createHttpHandler } from "../src/http.js";
import { jwtAuth, signTestJwt } from "../src/auth.js";
import { localAuthorizer, type Policy, type PipProvider } from "../src/gatekeeper.js";
import { assuranceProfile } from "../src/hosts/compose.js";

const bundle = JSON.parse(readFileSync(resolve(import.meta.dirname, "..", "..", "..", "conformance", "fixtures", "acme-next.app.json"), "utf8")) as AppBundle;
const N = "@acme/commerce-next/_";
const G = "@acme/governance/_";
const run = <A>(e: Effect.Effect<A, unknown, never>) => Effect.runPromise(e as Effect.Effect<A, never, never>);
const fails = async (e: Effect.Effect<unknown, unknown, never>) => { const x = await Effect.runPromiseExit(e as Effect.Effect<unknown, never, never>); if (x._tag === "Success") throw new Error("expected failure, got " + JSON.stringify(x.value)); const s = Cause.squash(x.cause); if (s instanceof ForgeError) return s; throw s; };
const seed: CallContext = { tenant: "t", actor: "maintenance", requestId: "seed", maintenance: true };

describe("PAR-108: trusted context comes from the auth host, never from request headers", () => {
  it("with JWT auth, forged x-forge-* headers are ignored and an unauthenticated call is refused", async () => {
    const engine = new Engine(new Model(bundle), testLayer(new MemoryStorage()));
    const auth = jwtAuth({ issuer: "https://issuer.test", audience: "forge-acme", secret: "test-hmac-secret", claims: { tenant: "tid", actor: "sub", purposes: "purposes" } });
    const handler = createHttpHandler(engine.model, engine, { auth, requestId: () => "r" });
    const forged = await handler(new Request("https://x/v1/customers", { headers: { "x-forge-tenant": "victim", "x-forge-actor": "root", "x-forge-purpose": `${G}/CustomerSupport` } }));
    expect(forged.status).toBe(401);
    const token = await signTestJwt({ iss: "https://issuer.test", aud: "forge-acme", sub: "agent-7", tid: "t", purposes: [`${G}/CustomerSupport`], exp: Math.floor(Date.now() / 1000) + 60 }, "test-hmac-secret");
    const ok = await handler(new Request("https://x/v1/customers?tier=standard", { headers: { authorization: `Bearer ${token}`, "x-forge-tenant": "victim", "x-forge-purpose": `${G}/CustomerSupport` } }));
    expect(ok.status).toBe(200);
    // a purpose the token does not carry is not accepted even if the header asks for it
    const wrongPurpose = await handler(new Request("https://x/v1/customers?tier=standard", { headers: { authorization: `Bearer ${token}`, "x-forge-purpose": `${G}/ParentCommunication` } }));
    expect(wrongPurpose.status).toBe(403);
    const wrongAud = await signTestJwt({ iss: "https://issuer.test", aud: "other", sub: "a", tid: "t", exp: Math.floor(Date.now() / 1000) + 60 }, "test-hmac-secret");
    expect((await handler(new Request("https://x/v1/customers", { headers: { authorization: `Bearer ${wrongAud}` } }))).status).toBe(401);
    const expired = await signTestJwt({ iss: "https://issuer.test", aud: "forge-acme", sub: "a", tid: "t", exp: Math.floor(Date.now() / 1000) - 3600 }, "test-hmac-secret");
    expect((await handler(new Request("https://x/v1/customers", { headers: { authorization: `Bearer ${expired}` } }))).status).toBe(401);
  });
});

describe("authorizer decisions in the pipeline", () => {
  let engine: Engine;
  let storage: MemoryStorage;
  let ids: { customerA: string; customerB: string; contactA: string; contactB: string };
  const pip: PipProvider = { name: "hr", attributes: { "agent-7": { team: "support-a" }, "agent-8": { team: "support-b" } }, freshnessMs: 60_000 };
  const policies: Policy[] = [
    // Support agents may read/update contacts of customers their team owns; ownership is in the PIP.
    { id: "contact-by-team", actions: [`${N}/Contact.*`], purpose: `${G}/CustomerSupport`, requires: [{ pip: "hr", attribute: "team" }], where: [{ field: "customer", op: "in", from: { pip: "hr", attribute: "team", map: { "support-a": ["$customerA"], "support-b": ["$customerB"] } } }], obligations: [{ kind: "audit", detail: "contact-access" }] },
    { id: "customers-open", actions: [`${N}/Customer.*`], purpose: `${G}/CustomerSupport`, requires: [], where: [] },
  ];
  beforeEach(async () => {
    storage = new MemoryStorage();
    engine = new Engine(new Model(bundle), testLayer(storage));
    const a = await run(engine.call(`${N}/Customer.create`, { code: "AAA", name: "A" }, seed));
    const b = await run(engine.call(`${N}/Customer.create`, { code: "BBB", name: "B" }, seed));
    const ca = await run(engine.call(`${N}/Contact.create`, { customer: a.id, name: "Ann", email: "ann@example.com" }, seed));
    const cb = await run(engine.call(`${N}/Contact.create`, { customer: b.id, name: "Ben", email: "ben@example.com" }, seed));
    ids = { customerA: a.id, customerB: b.id, contactA: ca.id, contactB: cb.id };
    const resolved = JSON.parse(JSON.stringify(policies).replaceAll("$customerA", a.id).replaceAll("$customerB", b.id)) as Policy[];
    engine.gatekeeper.authorizer = localAuthorizer({ policies: resolved, pips: [pip], epoch: 1, knownObligations: ["audit"] });
  });
  const agent7: CallContext = { tenant: "t", actor: "agent-7", requestId: "r", purpose: `${G}/CustomerSupport` };

  it("PAR-109: every record is authorized; the same scoped reader denies the second record", async () => {
    const okA = await run(engine.call(`${N}/Contact.get`, { id: ids.contactA }, agent7));
    expect(okA.name).toBe("Ann");
    const denied = await fails(engine.call(`${N}/Contact.get`, { id: ids.contactB }, agent7));
    expect(denied.code).toBe("NotFound"); // denied reads do not disclose existence (plan §9.1)
    expect(denied.detail).not.toMatch(/Ben|support-b/);
  });

  it("PAR-113: a list under a row policy is an exact pushdown when the predicate is on the partition, otherwise bounded candidate filtering", async () => {
    const page = await run(engine.call(`${N}/Contact.list.byCustomer`, { params: { customer: ids.customerA } }, agent7));
    expect(page.items.map((i: any) => i.name)).toEqual(["Ann"]);
    expect(page.plan).toEqual({ kind: "exact", policy: "contact-by-team" });
    const other = await run(engine.call(`${N}/Contact.list.byCustomer`, { params: { customer: ids.customerB } }, agent7));
    expect(other.items).toEqual([]);
    expect(other.plan).toEqual({ kind: "exact", policy: "contact-by-team" });
  });

  it("lists deny absent policies and cannot bypass required attributes or obligations", async () => {
    const list = () => run(engine.call(`${N}/Contact.list.byCustomer`, { params: { customer: ids.customerA } }, agent7));
    for (const policy of [null,
      { id: "missing", actions: [`${N}/Contact.*`], requires: [{pip:"absent",attribute:"team"}], where: [] },
      { id: "obligation", actions: [`${N}/Contact.*`], requires: [], where: [], obligations: [{kind:"unknown"}] },
    ]) {
      engine.gatekeeper.authorizer = localAuthorizer({policies: policy ? [policy] : [],pips:[],epoch:Math.random(),knownObligations:[]});
      expect((await list()).items).toEqual([]);
    }
  });

  it("list policy alternatives are ORed rather than restricted to the first policy", async () => {
    engine.gatekeeper.authorizer = localAuthorizer({policies:[ids.customerB,ids.customerA].map((id,i)=>({
      id:`alternative-${i}`,actions:[`${N}/Contact.*`],requires:[],where:[{field:"customer",op:"eq",values:[id]}],
    })),pips:[],epoch:2,knownObligations:[]});
    const page=await run(engine.call(`${N}/Contact.list.byCustomer`,{params:{customer:ids.customerA}},agent7));
    expect(page.items.map((row:any)=>row.name)).toEqual(["Ann"]);
  });

  it("PAR-110: mutations authorize current and candidate state — reassigning to a scope the actor cannot reach is denied", async () => {
    engine.gatekeeper.authorizer = localAuthorizer({ policies: [{ id: "reassign", actions: [`${N}/Order.*`], purpose: `${G}/OrderFulfillment`, requires: [], where: [{ field: "customer", op: "in", values: [ids.customerA] }] }], pips: [], epoch: 1, knownObligations: [] });
    const site = await run(engine.call(`${N}/Site.create`, { customer: ids.customerA, code: "HQ", name: "HQ" }, seed));
    const o = await run(engine.call(`${N}/Order.create`, { customer: ids.customerA, site: site.id, total: "5.00" }, seed));
    const fulfil: CallContext = { tenant: "t", actor: "agent-7", requestId: "r", purpose: `${G}/OrderFulfillment` };
    expect((await run(engine.call(`${N}/Order.status.submit`, { id: o.id, expectedVersion: 1, input: {} }, fulfil))).status).toBe("Submitted");
    // candidate state would leave the actor's scope (customer B): denied even though current state passes
    const siteB = await run(engine.call(`${N}/Site.create`, { customer: ids.customerB, code: "B1", name: "B" }, seed));
    const moved = await fails(engine.call(`${N}/Order.update`, { id: o.id, expectedVersion: 2, patch: { site: siteB.id } }, { ...fulfil, maintenance: false }));
    expect(["NotPermitted", "NotFound"]).toContain(moved.code);
  });

  it("PAR-115: an unknown mandatory obligation or a missing/stale PIP attribute denies", async () => {
    // reads deny as NotFound (no existence disclosure); the operator-visible decision names the cause
    engine.gatekeeper.authorizer = localAuthorizer({ policies: [{ id: "needs-mfa", actions: [`${N}/Customer.*`], purpose: `${G}/CustomerSupport`, requires: [], where: [], obligations: [{ kind: "step-up-mfa" }] }], pips: [], epoch: 1, knownObligations: ["audit"] });
    expect((await fails(engine.call(`${N}/Customer.get`, { id: ids.customerA }, agent7))).code).toBe("NotFound");
    expect(engine.gatekeeper.lastDecision).toMatchObject({ effect: "deny", reason: expect.stringMatching(/obligation step-up-mfa/) });
    engine.gatekeeper.authorizer = localAuthorizer({ policies: policies.map((p) => ({ ...p, where: [] })), pips: [{ ...pip, attributes: {} }], epoch: 1, knownObligations: ["audit"] });
    expect((await fails(engine.call(`${N}/Contact.get`, { id: ids.contactA }, agent7))).code).toBe("NotFound");
    expect(engine.gatekeeper.lastDecision?.reason).toMatch(/hr\.team is missing/);
    engine.gatekeeper.authorizer = localAuthorizer({ policies: policies.map((p) => ({ ...p, where: [] })), pips: [{ ...pip, freshnessMs: 0 }], epoch: 1, knownObligations: ["audit"] });
    expect((await fails(engine.call(`${N}/Contact.get`, { id: ids.contactA }, agent7))).code).toBe("NotFound");
    expect(engine.gatekeeper.lastDecision?.reason).toMatch(/stale/);
    // a create with an unknown obligation is a plain denial (nothing to hide)
    engine.gatekeeper.authorizer = localAuthorizer({ policies: [{ id: "needs-mfa", actions: [`${N}/Customer.*`], purpose: `${G}/CustomerSupport`, requires: [], where: [], obligations: [{ kind: "step-up-mfa" }] }], pips: [], epoch: 1, knownObligations: ["audit"] });
    expect((await fails(engine.call(`${N}/Customer.create`, { code: "NEW", name: "N" }, agent7))).code).toBe("NotPermitted");
  });

  it("policies are evaluated independently: a missing attribute for one policy never blocks another that allows", async () => {
    // agent-8 has no "writer" attribute: the write policy cannot apply to it, the read policy still does.
    engine.gatekeeper.authorizer = localAuthorizer({
      policies: [
        { id: "contacts-write", actions: [`${N}/Contact.*`], purpose: `${G}/CustomerSupport`, requires: [{ pip: "hr", attribute: "writer" }], where: [] },
        { id: "contacts-read", actions: [`${N}/Contact.get`], purpose: `${G}/CustomerSupport`, requires: [], where: [] },
      ],
      pips: [{ name: "hr", attributes: { "agent-7": { writer: true } }, freshnessMs: 60_000 }],
      epoch: 1,
      knownObligations: [],
    });
    const agent8: CallContext = { ...agent7, actor: "agent-8" };
    expect((await run(engine.call(`${N}/Contact.get`, { id: ids.contactA }, agent8))).name).toBe("Ann");
    expect(engine.gatekeeper.lastDecision).toMatchObject({ effect: "allow", policy: "contacts-read" });
    // but the missing attribute still denies what only the write policy could allow, naming the cause
    expect((await fails(engine.call(`${N}/Contact.update`, { id: ids.contactA, expectedVersion: 1, patch: { email: "x@example.com" } }, agent8))).code).toBe("NotFound");
    expect(engine.gatekeeper.lastDecision?.reason).toMatch(/hr\.writer is missing/);
    expect((await run(engine.call(`${N}/Contact.update`, { id: ids.contactA, expectedVersion: 1, patch: { email: "x@example.com" } }, agent7))).email).toBe("x@example.com");
  });

  it("PAR-111: a cached allow under epoch N cannot survive a revocation at epoch N+1", async () => {
    expect((await run(engine.call(`${N}/Contact.get`, { id: ids.contactA }, agent7))).name).toBe("Ann");
    expect(engine.gatekeeper.cacheStats().hits).toBe(0);
    expect((await run(engine.call(`${N}/Contact.get`, { id: ids.contactA }, agent7))).name).toBe("Ann");
    expect(engine.gatekeeper.cacheStats().hits).toBe(1);
    engine.gatekeeper.authorizer = localAuthorizer({ policies: [], pips: [pip], epoch: 2, knownObligations: ["audit"] }); // revoked
    expect((await fails(engine.call(`${N}/Contact.get`, { id: ids.contactA }, agent7))).code).toBe("NotFound");
  });

  it("PAR-112: replaying an idempotency key after revocation repeats no effect and discloses no stored response", async () => {
    const key = { ...agent7, idempotencyKey: "k-contact-update" };
    const first = await run(engine.call(`${N}/Contact.update`, { id: ids.contactA, expectedVersion: 1, patch: { email: "ann2@example.com" } }, key));
    expect(first.email).toBe("ann2@example.com");
    expect((await run(engine.call(`${N}/Contact.get`, { id: ids.contactA }, seed))).version).toBe(2);
    engine.gatekeeper.authorizer = localAuthorizer({ policies: [], pips: [pip], epoch: 2, knownObligations: ["audit"] });
    const replay = await fails(engine.call(`${N}/Contact.update`, { id: ids.contactA, expectedVersion: 1, patch: { email: "ann2@example.com" } }, key));
    expect(["NotPermitted", "NotFound"]).toContain(replay.code);
    expect(JSON.stringify(replay.problem("r"))).not.toContain("ann2@example.com");
    const rec = await run(engine.call(`${N}/Contact.get`, { id: ids.contactA }, seed));
    expect(rec.version).toBe(2); // not re-applied
  });
});

describe("PAR-114: assurance profiles are honest", () => {
  it("a shared process can only offer workload-bound assurance; asking for isolated-callable is downgraded with a reason", () => {
    const p = assuranceProfile({ isolation: "shared-process" }, "isolated-callable");
    expect(p).toEqual({ requested: "isolated-callable", granted: "workload-bound", reason: expect.stringMatching(/shared process|sibling/) });
    expect(assuranceProfile({ isolation: "attested-boundary", attestation: "kms-signed-entrypoint" }, "isolated-callable").granted).toBe("isolated-callable");
  });
});
