import { Effect } from "effect";
import { it, expect } from "vitest";
import { Engine } from "../src/engine.js";
import { localAuthorizer } from "../src/gatekeeper.js";
import { Participations } from "../src/foundation/participation.js";
import { participationPipAuthorizer } from "../src/foundation/participation-pip.js";
import { consumerFixture } from "./foundation-fixture.js";
const domain = "@foundation-probe/participation-consumers/_/", base = "@forgegraph/foundation/participation/_/";
for (const adapter of ["memory", "sqlite"] as const) it(`${adapter}: typed membership facts feed an independent live policy, including immediate revocation`, async () => {
  const { engine, close } = consumerFixture("participation", adapter);
  const ctx = { tenant: "t", actor: "alice", requestId: "participation-fixtures" };
  const call = (op: string, input: Record<string, unknown>) => Effect.runPromise(engine.call(op, input, ctx));
  try {
    const person = await call(base + "Participant.create", { label: "Alice" });
    await call(domain + "PrincipalParticipant.create", { principal: ctx.actor, participant: person.id });
    const organization = await call(base + "Participant.create", { label: "Organization" });
    await call(domain + "OrganizationParticipant.create", { organizationCode: "ORG", participant: organization.id });
    const start = "2026-01-01T00:00:00Z", end = "2026-02-01T00:00:00Z";
    for (const [name, field, role] of [["Team", "members", "member"], ["Classroom", "enrollment", "student"], ["ReviewBoard", "reviewers", "reviewer"]]) {
      const set = await call(base + "ParticipationSet.create", { label: name });
      const owner = await call(domain + name + ".create", { [field!]: set.id });
      const service = new Participations(engine, { namespace: name!, roles: [role!] });
      await Effect.runPromise(service.registerRole(role!, ctx));
      const membership = await Effect.runPromise(service.add({ participationSet: set.id, participant: person.id, role: role!, validFrom: start, reason: "Appointment" }, ctx));
      // Additional rows force pagination; no first-page-only authority assumption.
      await Effect.runPromise(service.add({ participationSet: set.id, participant: organization.id, role: role!, validFrom: start, reason: "Organization membership" }, ctx));
      const protectedEngine = new Engine(engine.model, engine.layer);
      const policy = localAuthorizer({ policies: [{ id: "explicit-owner-access", actions: [domain + name + ".*"], requires: [{ pip: "participation", attribute: "member" }], where: [{ field: "id", op: "in", from: { pip: "participation", attribute: "member", map: { yes: [owner.id], no: [] } } }] }], pips: [], epoch: 1, knownObligations: [] });
      const factEngine = new Engine(engine.model, engine.layer);
      factEngine.gatekeeper.authorizer = localAuthorizer({
        policies: ["Participation", "ParticipationRole", "ParticipationEnd"].map(resource => ({ id: resource, actions: [base + resource + ".*"], requires: [], where: [] })).concat([{ id: "principal-map", actions: [domain + "PrincipalParticipant.find.byPrincipal"], requires: [], where: [] }]),
        pips: [], epoch: 1, knownObligations: [],
      });
      const factService = new Participations(factEngine, { namespace: name!, roles: [role!] });
      let at = start;
      const authorizer = participationPipAuthorizer(policy, request => Effect.gen(function* () {
        // A distinct service engine has explicit read authority over the fact graph.
        const readCtx = { ...ctx, tenant: request.principal.tenant, actor: "facts-service" };
        const mapping = yield* factEngine.call(domain + "PrincipalParticipant.find.byPrincipal", { params: { principal: request.principal.actor } }, readCtx);
        let cursor: string | undefined, member = false;
        do {
          const page = yield* factService.listAt(set.id, at, readCtx, { limit: 1, ...(cursor ? { cursor } : {}) });
          member ||= page.items.some(p => p.participant === mapping.participant);
          cursor = page.next ?? undefined;
        } while (cursor);
        const now = Date.now();
        return [{ pip: "participation", attribute: "member", value: member ? "yes" : "no", observedAt: new Date(now).toISOString(), expiresAt: new Date(now + 1000).toISOString() }];
      }));
      // Membership alone grants nothing: an unrelated policy still denies access.
      protectedEngine.gatekeeper.authorizer = localAuthorizer({ policies: [], pips: [], epoch: 1, knownObligations: [] });
      await expect(Effect.runPromise(protectedEngine.call(domain + name + ".get", { id: owner.id }, ctx))).rejects.toThrow();
      // An earlier authorizer at the same epoch may have populated the cache.
      // Live membership decisions must ignore that cached allow too.
      protectedEngine.gatekeeper.authorizer = localAuthorizer({ policies: [{ id: "earlier", actions: [domain + name + ".*"], requires: [], where: [] }], pips: [], epoch: 1, knownObligations: [] });
      await Effect.runPromise(protectedEngine.call(domain + name + ".get", { id: owner.id }, ctx));
      protectedEngine.gatekeeper.authorizer = authorizer;
      expect((await Effect.runPromise(protectedEngine.call(domain + name + ".get", { id: owner.id }, ctx))).id).toBe(owner.id);
      await Effect.runPromise(service.revoke(String(membership.id), end, "Ended", ctx));
      at = end;
      await expect(Effect.runPromise(protectedEngine.call(domain + name + ".get", { id: owner.id }, ctx))).rejects.toThrow();
      expect((await Effect.runPromise(protectedEngine.call(domain + name + ".list.all", { params: {} }, ctx))).items).toEqual([]);
      const foreignCtx = { ...ctx, tenant: "foreign" };
      const foreignSet = await Effect.runPromise(engine.call(base + "ParticipationSet.create", { label: "Foreign scope" }, foreignCtx));
      const foreignOwner = await Effect.runPromise(engine.call(domain + name + ".create", { [field!]: foreignSet.id }, foreignCtx));
      at = start;
      await expect(Effect.runPromise(protectedEngine.call(domain + name + ".get", { id: foreignOwner.id }, foreignCtx))).rejects.toThrow();
    }
  } finally { close(); }
});
