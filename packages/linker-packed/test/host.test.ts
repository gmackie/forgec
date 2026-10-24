// FORG-34: the packed host's request-time narrowing. A binding the manifest declares somewhere but
// not for this script is withheld; the runtime sees a stub that refuses it, so the request answers
// 403 CapabilityDenied instead of silently falling back (BLOBS to an in-memory store, a workflow
// binding to the cron timer). Runs the host in Node over SQLite, no workerd.
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { Model, type AppBundle } from "@forgegraph/runtime";
import type { SqlExecutor, SqlStatement } from "@forgegraph/runtime/sql-executor";
import { cloudflareObjects } from "@forgegraph/runtime/cloudflare";
import { allFeatures, featuresNamed, requiredFeatures, type Feature } from "@forgegraph/runtime/features";
import { packed, type HostConfig } from "../src/host.ts";

const root = resolve(import.meta.dirname, "../../..");
const bundle = JSON.parse(readFileSync(join(root, "conformance/fixtures/acme.app.json"), "utf8")) as AppBundle;
const migration = readFileSync(join(root, "packages/runtime/test/d1-harness/migrations/0001_all.sql"), "utf8");

function sqlite(): SqlExecutor {
  const db = new DatabaseSync(":memory:");
  db.exec(migration);
  const params = (s: SqlStatement) => s.params as SQLInputValue[];
  return {
    facade: "sqlite-test",
    first: async <T>(s: SqlStatement) => (db.prepare(s.sql).get(...params(s)) ?? null) as T | null,
    all: async <T>(s: SqlStatement) => db.prepare(s.sql).all(...params(s)) as T[],
    run: async (s) => ({ changes: Number(db.prepare(s.sql).run(...params(s)).changes) }),
    batch: async (ss) => {
      db.exec("BEGIN");
      try {
        const out = ss.map((s) => ({ changes: Number(db.prepare(s.sql).run(...params(s)).changes) }));
        db.exec("COMMIT");
        return out;
      } catch (e) {
        db.exec("ROLLBACK");
        throw e;
      }
    },
  };
}

/** A bucket with nothing in it: finalize finds no bytes (ValidationFailed) when BLOBS is granted. */
const emptyBucket = { head: async () => null, get: async () => null, put: async () => ({ etag: "e" }), delete: async () => undefined };

const config = (bindings: string[], withheld: HostConfig["withheld"]): HostConfig => ({
  script: "forge-acme-test-finalize",
  routes: null,
  deny: [],
  bindings,
  withheld,
  dispatch: "local",
  dispatchOwner: false,
  sweeps: { outbox: false, schedules: false, workflows: false },
});

/** FORG-37: what the linker links for a group like this one, the model's features plus local dispatch. */
const sliceFeatures = featuresNamed([...requiredFeatures(new Model(bundle)), "dispatch"]);

async function finalizeWithoutBytes(cfg: HostConfig, features: readonly Feature[] = allFeatures) {
  const env: Record<string, unknown> = { DB: sqlite(), BLOBS: emptyBucket, CURSOR_SECRET: "t", FORGE_AUTH: "dev-headers" };
  const { worker } = packed(bundle, { functions: [], externals: {}, features, objects: cloudflareObjects }, cfg);
  const h = { "content-type": "application/json", "x-forge-tenant": "t1", "x-forge-actor": "a" };
  const call = async (path: string, body: unknown, version?: number) => {
    const headers = version === undefined ? h : { ...h, "if-match": `"${version}"` };
    const res = await worker.fetch(new Request(`https://forge.test${path}`, { method: "POST", headers, body: JSON.stringify(body) }), env, { waitUntil: () => undefined });
    return { status: res.status, json: (await res.json()) as Record<string, unknown> };
  };
  const c = await call("/v1/customers", { code: "BLOB", name: "B" });
  const s = await call("/v1/sites", { customer: c.json["id"], code: "hq", name: "HQ", timezone: "UTC" });
  const o = await call("/v1/orders", { customer: c.json["id"], site: s.json["id"], subtotal: "1.00", tax: "0.00", requestedOn: "2026-09-20" });
  const doc = await call("/v1/order-documents", { order: o.json["id"], kind: "quote", label: "Q1" });
  expect(doc.status).toBe(201);
  const begin = await call(`/v1/order-documents/${String(doc.json["id"])}/upload`, { expectedVersion: 1, mediaType: "application/pdf", byteCount: 5 }, 1);
  expect(begin.status).toBe(200);
  return call(`/v1/order-documents/${String(doc.json["id"])}/finalize`, { expectedVersion: 2 }, 2);
}

