/**
 * Registry credentials and the token exchange a container client performs.
 *
 * These assertions are about what happens when things go wrong — a revoked credential, an
 * expired one, a tampered token, a scope that was never granted — because that is where a
 * credential system either holds or quietly does not.
 */
import { DatabaseSync } from "node:sqlite";
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { credentialStore, type SqlLike } from "../src/credentials.js";
import {
  createTokenEndpoint,
  mintRegistryToken,
  verifyRegistryToken,
} from "../src/registry-token.js";

function store() {
  const db = new DatabaseSync(":memory:");
  db.exec(
    readFileSync(new URL("../migrations/0003_registry_credentials.sql", import.meta.url), "utf8"),
  );
  const sql: SqlLike = {
    async all(text, params) {
      return db.prepare(text).all(...(params as never[])) as Record<string, unknown>[];
    },
    async run(text, params) {
      const result = db.prepare(text).run(...(params as never[]));
      return { changes: Number(result.changes) };
    },
  };
  return credentialStore(sql);
}

const basic = (id: string, secret: string) =>
  new Request("https://registry.example/v2/token?scope=repository:forge:pull,push", {
    headers: { authorization: `Basic ${btoa(`${id}:${secret}`)}` },
  });

describe("registry credentials", () => {
  it("returns the secret once, stores only a hash, and verifies it back", async () => {
    const credentials = store();
    const { credential, secret } = await credentials.create({
      label: "ci",
      scopes: ["pull", "push"],
      createdBy: "ops@example",
    });
    expect(secret).toMatch(/^[a-f0-9]{64}$/);
    // The plaintext must not be recoverable from the record.
    expect(JSON.stringify(await credentials.list())).not.toContain(secret);
    expect((await credentials.verify(credential.id, secret))?.id).toBe(credential.id);
    expect(await credentials.verify(credential.id, "wrong")).toBeNull();
    expect(await credentials.verify("fgc_unknown", secret)).toBeNull();
  });

  it("stops accepting a credential the moment it is revoked", async () => {
    const credentials = store();
    const { credential, secret } = await credentials.create({
      label: "laptop",
      scopes: ["pull"],
      createdBy: "ops@example",
    });
    expect(await credentials.verify(credential.id, secret)).not.toBeNull();
    expect(await credentials.revoke(credential.id, new Date().toISOString())).toBe(true);
    expect(await credentials.verify(credential.id, secret)).toBeNull();
    // Revoking twice is not a second success; an operator should not think they undid it.
    expect(await credentials.revoke(credential.id, new Date().toISOString())).toBe(false);
  });

  it("refuses an expired credential without needing anyone to revoke it", async () => {
    const credentials = store();
    const { credential, secret } = await credentials.create({
      label: "temporary",
      scopes: ["pull"],
      createdBy: "ops@example",
      expiresAt: new Date(Date.now() - 1000).toISOString(),
    });
    expect(await credentials.verify(credential.id, secret)).toBeNull();
  });

  it("grants only the intersection of what was asked for and what is held", async () => {
    const credentials = store();
    const { credential, secret } = await credentials.create({
      label: "read-only",
      scopes: ["pull"],
      createdBy: "ops@example",
    });
    const issue = createTokenEndpoint({
      store: credentials,
      secret: "test-signing-secret",
      service: "registry.example",
      repository: "forge",
    });
    const response = await issue(basic(credential.id, secret));
    expect(response.status).toBe(200);
    const { token } = (await response.json()) as { token: string };
    const claims = await verifyRegistryToken("test-signing-secret", token, "registry.example");
    // push was requested in the scope parameter but never granted, so it must not appear.
    expect(claims?.scopes).toEqual(["pull"]);
    expect(claims?.sub).toBe(credential.id);
  });

  it("refuses a token that was tampered with, signed elsewhere, or has expired", async () => {
    const good = await mintRegistryToken("secret-a", {
      sub: "fgc_1",
      aud: "registry.example",
      exp: Math.floor(Date.now() / 1000) + 60,
      scopes: ["pull"],
    });
    expect(await verifyRegistryToken("secret-a", good, "registry.example")).not.toBeNull();
    // A different signing secret must not validate.
    expect(await verifyRegistryToken("secret-b", good, "registry.example")).toBeNull();
    // A token minted for another service must not be replayable here.
    expect(await verifyRegistryToken("secret-a", good, "other.example")).toBeNull();
    // A flipped payload byte must invalidate the signature.
    const parts = good.split(".");
    expect(
      await verifyRegistryToken("secret-a", `${parts[0]}.${parts[1]}x.${parts[2]}`, "registry.example"),
    ).toBeNull();
    const expired = await mintRegistryToken("secret-a", {
      sub: "fgc_1",
      aud: "registry.example",
      exp: Math.floor(Date.now() / 1000) - 1,
      scopes: ["pull"],
    });
    expect(await verifyRegistryToken("secret-a", expired, "registry.example")).toBeNull();
  });

  it("does not let an unsigned token through by nominating its own algorithm", async () => {
    // The classic JWT failure: alg=none. The verifier pins HS256 and ignores the header's claim.
    const head = btoa(JSON.stringify({ alg: "none", typ: "JWT" })).replace(/=+$/, "");
    const body = btoa(
      JSON.stringify({
        sub: "fgc_1",
        aud: "registry.example",
        exp: Math.floor(Date.now() / 1000) + 60,
        scopes: ["push"],
      }),
    ).replace(/=+$/, "");
    expect(
      await verifyRegistryToken("secret-a", `${head}.${body}.`, "registry.example"),
    ).toBeNull();
  });

  it("rejects a malformed Basic header rather than erroring", async () => {
    const issue = createTokenEndpoint({
      store: store(),
      secret: "s",
      service: "registry.example",
      repository: "forge",
    });
    for (const header of ["", "Bearer x", "Basic !!!not-base64!!!"]) {
      const response = await issue(
        new Request("https://registry.example/v2/token", {
          ...(header ? { headers: { authorization: header } } : {}),
        }),
      );
      expect(response.status).toBe(401);
    }
  });
});
