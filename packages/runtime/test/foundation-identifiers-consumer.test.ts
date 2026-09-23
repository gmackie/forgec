import { Effect } from "effect";
import { it, expect } from "vitest";
import { consumerFixture, foundationAdapters } from "./foundation-fixture.js";
import { Identifiers } from "../src/foundation/identifiers.js";
const domain = "@foundation-probe/identifier-consumers/_/", base = "@forgegraph/foundation/identifiers/_/";
for (const adapter of foundationAdapters) it(`${adapter}: GitHub, serial and healthcare identifiers resolve typed owners without replacing canonical ids`, async () => {
  const { engine, close } = await consumerFixture("identifiers", adapter);
  const ctx = { tenant: "t", actor: "u", requestId: "identifier-fixtures" };
  const call = (op: string, input: Record<string, unknown>) => Effect.runPromise(engine.call(op, input, ctx));
  try {
    const service = new Identifiers(engine);
    const issuer = await call(base + "Issuer.create", { key: "hospital" });
    await call(domain + "HospitalIssuer.create", { issuer: issuer.id, name: "Hospital" });
    for (const [name, field, namespace] of [["GitHubRepository", "identifiers", "github"], ["SerializedDevice", "serials", "serial"], ["PatientRecord", "medicalRecordNumbers", "mrn"]]) {
      const set = await call(base + "IdentifierSet.create", { label: namespace });
      const owner = await call(domain + name + ".create", { [field!]: set.id, ...(name === "GitHubRepository" ? { name: "forge" } : {}) });
      const qualified = { namespace: namespace!, value: "123", ...(namespace === "mrn" ? { issuer: String(issuer.id) } : {}) };
      await Effect.runPromise(service.assign({ ...qualified, identifierSet: String(set.id), validFrom: "2026-01-01T00:00:00Z" }, ctx));
      const found = await Effect.runPromise(service.lookup(qualified, "2026-01-01T00:00:00Z", ctx));
      expect(found?.identifierSet).toBe(owner[field!]);
      expect(owner.id).not.toBe(qualified.value);
      expect((await call(domain + name + ".get", { id: owner.id })).id).toBe(owner.id);
    }
  } finally { await close(); }
});
