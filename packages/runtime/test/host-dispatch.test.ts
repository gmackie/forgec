/**
 * FORG-30: `sweepTenant` is the Cloudflare host's post-commit nudge on its own, for hosts that run
 * the request in one isolate and dispatch in another (Linker B). Real SQLite D1 with the generated
 * migration, the production `createWorker`.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createClient } from "@libsql/client";
import { describe, expect, it } from "vitest";
import { createWorker } from "../src/hosts/cloudflare.js";
import { libsqlExecutor } from "../src/adapters/libsql-executor.js";
import { devHeaderAuth } from "../src/http.js";
import type { AppBundle } from "../src/model.js";
import type { D1Like } from "../src/adapters/d1.js";

const bundle = JSON.parse(readFileSync(resolve(import.meta.dirname, "..", "..", "..", "conformance", "fixtures", "acme.app.json"), "utf8")) as AppBundle;
const migration = readFileSync(resolve(import.meta.dirname, "d1-harness", "migrations", "0001_all.sql"), "utf8");

describe("Cloudflare sweepTenant (FORG-30)", () => {
  it("dispatches one tenant's pending outbox when fetch ran without a ctx", async () => {
    const client = createClient({ url: "file::memory:" });
    await client.executeMultiple(migration);
    const env = { DB: libsqlExecutor(client) as unknown as D1Like, CURSOR_SECRET: "test" };
    const worker = createWorker(bundle, { auth: devHeaderAuth() });
    const pending = async (tenant: string) => Number((await client.execute({ sql: "SELECT COUNT(*) AS n FROM forge_outbox WHERE status = 'pending' AND tenant = ?", args: [tenant] })).rows[0]!["n"]);
    for (const tenant of ["a", "b"]) {
      const res = await worker.fetch(new Request("https://forge.test/v1/customers", { method: "POST", headers: { "content-type": "application/json", "x-forge-tenant": tenant, "x-forge-actor": "x" }, body: JSON.stringify({ code: `CUS${tenant.toUpperCase()}`, name: "N" }) }), env as never);
      expect(res.status).toBe(201);
    }
    expect(await pending("a")).toBeGreaterThan(0);
    expect(await pending("b")).toBeGreaterThan(0);
    await worker.sweepTenant(env as never, "a");
    expect(await pending("a")).toBe(0);
    expect(await pending("b")).toBeGreaterThan(0);
  });
});
