/**
 * Blob lifecycle (plan §13): intent -> uploading -> uploaded -> verifying ->
 * ready | rejected. Finalization seals immutable bytes; a still-writable
 * staging key can never be read as content.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Cause, Effect } from "effect";
import { beforeEach, describe, expect, it } from "vitest";
import { Model, type AppBundle } from "../src/model.js";
import { Engine, type CallContext } from "../src/engine.js";
import { ForgeError } from "../src/errors.js";
import { MemoryStorage } from "../src/adapters/memory.js";
import { MemoryObjectStore } from "../src/adapters/memory-objects.js";
import { testLayer } from "../src/testing.js";

const bundle = JSON.parse(readFileSync(resolve(import.meta.dirname, "..", "..", "..", "conformance", "fixtures", "acme.app.json"), "utf8")) as AppBundle;
const model = new Model(bundle);
const ctx: CallContext = { tenant: "acme", actor: "operator", requestId: "req" };
const run = <A>(e: Effect.Effect<A, ForgeError, never>) => Effect.runPromise(e);
const fails = async <A>(e: Effect.Effect<A, ForgeError, never>): Promise<ForgeError> => {
  const exit = await Effect.runPromiseExit(e);
  if (exit._tag === "Success") throw new Error("expected failure, got " + JSON.stringify(exit.value));
  const s = Cause.squash(exit.cause);
  if (s instanceof ForgeError) return s;
  throw new Error(Cause.pretty(exit.cause));
};
const DOC = "@acme/commerce/_/OrderDocument";

let objects: MemoryObjectStore;
let engine: Engine;
let order: any;
beforeEach(async () => {
  objects = new MemoryObjectStore();
  engine = new Engine(model, testLayer(new MemoryStorage(), { objects }));
  const c = await run(engine.call("@acme/commerce/_/Customer.create", { code: "ACME", name: "A" }, ctx));
  const s = await run(engine.call("@acme/commerce/_/Site.create", { customer: c.id, code: "hq", name: "HQ", timezone: "UTC" }, ctx));
  order = await run(engine.call("@acme/commerce/_/Order.create", { customer: c.id, site: s.id, subtotal: "1.00", tax: "0.00", requestedOn: "2026-09-20" }, ctx));
});

describe("blob lifecycle", () => {
  it("create yields an intent with no content; beginUpload returns a provider upload authorization", async () => {
    const doc = await run(engine.call(`${DOC}.create`, { order: order.id, kind: "Quote", label: "Q1" }, ctx));
    expect(doc).toMatchObject({ uploadState: "intent", mediaType: null, byteCount: null, digest: null, kind: "quote" });
    const up = await run(engine.call(`${DOC}.beginUpload`, { id: doc.id, expectedVersion: 1, mediaType: "application/pdf", byteCount: 5 }, ctx));
    expect(up).toMatchObject({ record: { uploadState: "uploading", version: 2 }, upload: { method: "PUT", expiresAt: expect.any(String) } });
    expect(typeof up.upload.url).toBe("string");
    expect((await fails(engine.call(`${DOC}.download`, { id: doc.id }, ctx))).code).toBe("InvalidTransition");
  });

  it("rejects media types and sizes outside the declared content policy", async () => {
    const doc = await run(engine.call(`${DOC}.create`, { order: order.id, kind: "quote", label: "Q" }, ctx));
    expect((await fails(engine.call(`${DOC}.beginUpload`, { id: doc.id, expectedVersion: 1, mediaType: "text/html", byteCount: 5 }, ctx))).code).toBe("ValidationFailed");
    expect((await fails(engine.call(`${DOC}.beginUpload`, { id: doc.id, expectedVersion: 1, mediaType: "application/pdf", byteCount: 10485761 }, ctx))).code).toBe("PayloadTooLarge");
  });

  it("finalize verifies the staged bytes, seals them immutably, and later staging writes cannot alter content", async () => {
    const doc = await run(engine.call(`${DOC}.create`, { order: order.id, kind: "quote", label: "Q" }, ctx));
    const up = await run(engine.call(`${DOC}.beginUpload`, { id: doc.id, expectedVersion: 1, mediaType: "application/pdf", byteCount: 5 }, ctx));
    await objects.simulateUpload(up.upload.url, new TextEncoder().encode("hello"), "application/pdf");
    const fin = await run(engine.call(`${DOC}.finalizeUpload`, { id: doc.id, expectedVersion: 2 }, ctx));
    expect(fin).toMatchObject({ uploadState: "ready", byteCount: 5, mediaType: "application/pdf", version: 3 });
    expect(fin.digest).toMatch(/^sha256:[0-9a-f]{64}$/);
    // overwrite the staging key after finalization: the sealed object is unaffected
    await objects.simulateUpload(up.upload.url, new TextEncoder().encode("EVIL!"), "application/pdf");
    const dl = await run(engine.call(`${DOC}.download`, { id: doc.id }, ctx));
    expect(dl).toMatchObject({ method: "GET", mediaType: "application/pdf", byteCount: 5 });
    expect(new TextDecoder().decode(await objects.simulateDownload(dl.url))).toBe("hello");
  });

  it("finalize rejects when the staged object is missing, has the wrong size, or the wrong type", async () => {
    const doc = await run(engine.call(`${DOC}.create`, { order: order.id, kind: "quote", label: "Q" }, ctx));
    const up = await run(engine.call(`${DOC}.beginUpload`, { id: doc.id, expectedVersion: 1, mediaType: "application/pdf", byteCount: 5 }, ctx));
    const missing = await fails(engine.call(`${DOC}.finalizeUpload`, { id: doc.id, expectedVersion: 2 }, ctx));
    expect(missing.code).toBe("ValidationFailed");
    await objects.simulateUpload(up.upload.url, new TextEncoder().encode("toolong"), "application/pdf");
    const rejected = await run(engine.call(`${DOC}.finalizeUpload`, { id: doc.id, expectedVersion: 2 }, ctx));
    expect(rejected).toMatchObject({ uploadState: "rejected", version: 3 });
    // a rejected blob can begin a new upload
    const again = await run(engine.call(`${DOC}.beginUpload`, { id: doc.id, expectedVersion: 3, mediaType: "application/pdf", byteCount: 7 }, ctx));
    expect(again.record.uploadState).toBe("uploading");
  });

  it("blob metadata behaves like a resource: list by order, patch label, references guarded", async () => {
    const doc = await run(engine.call(`${DOC}.create`, { order: order.id, kind: "quote", label: "Q" }, ctx));
    const page = await run(engine.call(`${DOC}.list.byOrder`, { params: { order: order.id } }, ctx));
    expect(page.items.map((i: any) => i.id)).toEqual([doc.id]);
    const p = await run(engine.call(`${DOC}.update`, { id: doc.id, expectedVersion: 1, patch: { label: "Quote v2" } }, ctx));
    expect(p.label).toBe("Quote v2");
    expect((await fails(engine.call(`${DOC}.update`, { id: doc.id, expectedVersion: 2, patch: { uploadState: "ready" } }, ctx))).code).toBe("UnknownField");
    expect((await fails(engine.call(`${DOC}.create`, { order: "ord_nope", kind: "x", label: "X" }, ctx))).code).toBe("ReferenceMissing");
  });
});

it("hashes sealed bytes even when staging changes between inspection and sealing", async () => {
  const doc = await run(engine.call(`${DOC}.create`, { order: order.id, kind: "quote", label: "Q" }, ctx));
  const up = await run(engine.call(`${DOC}.beginUpload`, { id: doc.id, expectedVersion: 1, mediaType: "application/pdf", byteCount: 5 }, ctx));
  await objects.simulateUpload(up.upload.url, new TextEncoder().encode("hello"), "application/pdf");
  const seal = objects.seal.bind(objects);
  objects.seal = (...args) => Effect.gen(function* () {
    yield* Effect.promise(() => objects.simulateUpload(up.upload.url, new TextEncoder().encode("world"), "application/pdf"));
    return yield* seal(...args);
  });
  const fin = await run(engine.call(`${DOC}.finalizeUpload`, { id: doc.id, expectedVersion: 2 }, ctx));
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode("world"));
  expect(fin.digest).toBe("sha256:" + [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, "0")).join(""));
});

it("a losing finalizer cannot overwrite the winning finalizer's sealed content", async () => {
  const doc = await run(engine.call(`${DOC}.create`, { order: order.id, kind: "quote", label: "Q" }, ctx));
  const up = await run(engine.call(`${DOC}.beginUpload`, { id: doc.id, expectedVersion: 1, mediaType: "application/pdf", byteCount: 5 }, ctx));
  await objects.simulateUpload(up.upload.url, new TextEncoder().encode("hello"), "application/pdf");
  let release!: () => void, entered!: () => void;
  const waiting = new Promise<void>(r => { entered = r; });
  const barrier = new Promise<void>(r => { release = r; });
  const seal = objects.seal.bind(objects);
  let count = 0;
  objects.seal = (...args) => Effect.gen(function* () {
    if (++count === 1) { entered(); yield* Effect.promise(() => barrier); }
    return yield* seal(...args);
  });
  const losing = fails(engine.call(`${DOC}.finalizeUpload`, { id: doc.id, expectedVersion: 2 }, ctx));
  await waiting;
  try {
    await objects.simulateUpload(up.upload.url, new TextEncoder().encode("world"), "application/pdf");
    await run(engine.call(`${DOC}.finalizeUpload`, { id: doc.id, expectedVersion: 2 }, ctx));
    await objects.simulateUpload(up.upload.url, new TextEncoder().encode("EVIL!"), "application/pdf");
  } finally { release(); }
  expect((await losing).code).toBe("VersionConflict");
  const dl = await run(engine.call(`${DOC}.download`, { id: doc.id }, ctx));
  expect(new TextDecoder().decode(await objects.simulateDownload(dl.url))).toBe("world");
});

it("rejects an immutable copy whose size changed after staging inspection", async () => {
  const doc = await run(engine.call(`${DOC}.create`, { order: order.id, kind: "quote", label: "Q" }, ctx));
  const up = await run(engine.call(`${DOC}.beginUpload`, { id: doc.id, expectedVersion: 1, mediaType: "application/pdf", byteCount: 5 }, ctx));
  await objects.simulateUpload(up.upload.url, new TextEncoder().encode("hello"), "application/pdf");
  const seal = objects.seal.bind(objects);
  objects.seal = (...args) => Effect.gen(function* () {
    yield* Effect.promise(() => objects.simulateUpload(up.upload.url, new TextEncoder().encode("longer"), "application/pdf"));
    return yield* seal(...args);
  });
  const fin = await run(engine.call(`${DOC}.finalizeUpload`, { id: doc.id, expectedVersion: 2 }, ctx));
  expect(fin.uploadState).toBe("rejected");
  expect((await fails(engine.call(`${DOC}.download`, { id: doc.id }, ctx))).code).toBe("InvalidTransition");
});

it("continues reading legacy generation-only sealed keys", async () => {
  const doc = await run(engine.call(`${DOC}.create`, { order: order.id, kind: "quote", label: "Q" }, ctx));
  const up = await run(engine.call(`${DOC}.beginUpload`, { id: doc.id, expectedVersion: 1, mediaType: "application/pdf", byteCount: 5 }, ctx));
  await objects.simulateUpload(up.upload.url, new TextEncoder().encode("hello"), "application/pdf");
  await run(engine.call(`${DOC}.finalizeUpload`, { id: doc.id, expectedVersion: 2 }, ctx));
  await objects.simulateUpload(up.upload.url, new TextEncoder().encode("hello"), "application/pdf");
  const staging = decodeURIComponent(up.upload.url.replace("memory://upload/", ""));
  await run(objects.seal(staging, `sealed/${ctx.tenant}/${model.wireName(DOC)}/${doc.id}/1`, "application/pdf"));
  // Restore the hidden provider-generation field as a legacy snapshot would.
  const { Storage } = await import("../src/services.js");
  await run(Effect.gen(function* () {
    const plan = yield* engine.planFor(`${DOC}.update`, { id: doc.id, expectedVersion: 3, patch: { label: "Legacy" } }, ctx);
    plan.after.sealedGeneration = "legacy-etag";
    yield* (yield* Storage).commit(plan);
  }).pipe(Effect.provide(engine.layer)));
  const dl = await run(engine.call(`${DOC}.download`, { id: doc.id }, ctx));
  expect(new TextDecoder().decode(await objects.simulateDownload(dl.url))).toBe("hello");
});
