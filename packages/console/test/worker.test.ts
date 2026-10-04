/**
 * The Workers entrypoint, assembled.
 *
 * Every part of this file's dependencies is tested elsewhere; the entrypoint itself was not,
 * and it is the only place `/v2`, R2, D1, the credential store and the token endpoint are
 * wired to each other. Both production incidents on this deployment were assembly faults that
 * every underlying suite passed through: a Worker deployed with no secrets, and a health check
 * that answered `ok` while every authenticated request returned 503.
 *
 * So the fakes here are deliberately thin. D1 is real `node:sqlite` running the real
 * migrations, which are otherwise never executed by any test; the bucket is the same in-memory
 * R2 the registry suite uses. What is being tested is the wiring, not the parts.
 */
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";
import type { D1Database } from "@cloudflare/workers-types";
import worker, { type Env } from "../src/worker.js";
import { credentialStore, type SqlLike } from "../src/credentials.js";
import { memoryBucket } from "./r2-registry.test.js";

const migration = (name: string) =>
  readFileSync(new URL(`../migrations/${name}`, import.meta.url), "utf8");

/** D1's surface over a real SQLite engine, so the migrations actually run. */
function d1(): { db: DatabaseSync; binding: D1Database; sql: SqlLike } {
  const db = new DatabaseSync(":memory:");
  db.exec(migration("0001_console.sql"));
  db.exec(migration("0003_registry_credentials.sql"));
  const binding = {
    prepare(text: string) {
      let bound: unknown[] = [];
      const statement = {
        bind(...params: unknown[]) {
          bound = params;
          return statement;
        },
        async all() {
          return { results: db.prepare(text).all(...(bound as never[])) };
        },
        async run() {
          const result = db.prepare(text).run(...(bound as never[]));
          return { meta: { changes: Number(result.changes) } };
        },
        async first() {
          return db.prepare(text).get(...(bound as never[])) ?? null;
        },
      };
      return statement;
    },
  } as unknown as D1Database;
  const sql: SqlLike = {
    async all(text, params) {
      return db.prepare(text).all(...(params as never[])) as Record<string, unknown>[];
    },
    async run(text, params) {
      return { changes: Number(db.prepare(text).run(...(params as never[])).changes) };
    },
  };
  return { db, binding, sql };
}

/** `omit` expresses "this was never configured", which is the case under test. */
function env(
  omit: (keyof Env)[] = [],
  overrides: Partial<Env> = {},
): { env: Env; sql: SqlLike } {
  const { binding, sql } = d1();
  const built = {
      DB: binding,
      ASSETS: { fetch: async () => new Response("<!doctype html>", { status: 200 }) },
      BLOBS: memoryBucket(),
      INSTANCE_AUTHORITY: "registry.example",
      INSTANCE_NAME: "Forge",
      OCI_BACKEND: "r2",
      OCI_REPOSITORY: "forge",
      REGISTRY_TOKEN_SECRET: "s".repeat(64),
      SIGNING_KEY_JWK: "{}",
      ADMIN_TOKEN: "a".repeat(32),
      ...overrides,
  } as Env;
  for (const key of omit) delete (built as unknown as Record<string, unknown>)[key as string];
  return { sql, env: built };
}

const get = (e: Env, path: string, init?: RequestInit) =>
  worker.fetch(new Request(`https://registry.example${path}`, init), e);

describe("the health check reports what the instance can actually serve", () => {
  it("is ok when every binding and secret the configuration implies is present", async () => {
    const response = await get(env().env, "/healthz");
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ status: "ok" });
  });

  it("fails, and names the secret, when the registry is enabled without one", async () => {
    // The production incident: `wrangler deploy` reads Cloudflare's secret store, `fg secret
    // set` writes ForgeGraph's. The Worker came up with none of them and reported healthy.
    const response = await get(env(["REGISTRY_TOKEN_SECRET"]).env, "/healthz");
    expect(response.status).toBe(503);
    const body = (await response.json()) as { status: string; missing: string[] };
    expect(body.status).toBe("unconfigured");
    expect(body.missing).toContain("REGISTRY_TOKEN_SECRET");
  });

  it("fails, and names the binding, when OCI_BACKEND=r2 has no bucket", async () => {
    const body = (await (
      await get(env(["BLOBS"]).env, "/healthz")
    ).json()) as { missing: string[] };
    expect(body.missing).toContain("BLOBS");
  });

  it("fails when INSTANCE_AUTHORITY is unset, which every /api/* request needs", async () => {
    const response = await get(env(["INSTANCE_AUTHORITY"]).env, "/healthz");
    expect(response.status).toBe(503);
    expect((await response.json() as { missing: string[] }).missing).toContain(
      "INSTANCE_AUTHORITY",
    );
  });

  it("names the Access settings a token minted for another app would otherwise satisfy", async () => {
    const body = (await (
      await get(env([], { AUTH_MODE: "cloudflare-access" }).env, "/healthz")
    ).json()) as { missing: string[] };
    expect(body.missing).toEqual(
      expect.arrayContaining(["ACCESS_TEAM_DOMAIN", "ACCESS_AUD"]),
    );
  });
});

describe("the registry endpoint", () => {
  it("challenges an unauthenticated client instead of serving it", async () => {
    const response = await get(env().env, "/v2/");
    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate") ?? "").toContain("Bearer realm=");
  });

  it("refuses outright rather than advertising a token endpoint it cannot serve", async () => {
    // Without the secret there is no `/v2/token`, so a 401 naming one sends `docker login`
    // into a loop it can never exit. Answering "this instance has no registry" is the only
    // honest response.
    const response = await get(env(["REGISTRY_TOKEN_SECRET"]).env, "/v2/");
    expect(response.status).toBe(404);
    expect(response.headers.get("www-authenticate")).toBeNull();
    expect(await response.json()).toMatchObject({
      errors: [{ code: "UNSUPPORTED" }],
    });
  });

  it("carries a real credential from Basic through token exchange to an authorized request", async () => {
    // The seam no test crossed: credential store -> /v2/token -> bearer -> authorize.
    const { env: e, sql } = env();
    const { credential, secret } = await credentialStore(sql).create({
      label: "ci",
      scopes: ["pull", "push"],
      createdBy: "audit",
    });

    const basic = Buffer.from(`${credential.id}:${secret}`).toString("base64");
    const exchange = await get(e, "/v2/token?scope=repository:forge:pull,push", {
      headers: { authorization: `Basic ${basic}` },
    });
    expect(exchange.status).toBe(200);
    const { token } = (await exchange.json()) as { token: string };
    expect(token).toBeTruthy();

    const authorized = await get(e, "/v2/", {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(authorized.status).toBe(200);
  });

  it("rejects a token this instance did not mint", async () => {
    const forged = await get(env().env, "/v2/", {
      headers: { authorization: "Bearer not.a.token" },
    });
    expect(forged.status).toBe(401);
  });
});

describe("the management API", () => {
  it("reports an incomplete instance rather than a generic failure", async () => {
    const response = await get(env(["INSTANCE_AUTHORITY"]).env, "/api/state");
    expect(response.status).toBe(503);
  });

  it("serves the console shell for a non-API path", async () => {
    expect((await get(env().env, "/")).status).toBe(200);
  });
});