describe("packed host: request-time narrowing (FORG-34)", () => {
  it("a declared bucket is used as before: finalize with no bytes is ValidationFailed", async () => {
    const r = await finalizeWithoutBytes(config(["DB", "BLOBS", "CURSOR_SECRET", "FORGE_AUTH"], []));
    expect(r.status).toBe(422);
    expect(r.json["code"]).toBe("ValidationFailed");
  });

  it("a withheld bucket is refused with 403 CapabilityDenied, not a silent in-memory store", async () => {
    const r = await finalizeWithoutBytes(config(["DB", "CURSOR_SECRET", "FORGE_AUTH"], [{ type: "r2", name: "BLOBS" }]));
    expect(r.status).toBe(403);
    expect(r.json).toMatchObject({ code: "CapabilityDenied", retryable: false, capability: "binding:r2:BLOBS", entryPoint: "forge-acme-test-finalize" });
  });

  // FORG-37: the runtime split does not change either answer. Blob storage comes with the blobs feature,
  // and it still reads BLOBS from the narrowed env, so the stub still refuses.
  it("with only the features its slice uses, a declared bucket and a withheld one answer as before", async () => {
    expect(sliceFeatures.map((f) => f.name)).not.toContain("changesets");
    expect((await finalizeWithoutBytes(config(["DB", "BLOBS", "CURSOR_SECRET", "FORGE_AUTH"], []), sliceFeatures)).status).toBe(422);
    const r = await finalizeWithoutBytes(config(["DB", "CURSOR_SECRET", "FORGE_AUTH"], [{ type: "r2", name: "BLOBS" }]), sliceFeatures);
    expect(r.status).toBe(403);
    expect(r.json).toMatchObject({ code: "CapabilityDenied", capability: "binding:r2:BLOBS" });
  });

  it("a script linked without the blobs feature has no blob operation to reach the withheld bucket, and a blob model without it fails at build", () => {
    // A model with blob resources needs blobs (and its storage): refused when the host is built, i.e. at link time.
    expect(() => packed(bundle, { functions: [], externals: {}, features: featuresNamed(["dispatch"]) }, config(["DB"], [{ type: "r2", name: "BLOBS" }]))).toThrow(/needs the blobs, governance/);
    expect(() => packed(bundle, { functions: [], externals: {}, features: sliceFeatures }, config(["DB"], []))).toThrow(/blobs feature needs objects/);
  });

  it("without the blobs feature, blob routes do not exist: 404, and the withheld stub is never reached", async () => {
    const noBlobs = structuredClone(bundle);
    for (const m of noBlobs.ir.modules) {
      m.resources = m.resources.filter((r) => r.kind !== "blob");
      m.workflows = [];
      m.sources = [];
      m.views = [];
      m.projections = [];
      m.caches = [];
      m.channels = (m.channels ?? []).map(({ websocket: _, ...c }) => c);
    }
    const cfg = { ...config(["DB", "CURSOR_SECRET", "FORGE_AUTH"], [{ type: "r2", name: "BLOBS" }]), dispatch: "forward" as const };
    const { worker } = packed(noBlobs, { functions: [], externals: {}, features: [] }, cfg);
    const env: Record<string, unknown> = { DB: sqlite(), BLOBS: emptyBucket, CURSOR_SECRET: "t", FORGE_AUTH: "dev-headers" };
    const res = await worker.fetch(new Request("https://forge.test/v1/order-documents/x/finalize", { method: "POST", headers: { "content-type": "application/json", "x-forge-tenant": "t1", "x-forge-actor": "a" }, body: "{}" }), env, { waitUntil: () => undefined });
    expect(res.status).toBe(404);
    const bytes = await worker.fetch(new Request("https://forge.test/_forge/objects/token"), env, { waitUntil: () => undefined });
    expect(bytes.status).not.toBe(200);
  });
});
