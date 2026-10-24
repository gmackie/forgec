/**
 * FORG-34: a capability gate's refusal is a policy denial, not an outage. Linker gates (packed
 * binding narrowing, the dynamic linker's D1 gate and binding stubs) throw `capabilityDeniedError`;
 * the runtime surfaces it as 403 `CapabilityDenied`, not retried, with the capability and the
 * entry point / unit when the gate knows them. The Workers RPC boundary keeps only an error's
 * message, so the tests also pass the denial through a message-only copy.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createClient } from "@libsql/client";
import { Cause, Effect, Exit } from "effect";
import { describe, expect, it, vi } from "vitest";
import { createWorker } from "../src/hosts/cloudflare.js";
import { libsqlExecutor } from "../src/adapters/libsql-executor.js";
import { R2ObjectStore, type R2Like } from "../src/adapters/r2.js";
import type { SqlExecutor, SqlStatement } from "../src/adapters/sql-executor.js";
import { devHeaderAuth } from "../src/http.js";
import { asCapabilityDenied, capabilityDeniedError, ERROR_STATUS, ForgeError } from "../src/errors.js";
import { classify } from "../src/telemetry.js";
import type { AppBundle } from "../src/model.js";
import type { D1Like } from "../src/adapters/d1.js";

const bundle = JSON.parse(readFileSync(resolve(import.meta.dirname, "..", "..", "..", "conformance", "fixtures", "acme.app.json"), "utf8")) as AppBundle;
const migration = readFileSync(resolve(import.meta.dirname, "d1-harness", "migrations", "0001_all.sql"), "utf8");

/** What an RPC hop leaves of a thrown error: a fresh Error with the same message. */
const overRpc = (e: Error) => new Error(e.message);

/** A libSQL executor behind a table gate, like the dynamic linker's D1 gate seen from the child. */
async function gated(denies: (sql: string) => string | null) {
  const client = createClient({ url: "file::memory:" });
  await client.executeMultiple(migration);
  const inner = libsqlExecutor(client);
  const check = (s: SqlStatement) => {
    const capability = denies(s.sql);
    if (capability) throw overRpc(capabilityDeniedError({ capability, entryPoint: "http-route:POST /v1/customers", detail: `no capability to ${capability}` }));
  };
  const db: SqlExecutor = {
    facade: "gated",
    first: async (s) => (check(s), inner.first(s)),
    all: async (s) => (check(s), inner.all(s)),
    run: async (s) => (check(s), inner.run(s)),
    batch: async (ss) => (ss.forEach(check), inner.batch(ss)),
  };
  return { DB: db as unknown as D1Like, CURSOR_SECRET: "test" };
}

