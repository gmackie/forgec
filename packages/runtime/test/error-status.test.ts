/**
 * FORG-44: a declared error chooses its HTTP status (`InvalidManifest status 422`). The runtime
 * serves the declared status, OpenAPI lists it there, and an error without `status` stays 409.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { Model, type AppBundle } from "../src/model.js";
import { Engine } from "../src/engine.js";
import { ForgeError } from "../src/errors.js";
import { MemoryStorage } from "../src/adapters/memory.js";
import { testLayer } from "../src/testing.js";
import { createHttpHandler, devHeaderAuth } from "../src/http.js";
import { defineFunction } from "../src/functions.js";

const fixture = resolve(import.meta.dirname, "..", "..", "..", "conformance", "fixtures", "error-status");
const bundle = JSON.parse(readFileSync(resolve(fixture, "app.json"), "utf8")) as AppBundle;
const model = new Model(bundle);
const id = "@fixture/error-status/_/ValidateManifest";

/** Fails with the error the manifest names; "ok" succeeds. */
const validate = defineFunction(id, (deps) =>
  Effect.gen(function* () {
    const { manifest } = deps.input as { manifest: string };
    if (manifest === "ok") return { accepted: true };
    // A body that crossed a unit boundary (a packed script) revives the error from its code alone.
    if (manifest === "revived") return yield* Effect.fail(new ForgeError({ code: `${id}.InvalidManifest`, detail: "revived" }));
    return yield* deps.fail(manifest, `manifest is ${manifest}`);
  }),
);

const handler = createHttpHandler(model, new Engine(model, testLayer(new MemoryStorage()), { functions: [validate] }), { auth: devHeaderAuth() });
const post = (manifest: string) =>
  handler(new Request("https://api.test/v1/manifests/validate", { method: "POST", headers: { "content-type": "application/json", "x-forge-tenant": "acme", "x-forge-actor": "operator" }, body: JSON.stringify({ manifest }) }));

describe("declared error statuses", () => {
  it.each([
    ["InvalidManifest", 422],
    ["ManifestRetired", 410],
    ["ManifestLocked", 409],
  ])("%s is served as %i with a matching problem body", async (name, status) => {
    const res = await post(name);
    expect(res.status).toBe(status);
    expect(res.headers.get("content-type")).toBe("application/problem+json");
    expect(await res.json()).toMatchObject({ code: `${id}.${name}`, status, title: name, retryable: false, type: `urn:forge:error:${id}.${name}`, detail: `manifest is ${name}` });
  });

  it("keeps the declared status for an error revived from its code", async () => {
    const res = await post("revived");
    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({ code: `${id}.InvalidManifest`, status: 422, detail: "revived" });
  });

  it("succeeds when nothing fails", async () => {
    const res = await post("ok");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ accepted: true });
  });

  it("the bundled OpenAPI lists each error under the status the runtime serves", () => {
    const responses = (bundle as unknown as { openapi: { paths: Record<string, { post: { responses: Record<string, { description: string }> } }> } }).openapi.paths["/v1/manifests/validate"]!.post.responses;
    expect(responses["422"]!.description).toBe(`ValidationFailed; domain errors: ${id}.InvalidManifest`);
    expect(responses["410"]!.description).toBe(`Domain errors: ${id}.ManifestRetired`);
    expect(responses["409"]!.description).toBe(`Domain errors: ${id}.ManifestLocked`);
  });
});
