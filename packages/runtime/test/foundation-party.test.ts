import { Effect } from "effect";
import { expect, it } from "vitest";
import { Engine } from "../src/engine.js";
import { Parties } from "../src/foundation/party.js";
import { Identifiers } from "../src/foundation/identifiers.js";
import { localAuthorizer } from "../src/gatekeeper.js";
import { consumerFixture } from "./foundation-fixture.js";

const base = "@forgegraph/foundation/party/_/";
const ids = "@forgegraph/foundation/identifiers/_/";
const domain = "@foundation-probe/party-consumers/_/";
const start = "2026-01-01T00:00:00Z", end = "2026-02-01T00:00:00Z";
const ctx = { tenant: "acme", actor: "registrar", requestId: "party" };
for (const adapter of ["memory", "sqlite"] as const) {
  it(`${adapter}: Party owns durable business identity with typed customer, worker and organization satellites`, async () => {
    const { engine, close } = consumerFixture("party", adapter);
    const call = (op: string, input: Record<string, unknown>, context = ctx) => Effect.runPromise(engine.call(op, input, context));
    const service = new Parties(engine);
    try {
      const set = await call(ids + "IdentifierSet.create", { label: "Business identifiers" });
      const person = await Effect.runPromise(service.create({ label: "Alice", identifiers: set.id }, ctx));
      const satellite = await call(domain + "Person.create", { party: String(person.id), displayName: "Alice" });
      await call(domain + "Customer.create", { party: String(person.id), customerCode: "C1" });
      await call(domain + "Worker.create", { person: satellite.id, workerCode: "W1" });
      const company = await Effect.runPromise(service.create({ label: "Company" }, ctx));
      await call(domain + "Organization.create", { party: String(company.id), legalName: "Acme Ltd" });
      // Optional identifier sidecars are absent independently for multiple parties.
      await Effect.runPromise(service.create({ label: "Other company" }, ctx));
      const identifiers = new Identifiers(engine);
      await Effect.runPromise(identifiers.assign({ identifierSet: set.id, namespace: "customer", value: "EXTERNAL-1", validFrom: start }, ctx));
      expect((await Effect.runPromise(identifiers.lookup({ namespace: "customer", value: "EXTERNAL-1" }, start, ctx)))?.identifierSet).toBe(person.identifiers);
      expect(person.id).not.toBe("EXTERNAL-1");
      await expect(Effect.runPromise(service.create({ label: "Duplicate sidecar", identifiers: set.id }, ctx))).rejects.toMatchObject({ code: "UniqueConflict" });
      await expect(call(domain + "Worker.create", { person: "not-a-person", workerCode: "BAD" })).rejects.toThrow();
      await expect(call(base + "Party.get", { id: person.id }, { ...ctx, tenant: "other" })).rejects.toThrow();
      await expect(Effect.runPromise(service.create({ label: "Foreign identifiers", identifiers: set.id }, { ...ctx, tenant: "other" }))).rejects.toThrow();
      await expect(call(base + "Party.update", { id: person.id, patch: { label: "Erased" } })).rejects.toThrow();
      await expect(call(base + "Party.delete", { id: person.id })).rejects.toThrow();
      const denied = new Engine(engine.model, engine.layer);
      denied.gatekeeper.authorizer = localAuthorizer({ policies: [], pips: [], epoch: 1, knownObligations: [] });
      await Effect.runPromise(service.represent({ party: String(person.id), principal: "alice", validFrom: start, reason: "Business representation" }, ctx));
      // Association alone grants neither access to the Party nor any domain fact.
      await expect(Effect.runPromise(denied.call(base + "Party.get", { id: person.id }, { ...ctx, actor: "alice" }))).rejects.toThrow();
      await expect(Effect.runPromise(denied.call(domain + "Person.get", { id: satellite.id }, { ...ctx, actor: "alice" }))).rejects.toThrow();
    } finally { close(); }
  });

  it(`${adapter}: representation is temporal, paginated, revocable and fails closed on unreadable revocation`, async () => {
    const { engine, close } = consumerFixture("party", adapter);
    const service = new Parties(engine);
    const run = Effect.runPromise;
    try {
      const alice = await run(service.create({ label: "Alice" }, ctx));
      const company = await run(service.create({ label: "Company" }, ctx));
      const input = { party: String(alice.id), principal: "alice", validFrom: start, reason: "Appointed" };
      const attempts = await Promise.allSettled(Array.from({ length: 6 }, () => run(service.represent(input, ctx))));
      expect(attempts.filter(x => x.status === "fulfilled")).toHaveLength(1);
      const representation = (attempts.find(x => x.status === "fulfilled") as PromiseFulfilledResult<Record<string, unknown>>).value;
      expect(representation.recordedBy).toBe("registrar");
      await run(service.represent({ ...input, party: String(company.id), validUntil: end }, ctx));
      await run(service.represent({ ...input, principal: "delegate" }, ctx));
      expect((await run(service.listRepresentedAt("alice", "2025-12-31T23:59:59Z", ctx))).items).toEqual([]);
      let cursor: string | undefined;
      const parties: string[] = [];
      do {
        const page = await run(service.listRepresentedAt("alice", start, ctx, { limit: 1, ...(cursor ? { cursor } : {}) }));
        parties.push(...page.items.map(item => item.party)); cursor = page.next ?? undefined;
      } while (cursor);
      expect(new Set(parties)).toEqual(new Set([alice.id, company.id]));
      await expect(run(service.represent({ ...input, validUntil: start }, ctx))).rejects.toThrow();
      await expect(run(service.revoke(String(representation.id), "2025-12-31T00:00:00Z", "Too early", ctx))).rejects.toThrow();
      const endings = await Promise.allSettled(Array.from({ length: 6 }, () => run(service.revoke(String(representation.id), end, "Principal deprovisioned", ctx))));
      expect(endings.filter(x => x.status === "fulfilled")).toHaveLength(1);
      expect((await run(service.listRepresentedAt("alice", end, ctx))).items).toEqual([]);
      expect((await run(service.listRepresentedAt("alice", start, ctx))).items).toHaveLength(2);
      expect((await run(service.listRepresentedAt("delegate", end, ctx))).items).toHaveLength(1);
      const filtered = await run(service.listRepresentedAt("alice", end, ctx, { limit: 1 }));
      expect(filtered.items).toEqual([]); expect(filtered.next).not.toBeNull();
      expect((await run(engine.call(base + "Party.get", { id: alice.id }, ctx))).id).toBe(alice.id);
      expect((await run(service.listRepresentedAt("alice", start, { ...ctx, tenant: "other" }))).items).toEqual([]);
      await expect(run(service.represent(input, { ...ctx, tenant: "other" }))).rejects.toThrow();
      await expect(run(service.listRepresentedAt("alice", "not-an-instant", ctx))).rejects.toThrow();
      const guarded = new Engine(engine.model, engine.layer);
      guarded.gatekeeper.authorizer = localAuthorizer({ policies: ["Party", "PrincipalRepresentation"].map(resource => ({ id: resource, actions: [base + resource + ".*"], requires: [], where: [] })), pips: [], epoch: 1, knownObligations: [] });
      await expect(run(new Parties(guarded).listRepresentedAt("alice", start, ctx))).rejects.toThrow();
      for (const resource of ["PrincipalRepresentation", "RepresentationRevocation"]) {
        await expect(run(engine.call(base + resource + ".delete", { id: representation.id }, ctx))).rejects.toThrow();
      }
    } finally { close(); }
  });
}
