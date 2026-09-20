import { describe, expect, it } from "vitest";
import { runScenario, type Scenario } from "../src/runner.js";
import { MemoryTarget } from "../src/memory-target.js";

/** The runner is provider-agnostic: any Target that speaks operation ids + canonical JSON can be certified. */
const scenario: Scenario = {
  id: "smoke.customer-crud",
  title: "sequential CRUD with revisions",
  steps: [
    { name: "create", op: "Customer.create", input: { code: "acme", name: "Acme" }, expect: { ok: { id: "$id:1", version: 1, code: "ACME", name: "Acme", email: null } } },
    { name: "read", op: "Customer.get", input: { id: "$create.id" }, expect: { ok: { id: "$id:1", version: 1, code: "ACME", name: "Acme", email: null } } },
    { name: "rename", op: "Customer.update", input: { id: "$create.id", expectedVersion: 1, patch: { name: "Acme Inc" } }, expect: { ok: { version: 2, name: "Acme Inc" } } },
    { name: "stale", op: "Customer.update", input: { id: "$create.id", expectedVersion: 1, patch: { name: "Nope" } }, expect: { error: "VersionConflict" } },
    { name: "unknown", op: "Customer.update", input: { id: "$create.id", expectedVersion: 2, patch: { version: 9 } }, expect: { error: "UnknownField" } },
  ],
};

describe("scenario runner", () => {
  it("passes a conforming target", async () => {
    const report = await runScenario(scenario, new MemoryTarget());
    expect(report.failures).toEqual([]);
    expect(report.steps).toBe(5);
  });

  it("reports a step whose result deviates, with a normalized diff", async () => {
    const broken: Scenario = { ...scenario, steps: [{ ...scenario.steps[0]!, expect: { ok: { code: "acme" } } }] };
    const report = await runScenario(broken, new MemoryTarget());
    expect(report.failures).toHaveLength(1);
    expect(report.failures[0]).toMatchObject({ step: "create", path: "code", expected: "acme", actual: "ACME" });
  });

  it("resolves $step.field references and seeded ids deterministically across runs", async () => {
    const a = await runScenario(scenario, new MemoryTarget());
    const b = await runScenario(scenario, new MemoryTarget());
    expect(a.results).toEqual(b.results);
  });
});
