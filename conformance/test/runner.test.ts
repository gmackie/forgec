import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import type { AppBundle } from "@forgegraph/runtime";
import { runScenario, type Scenario } from "../src/runner.js";
import { RuntimeTarget } from "../src/runtime-target.js";
import { loadScenarios } from "../src/scenarios.js";

const bundle = JSON.parse(readFileSync(resolve(import.meta.dirname, "..", "fixtures", "acme.app.json"), "utf8")) as AppBundle;

describe("scenario runner against the in-memory semantic model", () => {
  for (const scenario of loadScenarios()) {
    it(`${scenario.id}: ${scenario.title}`, async () => {
      const report = await runScenario(scenario, new RuntimeTarget(bundle));
      expect(report.failures).toEqual([]);
    }, 60_000);
  }

  it("reports a step whose result deviates, with a normalized diff", async () => {
    const broken: Scenario = {
      id: "broken",
      title: "",
      steps: [{ name: "create", op: "@acme/commerce/_/Customer.create", input: { code: "acme", name: "Acme" }, expect: { ok: { code: "acme" } } }],
    };
    const report = await runScenario(broken, new RuntimeTarget(bundle));
    expect(report.failures).toMatchObject([{ step: "create", path: "code", expected: "acme", actual: "ACME" }]);
  });

  it("produces identical normalized results across runs (seeded ids and clocks)", async () => {
    const [s] = loadScenarios();
    const a = await runScenario(s!, new RuntimeTarget(bundle));
    const b = await runScenario(s!, new RuntimeTarget(bundle));
    expect(a.results).toEqual(b.results);
  });
});
