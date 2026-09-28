import { foundation, foundationAdapters } from "./helpers/foundation.js";
import { Effect } from "effect";
import { expect, it } from "vitest";
import { Configuration } from "../src/foundation/configuration.js";
const prefix = "@forgegraph/foundation/configuration/_/";
const spec = "@forgegraph/foundation/specification/_/";
const ctx = { tenant: "acme", actor: "user", requestId: "configuration" };
const AT = "2026-01-01T00:00:00Z";
const REVISION = "a".repeat(40), OTHER_REVISION = "b".repeat(40);

for (const adapter of foundationAdapters)
  it(`${adapter}: layered defaults and overrides resolve deterministically, with provenance`, async () => {
    const f = await foundation("configuration", adapter);
    const engine = f.engine;
    try {
      const call = (op: string, input: Record<string, unknown>, context = ctx) =>
        Effect.runPromise(engine.call(op, input, context));
      const run = Effect.runPromise;
      const service = new Configuration(engine);

      // F94-01: parameters are declared by a pinned specification revision.
      const repository = await call(spec + "Repository.create", { key: "agent", provider: "git", locator: "https://example.com/agent.git" });
      const pin = await call(spec + "SpecificationPin.create", { repository: repository.id, anchor: "main", revision: REVISION });
      const otherPin = await call(spec + "SpecificationPin.create", { repository: repository.id, anchor: "main", revision: OTHER_REVISION });

      const type = async (key: string, secret: boolean) =>
        (await call(prefix + "ParameterType.create", { key, label: key, secret })).id;
      const textType = await type("text", false);
      const secretType = await type("secret", true);

      const define = (p: unknown, key: string, valueType: unknown, secret: boolean, required: boolean, defaultValue: string | null) =>
        call(prefix + "ParameterDefinition.create", { pin: p, key, valueType, secret, required, defaultValue });
      const model = await define(pin.id, "model", textType, false, true, "sonnet");
      const retries = await define(pin.id, "retries", textType, false, false, "3");
      const apiKey = await define(pin.id, "api-key", secretType, true, true, null);

      // A snapshot that lies is refused, so the one-hop rules built on it stay sound.
      await expect(define(pin.id, "wrong", textType, true, false, null)).rejects.toThrow();
      // A secret parameter cannot carry a default, because that default would be a secret.
      await expect(define(pin.id, "leaky", secretType, true, false, "hunter2")).rejects.toThrow();

      const layer = async (key: string, ordinal: number) =>
        (await call(prefix + "ConfigurationLayer.create", { key, label: key, ordinal })).id;
      const base = await layer("base", 1);
      const environment = await layer("environment", 2);
      const instance = await layer("instance", 3);

      const configure = (key: string, l: unknown, ordinal: number, parent: unknown = null) =>
        call(prefix + "Configuration.create", { pin: pin.id, key, layer: l, layerOrdinal: ordinal, parent });
      const root = await configure("agent", base, 1);
      const staging = await configure("agent", environment, 2, root.id);
      const leaf = await configure("agent", instance, 3, staging.id);

      // A chain must strictly increase, so precedence is a total order in either direction.
      await expect(call(prefix + "Configuration.create", { pin: pin.id, key: "bad", layer: base, layerOrdinal: 1, parent: leaf.id })).rejects.toThrow();
      // And a configuration cannot inherit across specification revisions.
      const foreign = await call(prefix + "Configuration.create", { pin: otherPin.id, key: "agent", layer: base, layerOrdinal: 1, parent: null });
      await expect(call(prefix + "Configuration.create", { pin: pin.id, key: "cross", layer: environment, layerOrdinal: 2, parent: foreign.id })).rejects.toThrow();

      const binding = await call(prefix + "SecretBinding.create", { key: "agent/api-key", reference: "vault://agent/api-key#v3" });
      const assign = (configuration: unknown, parameter: unknown, value: string | null, secretRef: unknown = null) =>
        call(prefix + "ParameterAssignment.create", { configuration, parameter, value, secretRef });

      // F94-05: a secret parameter takes a reference and refuses a literal, and an ordinary
      // parameter refuses a reference. Neither can be both, and neither can be empty.
      await expect(assign(root.id, apiKey.id, "hunter2")).rejects.toThrow();
      await expect(assign(root.id, model.id, null, binding.id)).rejects.toThrow();
      await expect(assign(root.id, model.id, null, null)).rejects.toThrow();
      await assign(root.id, apiKey.id, null, binding.id);

      // F94-02 and F94-03: base sets a value, a higher layer overrides it, and `retries` is
      // never assigned at all so it has to come from its default.
      await assign(root.id, model.id, "haiku");
      await assign(staging.id, model.id, "opus");
      // One assignment per parameter per configuration.
      await expect(assign(staging.id, model.id, "again")).rejects.toThrow();
      // And a parameter from another revision cannot be borrowed.
      const foreignParam = await define(otherPin.id, "model", textType, false, false, "x");
      await expect(assign(leaf.id, foreignParam.id, "nope")).rejects.toThrow();

      const resolution = await run(service.resolve(String(leaf.id), AT, ctx));
      const byKey = Object.fromEntries(resolution.entries.map((e) => [e.key, e]));
      // Nearest-wins: staging's override beats base, and the leaf assigned nothing.
      expect(byKey["model"]).toMatchObject({ value: "opus", source: staging.id });
      // F94-02: an unassigned parameter falls back to its default, attributed to no author.
      expect(byKey["retries"]).toMatchObject({ value: "3", source: null });
      // F94-05: the secret resolves to its binding, never to a value.
      expect(byKey["api-key"]).toMatchObject({ value: null, secretRef: binding.id });
      expect(JSON.stringify(resolution)).not.toContain("hunter2");

      // F94-06: identity is stable across re-resolution, and is over values rather than over
      // the path taken to reach them.
      const again = await run(service.resolve(String(leaf.id), AT, ctx));
      expect(again.digest).toBe(resolution.digest);
      expect(again.resolved).toBe(resolution.resolved);
      // Changing a value changes the identity.
      await assign(leaf.id, retries.id, "9");
      const changed = await run(service.resolve(String(leaf.id), AT, ctx));
      expect(changed.digest).not.toBe(resolution.digest);
      expect(Object.fromEntries(changed.entries.map((e) => [e.key, e]))["retries"]).toMatchObject({ value: "9", source: leaf.id });

      // A required parameter with neither assignment nor default is an error, not a silent gap.
      const bare = await call(prefix + "Configuration.create", { pin: otherPin.id, key: "bare", layer: base, layerOrdinal: 1, parent: null });
      await define(otherPin.id, "mandatory", textType, false, true, null);
      await expect(run(service.resolve(String(bare.id), AT, ctx))).rejects.toThrow();

      // Tenant isolation.
      await expect(run(service.resolve(String(leaf.id), AT, { ...ctx, tenant: "other" }))).rejects.toThrow();
    } finally {
      await f.close();
    }
  });
