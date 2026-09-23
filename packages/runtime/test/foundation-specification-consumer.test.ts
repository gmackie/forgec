import { Effect } from "effect";
import { it, expect } from "vitest";
import { consumerFixture, foundationAdapters } from "./foundation-fixture.js";
const domain = "@foundation-probe/specification-consumers/_/", spec = "@forgegraph/foundation/specification/_/";
for (const adapter of foundationAdapters) it(`${adapter}: all specification consumers retain old pins after evolution`, async () => {
  const { engine, close } = await consumerFixture("specification", adapter);
  const ctx = { tenant: "t", actor: "u", requestId: "spec-fixtures" };
  const call = (op: string, input: Record<string, unknown>) => Effect.runPromise(engine.call(op, input, ctx));
  try {
    const repo = await call(spec + "Repository.create", { key: "specs", provider: "git", locator: "local" });
    const pin = await call(spec + "SpecificationPin.create", { repository: repo.id, anchor: "@domain/_/Definition", revision: "a".repeat(40) });
    const next = await call(spec + "SpecificationPin.create", { repository: repo.id, anchor: "@domain/_/Definition", revision: "b".repeat(40) });
    for (const name of ["Deployment", "LevelGeneration", "ExperienceSession", "BroadcastSession", "EvaluationRun", "ManufacturingBatch", "LabExperiment"]) {
      const oldInstance = await call(domain + name + ".create", { specification: pin.id });
      const newInstance = await call(domain + name + ".create", { specification: next.id });
      expect((await call(domain + name + ".get", { id: oldInstance.id })).specification).toBe(pin.id);
      expect((await call(domain + name + ".list.bySpecification", { params: { specification: pin.id } })).items.map((r: { id: string }) => r.id)).toEqual([oldInstance.id]);
      expect(newInstance.specification).toBe(next.id);
      await expect(call(domain + name + ".update", { id: oldInstance.id, patch: { specification: next.id } })).rejects.toThrow();
    }
  } finally { await close(); }
});