const request = (method: string, path: string, body?: unknown) =>
  new Request(`https://forge.test${path}`, { method, headers: { "content-type": "application/json", "x-forge-tenant": "t1", "x-forge-actor": "a" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });

describe("CapabilityDenied (FORG-34)", () => {
  it("is a 403, never retried, distinct from Forbidden, NotPermitted and StorageUnavailable", () => {
    expect(ERROR_STATUS["CapabilityDenied"]).toEqual({ status: 403, retryable: false, title: "Capability denied" });
    const e = asCapabilityDenied(capabilityDeniedError({ capability: "resource:@acme/commerce/_/Order#write", unit: "@acme/commerce/_/SubmitOrder", entryPoint: "http-route:POST /v1/orders/{order}/submit" }))!;
    expect(e).toBeInstanceOf(ForgeError);
    expect(e.code).toBe("CapabilityDenied");
    expect(e.status).toBe(403);
    expect(e.retryable).toBe(false);
    expect(e.problem("req-1")).toEqual({
      type: "https://forge.dev/errors/capability-denied",
      title: "Capability denied",
      status: 403,
      code: "CapabilityDenied",
      detail: "resource:@acme/commerce/_/Order#write is not granted to http-route:POST /v1/orders/{order}/submit",
      requestId: "req-1",
      retryable: false,
      capability: "resource:@acme/commerce/_/Order#write",
      unit: "@acme/commerce/_/SubmitOrder",
      entryPoint: "http-route:POST /v1/orders/{order}/submit",
    });
  });

  it("survives a message-only boundary, and a wrapped message, and ignores other errors", () => {
    const thrown = capabilityDeniedError({ capability: "binding:queue-producer:Q_FULFILL_ORDER" });
    const viaRpc = asCapabilityDenied(overRpc(thrown))!;
    expect(viaRpc.code).toBe("CapabilityDenied");
    expect(viaRpc.problem("r")).toMatchObject({ capability: "binding:queue-producer:Q_FULFILL_ORDER" });
    expect(viaRpc.problem("r")).not.toHaveProperty("entryPoint");
    expect(asCapabilityDenied(new Error(`D1_ERROR: ${thrown.message}: SQLITE_ERROR`))?.code).toBe("CapabilityDenied");
    expect(asCapabilityDenied(new Error("D1_ERROR: no such table: order_"))).toBeNull();
    expect(asCapabilityDenied("CapabilityDenied")).toBeNull();
    const same = asCapabilityDenied(viaRpc);
    expect(same).toBe(viaRpc);
  });

  it("a denied write through D1 answers 403 CapabilityDenied, not 503 StorageUnavailable, and is recorded in telemetry", async () => {
    const env = await gated((sql) => (/^\s*insert\s+into\s+customer\b/i.test(sql) ? "resource:@acme/commerce/_/Customer#write" : null));
    const lines: string[] = [];
    const log = vi.spyOn(console, "log").mockImplementation((line: unknown) => void lines.push(String(line)));
    try {
      const worker = createWorker(bundle, { auth: devHeaderAuth(), postCommit: async () => undefined });
      const res = await worker.fetch(request("POST", "/v1/customers", { code: "C-1", name: "One" }), env as never, { waitUntil: () => undefined });
      expect(res.status).toBe(403);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body).toMatchObject({ code: "CapabilityDenied", status: 403, retryable: false, capability: "resource:@acme/commerce/_/Customer#write", entryPoint: "http-route:POST /v1/customers" });
      const events = lines.filter((l) => l.startsWith('{"forge":"operation"')).map((l) => JSON.parse(l) as Record<string, unknown>);
      expect(events).toContainEqual(expect.objectContaining({ operation: "@acme/commerce/_/Customer.create", status: 403, code: "CapabilityDenied", outcome: "excluded", decision: "deny" }));
    } finally {
      log.mockRestore();
    }
  });

  it("a denied read answers 403 CapabilityDenied; undenied paths are unchanged", async () => {
    const env = await gated((sql) => (/\bfrom\s+site\b/i.test(sql) && !/^\s*insert/i.test(sql) ? "resource:@acme/commerce/_/Site#read" : null));
    const worker = createWorker(bundle, { auth: devHeaderAuth(), postCommit: async () => undefined });
    const ctx = { waitUntil: () => undefined };
    const created = await worker.fetch(request("POST", "/v1/customers", { code: "C-2", name: "Two" }), env as never, ctx);
    expect(created.status).toBe(201);
    expect((await worker.fetch(request("GET", "/v1/customers"), env as never, ctx)).status).toBe(200);
    const denied = await worker.fetch(request("GET", "/v1/sites"), env as never, ctx);
    expect(denied.status).toBe(403);
    expect(await denied.json()).toMatchObject({ code: "CapabilityDenied", capability: "resource:@acme/commerce/_/Site#read" });
  });

  it("the object store reports a denied bucket as CapabilityDenied", async () => {
    const deny = () => Promise.reject(overRpc(capabilityDeniedError({ capability: "binding:r2:BLOBS", entryPoint: "packed:forge-acme-x" })));
    const bucket = { head: deny, get: deny, put: deny, delete: deny } as unknown as R2Like;
    const exit = await Effect.runPromiseExit(new R2ObjectStore(bucket, { baseUrl: "https://x", secret: "s" }).head("k"));
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) expect((Cause.squash(exit.cause) as ForgeError).code).toBe("CapabilityDenied");
  });

  it("telemetry classifies a denial like other policy refusals", () => {
    expect(classify(403, "CapabilityDenied")).toBe("excluded");
  });
});
