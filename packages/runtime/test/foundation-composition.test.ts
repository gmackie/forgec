/** Executed by scripts/verify-foundation.mjs against freshly compiled source fixtures. */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Cause, Effect } from "effect";
import { describe, it, expect } from "vitest";
import { Model, type AppBundle } from "../src/model.js";
import { Engine, type CallContext } from "../src/engine.js";
import { MemoryStorage } from "../src/adapters/memory.js";
import { testLayer } from "../src/testing.js";
import { defineFunction } from "../src/functions.js";
import { ForgeError } from "../src/errors.js";

const fixturePath = process.env["FORGE_FOUNDATION_BUNDLE"] ?? resolve(import.meta.dirname, "../../../conformance/foundation/composition.app.json");
const bundle = JSON.parse(readFileSync(fixturePath, "utf8")) as AppBundle;
const ids = { evidence: "@foundation-probe/records/_/EvidenceBundle", rename: "@foundation-probe/records/_/RenameEvidence", issue: "@foundation-probe/app/_/Issue", publish: "@foundation-probe/app/_/PublishIssue", notify: "@foundation-probe/remote/_/Notify" };
const ctx: CallContext = { tenant: "one", actor: "operator", requestId: "probe" };
const run = <A>(effect: Effect.Effect<A, ForgeError>) => Effect.runPromise(effect);
const failure = async (effect: Effect.Effect<unknown, ForgeError>) => {
  const exit = await Effect.runPromiseExit(effect);
  if (exit._tag === "Success") throw new Error("expected operation to fail");
  const error = Cause.squash(exit.cause);
  if (!(error instanceof ForgeError)) throw error;
  return error;
};
function setup() {
  const storage = new MemoryStorage();
  const model = new Model(bundle);
  const notifications: unknown[] = [];
  const rename = defineFunction(ids.rename, deps => {
    const input = deps.input as { bundle: string; expectedVersion: number; label: string };
    return deps.resources["EvidenceBundle"]!.update(input.bundle, input.expectedVersion, { label: input.label });
  });
  const publish = defineFunction(ids.publish, deps => Effect.gen(function* () {
    const input = deps.input as { issue: string; expectedVersion: number; title: string };
    const issue = yield* deps.resources["Issue"]!.get(input.issue);
    yield* deps.resources["EvidenceBundle"]!.get(issue["evidence"] as string);
    const receipt = yield* deps.external(ids.notify, { reference: input.issue });
    if (!receipt.ok) return yield* deps.fail("DeliveryUnavailable", receipt.detail);
    return yield* deps.resources["Issue"]!.update(input.issue, input.expectedVersion, { title: input.title });
  }));
  const engine = new Engine(model, testLayer(storage), { functions: [rename, publish], externals: { [ids.notify]: async input => { notifications.push(input); return { ok: true, value: { reference: "receipt" } }; } } });
  return { storage, model, engine, notifications };
}

describe("explicit Foundation package deployment", () => {
  it("keeps dependency ownership and excludes resources/functions from remote-only imports", () => {
    const { model } = setup();
    expect(model.resources.map(r => r.id).sort()).toEqual([ids.issue, ids.evidence].sort());
    expect(model.function(ids.rename)?.id).toBe(ids.rename);
    expect(model.function(ids.notify)).toBeUndefined();
    expect(model.resource(ids.issue).fields.find(f => f.name === "evidence")?.type.base).toEqual({ kind: "reference", resource: ids.evidence });
  });
  it("writes and reads an app sidecar reference while preserving package IDs", async () => {
    const { engine } = setup();
    const evidence = await run(engine.call(`${ids.evidence}.create`, { label: "initial" }, ctx));
    const issue = await run(engine.call(`${ids.issue}.create`, { evidence: evidence["id"], title: "Issue" }, ctx));
    const read = await run(engine.call(`${ids.issue}.get`, { id: issue["id"] }, ctx));
    expect(read["evidence"]).toBe(evidence["id"]);
    const renamed = await run(engine.call(ids.rename, { bundle: evidence["id"], expectedVersion: 1, label: "verified" }, ctx));
    expect(renamed).toMatchObject({ label: "verified", version: 2 });
    expect((await run(engine.call(`${ids.evidence}.get`, { id: evidence["id"] }, ctx)))["label"]).toBe("verified");
  });
  it("rejects missing and cross-tenant imported references", async () => {
    const { engine } = setup();
    const evidence = await run(engine.call(`${ids.evidence}.create`, { label: "secret" }, ctx));
    expect((await failure(engine.call(`${ids.issue}.create`, { evidence: "missing", title: "bad" }, ctx))).code).toBe("ReferenceMissing");
    expect((await failure(engine.call(`${ids.issue}.create`, { evidence: evidence["id"], title: "bad" }, { ...ctx, tenant: "two" }))).code).toBe("ReferenceMissing");
    expect((await failure(engine.call(`${ids.evidence}.get`, { id: evidence["id"] }, { ...ctx, tenant: "two" }))).code).toBe("NotFound");
  });
  it("restricts deletion of a package-owned aggregate referenced by the application", async () => {
    const { engine } = setup();
    const evidence = await run(engine.call(`${ids.evidence}.create`, { label: "support" }, ctx));
    await run(engine.call(`${ids.issue}.create`, { evidence: evidence["id"], title: "Issue" }, ctx));
    expect((await failure(engine.call(`${ids.evidence}.delete`, { id: evidence["id"], expectedVersion: 1 }, ctx))).code).toBe("HasDependents");
  });
  it("registers package functions explicitly and keeps remote calls explicitly bound", async () => {
    const { engine, notifications } = setup();
    const evidence = await run(engine.call(`${ids.evidence}.create`, { label: "support" }, ctx));
    const issue = await run(engine.call(`${ids.issue}.create`, { evidence: evidence["id"], title: "Issue" }, ctx));
    expect(await run(engine.call(ids.publish, { issue: issue["id"], expectedVersion: 1, title: "published" }, ctx))).toMatchObject({ title: "published", version: 2 });
    expect(notifications).toEqual([{ reference: issue["id"] }]);
    const missing = new Engine(new Model(bundle), testLayer(new MemoryStorage()));
    expect((await failure(missing.call(ids.rename, {}, ctx))).code).toBe("Internal");
  });
});
