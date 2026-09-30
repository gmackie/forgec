import { foundation, foundationAdapters } from "./helpers/foundation.js";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Effect } from "effect";
import { expect, it } from "vitest";
import { Configuration } from "../src/foundation/configuration.js";
const prefix = "@forgegraph/foundation/configuration/_/";
const spec = "@forgegraph/foundation/specification/_/";
const consumer = "@foundation-probe/configuration-consumers/_/";
const ctx = { tenant: "acme", actor: "user", requestId: "configuration-consumer" };
const AT = "2026-01-01T00:00:00Z";

for (const adapter of foundationAdapters)
  it(`${adapter}: four unrelated things parameterize identically, and a reconciler consumes without owning`, async () => {
    const f = await foundation("configuration", adapter, true);
    const engine = f.engine;
    try {
      const call = (op: string, input: Record<string, unknown>, context = ctx) =>
        Effect.runPromise(engine.call(op, input, context));
      const run = Effect.runPromise;
      const service = new Configuration(engine);

      const textType = (await call(prefix + "ParameterType.create", { key: "text", label: "text", secret: false })).id;
      const base = (await call(prefix + "ConfigurationLayer.create", { key: "base", label: "base", ordinal: 1 })).id;
      const tenantLayer = (await call(prefix + "ConfigurationLayer.create", { key: "tenant", label: "tenant", ordinal: 2 })).id;

      /** One pinned specification and one configuration per subject, whatever the subject is. */
      let revisions = 0;
      const parameterized = async (name: string, key: string, defaultValue: string) => {
        // GitCommit is hex-only, so revisions are generated rather than spelled from the name.
        const revision = String(++revisions).padStart(40, "0");
        const repository = await call(spec + "Repository.create", { key: name, provider: "git", locator: `https://example.com/${name}.git` });
        const pin = await call(spec + "SpecificationPin.create", { repository: repository.id, anchor: "main", revision });
        const parameter = await call(prefix + "ParameterDefinition.create", {
          pin: pin.id, key, valueType: textType, secret: false, required: true, defaultValue,
        });
        const configuration = await call(prefix + "Configuration.create", {
          pin: pin.id, key: name, layer: base, layerOrdinal: 1, parent: null,
        });
        return { pin, parameter, configuration };
      };

      // F94-07: a workspace agent, an industrial process unit, a SaaS tenant and a deployment.
      // Four shapes that share no vocabulary and parameterize through exactly one model.
      const agent = await parameterized("agent", "model", "sonnet");
      await call(consumer + "WorkspaceAgent.create", { name: "Research agent", settings: agent.configuration.id });

      const unit = await parameterized("process", "setpoint-c", "180");
      await call(consumer + "ProcessUnit.create", { tag: "REACTOR-1", settings: unit.configuration.id });

      const plan = await parameterized("plan", "seat-limit", "10");
      await call(consumer + "TenantPlan.create", { account: "acme", settings: plan.configuration.id });

      // The same subject overridden one layer up, which is the SaaS case in practice.
      const enterprise = await call(prefix + "Configuration.create", {
        pin: plan.pin.id, key: "plan", layer: tenantLayer, layerOrdinal: 2, parent: plan.configuration.id,
      });
      await call(prefix + "ParameterAssignment.create", {
        configuration: enterprise.id, parameter: plan.parameter.id, value: "500", secretRef: null,
      });
      const enterpriseResolution = await run(service.resolve(String(enterprise.id), AT, ctx));
      expect(enterpriseResolution.entries).toEqual([
        { key: "seat-limit", value: "500", secretRef: null, source: enterprise.id },
      ]);
      // The base configuration still resolves to its own default: one override does not leak.
      expect((await run(service.resolve(String(plan.configuration.id), AT, ctx))).entries[0]).toMatchObject({ value: "10", source: null });

      // F94-07, fourth shape: a deployment pins the exact resolution it went out with, rather
      // than the configuration, so a later edit cannot rewrite what was deployed.
      const deployment = await call(consumer + "DeploymentConfiguration.create", {
        environment: "production", resolved: enterpriseResolution.resolved, deployedAt: AT,
      });
      await expect(call(consumer + "DeploymentConfiguration.create", {
        environment: "staging", resolved: enterpriseResolution.resolved, deployedAt: AT,
      })).rejects.toThrow();

      // An edit produces a new resolution with a new identity; the deployment still names the old.
      await call(prefix + "ParameterAssignment.create", {
        configuration: plan.configuration.id, parameter: plan.parameter.id, value: "25", secretRef: null,
      });
      const afterEdit = await run(service.resolve(String(enterprise.id), AT, ctx));
      expect(afterEdit.digest).toBe(enterpriseResolution.digest); // the override still wins
      const rebased = await run(service.resolve(String(plan.configuration.id), AT, ctx));
      expect(rebased.digest).not.toBe(enterpriseResolution.digest);
      expect((await call(consumer + "DeploymentConfiguration.get", { id: deployment.id }))["resolved"]).toBe(enterpriseResolution.resolved);

      /**
       * F94-08: the reconciler records what it observed and whether it matched. It holds no
       * parameter values of its own, so it cannot drift from the desired state it compares
       * against — there is no second copy to drift.
       */
      const observation = await call(consumer + "DriftObservation.create", {
        deployment: deployment.id, observedAt: AT, matches: true, detail: "seat-limit observed as 500",
      });
      expect(Object.keys(observation).sort()).toEqual(["deployment", "detail", "id", "matches", "observedAt"]);

      // F94-06: provenance survives into the stored rows, not just the returned object.
      const values = (await run(service.listValues(enterpriseResolution.resolved, ctx))) as { items: Record<string, unknown>[] };
      expect(values.items).toHaveLength(1);
      expect(values.items[0]).toMatchObject({ source: enterprise.id, value: "500" });
    } finally {
      await f.close();
    }
  });

/**
 * F94-05, checked structurally as well as behaviourally. This package must be incapable of
 * holding secret material: a field that could carry one is a field that eventually will.
 */
it("declares no field that could hold a secret value", () => {
  const bundle = JSON.parse(
    readFileSync(resolve(import.meta.dirname, "../../../conformance/fixtures/configuration/app.json"), "utf8"),
  ) as { contracts: { resources: { name: string; fields?: { name: string }[] }[] } };
  const material = /^(secret|password|token|credential|privateKey|apiKey)$/i;
  const offending = bundle.contracts.resources.flatMap((r) =>
    (r.fields ?? []).filter((field) => material.test(field.name)).map((field) => `${r.name}.${field.name}`),
  );
  // `ParameterType.secret` and `ParameterDefinition.secret` are booleans, not material, and
  // `secretRef` is a reference — so the only exact matches would be real value fields.
  expect(offending.filter((name) => !name.endsWith("ParameterType.secret") && !name.endsWith("ParameterDefinition.secret"))).toEqual([]);
  // Repository, SpecificationPin and Realization come from the co-deployed specification
  // package this one pins against; the rest are ours.
  expect(bundle.contracts.resources.map((r) => r.name).sort()).toEqual([
    "Configuration", "ConfigurationLayer", "ParameterAssignment", "ParameterDefinition",
    "ParameterType", "Realization", "Repository", "ResolvedConfiguration", "ResolvedValue",
    "SecretBinding", "SpecificationPin",
  ]);
});
