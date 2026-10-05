import { Effect } from "effect";
import { expect, it } from "vitest";
import { Engine } from "../src/engine.js";
import { Entitlements, entitlementPipAuthorizer, type EffectiveRightsPage } from "../src/foundation/entitlement.js";
import { Parties, type RepresentationPage } from "../src/foundation/party.js";
import { localAuthorizer } from "../src/gatekeeper.js";
import { consumerFixture, foundationAdapters } from "./foundation-fixture.js";
const base = "@forgegraph/foundation/entitlement/_/", domain = "@example/entitlement/_/";
const ctx = { tenant: "acme", actor: "alice", requestId: "entitlement" };
const start = "2026-01-01T00:00:00Z", end = "2026-02-01T00:00:00Z", nextEnd = "2026-03-01T00:00:00Z";
const run = Effect.runPromise;
async function seed(engine: Engine) {
  const call = (op: string, input: Record<string, unknown>) => run(engine.call(base + op, input, ctx));
  const party = await run(new Parties(engine).create({ label: "Business holder" }, ctx));
  const scope = await call("EntitlementScope.create", { label: "Product tenant" });
  const right = await call("RightDefinition.create", { namespace: "app.product", name: "access" });
  const requirement = await call("RequirementDefinition.create", { namespace: "app.contract", name: "deliver" });
  const api = new Entitlements(engine);
  const input = { holder: String(party.id), scope: String(scope.id), right: String(right.id), validFrom: start, validUntil: end, reason: "Issued" };
  return { api, call, party, scope, right, requirement, input };
}
for (const adapter of foundationAdapters) {
  it(`${adapter}: F30-01/03/04 rights preserve exact quantities, scoped validity, renewal and terminal history`, async () => {
    const { engine, close } = await consumerFixture("entitlement", adapter);
    try {
      const { api, call, input } = await seed(engine);
      const grant = await run(api.issue({ ...input, quantity: "1.000001", unit: "seat" }, { ...ctx, idempotencyKey: "issue" }));
      expect((await run(api.issue({ ...input, quantity: "1.000001", unit: "seat" }, { ...ctx, idempotencyKey: "issue" }))).id).toBe(grant.id);
      const list = (at: string) => run(api.listEffectiveRights(input.holder, input.scope, at, ctx));
      expect((await list(start)).items[0]).toMatchObject({ entitlement: grant.id, quantity: "1.000001", unit: "seat" });
      expect((await list("2025-12-31T23:59:59Z")).items).toEqual([]);
      expect((await list(end)).items).toEqual([]);
      for (const q of [{ quantity: "0.0000001", unit: "seat" }, { quantity: "-1", unit: "seat" }, { quantity: "1" }, { unit: "seat" }]) await expect(run(api.issue({ ...input, ...q }, ctx))).rejects.toThrow();
      await expect(run(api.issue({ ...input, validUntil: start }, ctx))).rejects.toThrow();
      const renewals = await Promise.allSettled(Array.from({ length: 3 }, () => run(api.renew(String(grant.id), { validFrom: end, validUntil: nextEnd, quantity: "2.000000", reason: "Explicit new term" }, ctx))));
      expect(renewals.filter(r => r.status === "fulfilled")).toHaveLength(1);
      const successor = (renewals.find(r => r.status === "fulfilled") as PromiseFulfilledResult<Record<string, unknown>>).value;
      expect(successor).toMatchObject({ predecessor: grant.id, holder: input.holder, scope: input.scope, unit: "seat" });
      const terminal = await Promise.allSettled([run(api.revoke(String(grant.id), end, "Ended", ctx)), run(api.expire(String(grant.id), "Expiry recorded", ctx))]);
      expect(terminal.filter(r => r.status === "fulfilled")).toHaveLength(1);
      expect((await list(end)).items.map(r => r.entitlement)).toEqual([successor.id]);
      expect((await list(start)).items.map(r => r.entitlement)).toEqual([grant.id]);
      for (const name of ["Entitlement", "EntitlementEnd"]) for (const op of ["update", "delete"]) await expect(call(name + "." + op, { id: grant.id, patch: { unit: "other" } })).rejects.toThrow();
      const { validUntil: _validUntil, ...unboundedInput } = input;
      const unbounded = await run(api.issue(unboundedInput, ctx));
      await expect(run(api.expire(String(unbounded.id), "Cannot infer", ctx))).rejects.toThrow();
      await expect(run(api.renew(String(unbounded.id), { validFrom: end, reason: "No fixed predecessor end" }, ctx))).rejects.toThrow();
      const scope2 = await call("EntitlementScope.create", { label: "Other product" });
      expect((await run(api.listEffectiveRights(input.holder, String(scope2.id), start, ctx))).items).toEqual([]);
      await expect(run(api.issue(input, { ...ctx, tenant: "other" }))).rejects.toThrow();
      await expect(run(api.listEffectiveRights(input.holder, input.scope, start, { ...ctx, tenant: "other" }))).rejects.toThrow();
    } finally { await close(); }
  });
  it(`${adapter}: F30-02/03 obligations have explicit overdue/discharge/cancel facts and revocation reads fail closed`, async () => {
    const { engine, close } = await consumerFixture("entitlement", adapter);
    try {
      const { api, call, input, requirement } = await seed(engine);
      const duty = await run(api.recordObligation({ obligatedParty: input.holder, requirement: String(requirement.id), scope: input.scope, quantity: "10.125000", unit: "hours", incurredAt: start, dueAt: end, reason: "Duty" }, ctx));
      expect((await run(api.obligationAt(String(duty.id), start, ctx))).state).toBe("Open");
      expect((await run(api.obligationAt(String(duty.id), "2025-12-31T23:59:59Z", ctx))).state).toBe("NotIncurred");
      expect((await run(api.obligationAt(String(duty.id), end, ctx))).state).toBe("Overdue");
      await expect(run(api.endObligation(String(duty.id), "Discharged", "2025-01-01T00:00:00Z", "Too early", ctx))).rejects.toThrow();
      const ends = await Promise.allSettled([run(api.endObligation(String(duty.id), "Discharged", end, "Delivered", ctx)), run(api.endObligation(String(duty.id), "Cancelled", end, "Cancelled", ctx))]);
      expect(ends.filter(r => r.status === "fulfilled")).toHaveLength(1);
      expect(["Discharged", "Cancelled"]).toContain((await run(api.obligationAt(String(duty.id), end, ctx))).state);
      expect((await run(api.obligationAt(String(duty.id), start, ctx))).state).toBe("Open");
      const grant = await run(api.issue(input, ctx));
      await run(api.revoke(String(grant.id), "2026-01-15T00:00:00Z", "Withdrawn", ctx));
      expect((await run(api.listEffectiveRights(input.holder, input.scope, "2026-01-15T00:00:00Z", ctx))).items).toEqual([]);
      const guarded = new Engine(engine.model, engine.layer);
      guarded.gatekeeper.authorizer = localAuthorizer({ policies: ["Entitlement", "EntitlementScope", "RightDefinition"].map(name => ({ id: name, actions: [base + name + ".*"], requires: [], where: [] })).concat([{ id: "party", actions: ["@forgegraph/foundation/party/_/Party.*"], requires: [], where: [] }]), pips: [], epoch: 1, knownObligations: [] });
      await expect(run(new Entitlements(guarded).listEffectiveRights(input.holder, input.scope, start, ctx))).rejects.toMatchObject({ code: "NotFound" });
      await expect(call("Obligation.delete", { id: duty.id })).rejects.toThrow();
    } finally { await close(); }
  });
  it(`${adapter}: F30-05/06/07 typed source satellites and live PIP facts require independent policy`, async () => {
    const { engine, close } = await consumerFixture("entitlement", adapter);
    try {
      const { api, input, requirement } = await seed(engine);
      const call = (op: string, body: Record<string, unknown>) => run(engine.call(domain + op, body, ctx));
      const purchase = await call("Purchase.create", { orderNumber: "P1" });
      const grants = [];
      for (const name of ["SoftwareSeat", "WarrantyCoverage", "CourseAccess"]) {
        const grant = await run(api.issue({ ...input, quantity: "1", unit: "access" }, ctx)); grants.push(grant);
        await call(name + ".create", name === "SoftwareSeat" ? { entitlement: grant.id, product: "IDE", purchase: purchase.id } : name === "WarrantyCoverage" ? { entitlement: grant.id, serialNumber: "SERIAL-1", purchase: purchase.id } : { entitlement: grant.id, courseCode: "FORGE-101" });
      }
      const duty = await run(api.recordObligation({ obligatedParty: input.holder, requirement: String(requirement.id), scope: input.scope, incurredAt: start, dueAt: end, reason: "Supply updates" }, ctx));
      await call("ContractualDuty.create", { obligation: duty.id, contractNumber: "C1", deliverable: "Security updates" });
      const parties = new Parties(engine);
      const representation = await run(parties.represent({ party: input.holder, principal: ctx.actor, validFrom: start, reason: "Holder representative" }, ctx));
      const protectedEngine = new Engine(engine.model, engine.layer);
      protectedEngine.gatekeeper.authorizer = localAuthorizer({ policies: [], pips: [], epoch: 1, knownObligations: [] });
      const target = await call("Purchase.get", { id: purchase.id });
      await expect(run(protectedEngine.call(domain + "Purchase.get", { id: target.id }, ctx))).rejects.toThrow();
      let at = start;
      const policy = localAuthorizer({ policies: [{ id: "explicit-right-policy", actions: [domain + "Purchase.*"], requires: [{ pip: "entitlements", attribute: "active" }], where: [{ field: "id", op: "in", from: { pip: "entitlements", attribute: "active", map: { yes: [target.id], no: [] } } }] }], pips: [], epoch: 1, knownObligations: [] });
      const factEngine = new Engine(engine.model, engine.layer);
      factEngine.gatekeeper.authorizer = localAuthorizer({ policies: ["Entitlement", "EntitlementEnd", "EntitlementScope", "RightDefinition"].map(name => ({ id: name, actions: [base + name + ".*"], requires: [], where: [] })).concat(["Party", "PrincipalRepresentation", "RepresentationRevocation"].map(name => ({ id: name, actions: ["@forgegraph/foundation/party/_/" + name + ".*"], requires: [], where: [] }))), pips: [], epoch: 1, knownObligations: [] });
      const factApi = new Entitlements(factEngine), factParties = new Parties(factEngine);
      protectedEngine.gatekeeper.authorizer = entitlementPipAuthorizer(policy, request => Effect.gen(function* () {
        // The fact service has separate read authority; caller authority is not self-asserted.
        const factCtx = { ...ctx, tenant: request.principal.tenant, actor: "fact-service" };
        let represented = false, cursor: string | undefined;
        do { const page: RepresentationPage = yield* factParties.listRepresentedAt(request.principal.actor, at, factCtx, { limit: 1, ...(cursor ? { cursor } : {}) }); represented ||= page.items.some(p => p.party === input.holder); cursor = page.next ?? undefined; } while (cursor);
        let active = false; cursor = undefined;
        if (represented) do { const page: EffectiveRightsPage = yield* factApi.listEffectiveRights(input.holder, input.scope, at, factCtx, { limit: 1, ...(cursor ? { cursor } : {}) }); active ||= page.items.some(p => p.right === input.right); cursor = page.next ?? undefined; } while (cursor);
        const now = Date.now(); return [{ pip: "entitlements", attribute: "active", value: active ? "yes" : "no", observedAt: new Date(now).toISOString(), expiresAt: new Date(now + 1000).toISOString() }];
      }));
      expect((await run(protectedEngine.call(domain + "Purchase.get", { id: target.id }, ctx))).id).toBe(target.id);
      for (const grant of grants) await run(api.revoke(String(grant.id), "2026-01-15T00:00:00Z", "Withdrawn", ctx));
      at = "2026-01-15T00:00:00Z";
      await expect(run(protectedEngine.call(domain + "Purchase.get", { id: target.id }, ctx))).rejects.toThrow();
      at = start;
      expect((await run(protectedEngine.call(domain + "Purchase.get", { id: target.id }, ctx))).id).toBe(target.id);
      await run(parties.revoke(String(representation.id), start, "No longer represented", ctx));
      await expect(run(protectedEngine.call(domain + "Purchase.get", { id: target.id }, ctx))).rejects.toThrow();
    } finally { await close(); }
  });
}
