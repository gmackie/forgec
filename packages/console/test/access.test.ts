/**
 * Cloudflare Access verification, against real RS256 signatures rather than a stub.
 *
 * Two things here are worth more than the happy path. First, that a token minted for a
 * *different application in the same Access team* is refused — Access signs every application
 * in a team with the same key set, so audience pinning is the only thing standing between this
 * console and any other app the team protects. Second, that the key set is fetched once and
 * reused, because the Worker rebuilds its API object per request and a cache in the wrong
 * scope would add a round trip to every single request without ever failing a test.
 */
import { beforeEach, describe, it, expect } from "vitest";
import { accessAuth } from "../src/auth.js";
import { accessKeys, resetAccessKeys } from "../src/access-jwks.js";
import { Problem } from "../src/model.js";

const TEAM = "gmacko.cloudflareaccess.com";
const AUD = "a".repeat(64);
const KID = "test-key-1";

const b64url = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
const encode = (value: unknown) => b64url(new TextEncoder().encode(JSON.stringify(value)));

async function keypair() {
  const pair = await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"],
  );
  const jwk = await crypto.subtle.exportKey("jwk", pair.publicKey);
  return { pair, jwks: { keys: [{ ...jwk, kid: KID, alg: "RS256", use: "sig" }] } };
}

async function sign(
  privateKey: CryptoKey,
  claims: Record<string, unknown>,
  header: Record<string, unknown> = { alg: "RS256", kid: KID },
) {
  const head = encode(header);
  const body = encode(claims);
  const signature = await crypto.subtle.sign(
    { name: "RSASSA-PKCS1-v1_5" },
    privateKey,
    new TextEncoder().encode(`${head}.${body}`),
  );
  return `${head}.${body}.${b64url(new Uint8Array(signature))}`;
}

const valid = (overrides: Record<string, unknown> = {}) => ({
  iss: `https://${TEAM}`,
  aud: [AUD],
  exp: Math.floor(Date.now() / 1000) + 600,
  email: "ops@gmac.io",
  ...overrides,
});

describe("Cloudflare Access", () => {
  beforeEach(() => resetAccessKeys());

  it("accepts an assertion the team signed, and names the human in it", async () => {
    const { pair, jwks } = await keypair();
    const fetcher = (async () => Response.json(jwks)) as unknown as typeof fetch;
    const auth = accessAuth({
      teamDomain: TEAM,
      audience: AUD,
      keys: (kid) => accessKeys(TEAM, { fetch: fetcher, kid }),
    });
    const token = await sign(pair.privateKey, valid());
    const identity = await auth.authenticate(
      new Request("https://forge.example/api/state", {
        headers: { "cf-access-jwt-assertion": token },
      }),
    );
    expect(identity).toEqual({ actor: "ops@gmac.io", via: "cloudflare-access" });
  });

  it("reads the assertion from the CF_Authorization cookie as well as the header", async () => {
    const { pair, jwks } = await keypair();
    const fetcher = (async () => Response.json(jwks)) as unknown as typeof fetch;
    const auth = accessAuth({
      teamDomain: TEAM,
      audience: AUD,
      keys: (kid) => accessKeys(TEAM, { fetch: fetcher, kid }),
    });
    const token = await sign(pair.privateKey, valid());
    const identity = await auth.authenticate(
      new Request("https://forge.example/api/state", {
        headers: { cookie: `other=1; CF_Authorization=${token}; more=2` },
      }),
    );
    expect(identity.actor).toBe("ops@gmac.io");
  });

  it("refuses a token minted for a different application in the same team", async () => {
    const { pair, jwks } = await keypair();
    const fetcher = (async () => Response.json(jwks)) as unknown as typeof fetch;
    const auth = accessAuth({
      teamDomain: TEAM,
      audience: AUD,
      keys: (kid) => accessKeys(TEAM, { fetch: fetcher, kid }),
    });
    // Correctly signed by the team, correct issuer, not expired — only the audience differs.
    const token = await sign(pair.privateKey, valid({ aud: ["b".repeat(64)] }));
    await expect(
      auth.authenticate(
        new Request("https://forge.example/api/state", {
          headers: { "cf-access-jwt-assertion": token },
        }),
      ),
    ).rejects.toMatchObject({ status: 401 });
  });

  it("refuses a wrong issuer, an expired token, a bad signature and alg=none", async () => {
    const { pair, jwks } = await keypair();
    const other = await keypair();
    const fetcher = (async () => Response.json(jwks)) as unknown as typeof fetch;
    const auth = accessAuth({
      teamDomain: TEAM,
      audience: AUD,
      keys: (kid) => accessKeys(TEAM, { fetch: fetcher, kid }),
    });
    const attempt = (token: string) =>
      auth.authenticate(
        new Request("https://forge.example/api/state", {
          headers: { "cf-access-jwt-assertion": token },
        }),
      );

    await expect(attempt(await sign(pair.privateKey, valid({ iss: "https://evil.example" })))).rejects.toBeInstanceOf(Problem);
    await expect(attempt(await sign(pair.privateKey, valid({ exp: Math.floor(Date.now() / 1000) - 120 })))).rejects.toBeInstanceOf(Problem);
    // Signed by a key the team never published.
    await expect(attempt(await sign(other.pair.privateKey, valid()))).rejects.toBeInstanceOf(Problem);
    // A token must not be able to nominate how it is verified.
    await expect(
      attempt(`${encode({ alg: "none", kid: KID })}.${encode(valid())}.`),
    ).rejects.toBeInstanceOf(Problem);
    await expect(attempt("")).rejects.toBeInstanceOf(Problem);
    await expect(attempt("not.a.token")).rejects.toBeInstanceOf(Problem);
  });

  it("fetches the key set once and reuses it across adapters, as the Worker rebuilds per request", async () => {
    const { pair, jwks } = await keypair();
    let fetches = 0;
    const fetcher = (async () => {
      fetches++;
      return Response.json(jwks);
    }) as unknown as typeof fetch;
    const token = await sign(pair.privateKey, valid());
    const request = () =>
      new Request("https://forge.example/api/state", {
        headers: { "cf-access-jwt-assertion": token },
      });

    // Each iteration builds a fresh adapter, exactly as worker.ts does per request.
    for (let i = 0; i < 5; i++) {
      const auth = accessAuth({
        teamDomain: TEAM,
        audience: AUD,
        keys: (kid) => accessKeys(TEAM, { fetch: fetcher, kid }),
      });
      expect((await auth.authenticate(request())).actor).toBe("ops@gmac.io");
    }
    expect(fetches).toBe(1);
  });

  it("keeps serving cached keys when a later refresh fails", async () => {
    const { pair, jwks } = await keypair();
    let fail = false;
    const fetcher = (async () => {
      if (fail) throw new Error("network");
      return Response.json(jwks);
    }) as unknown as typeof fetch;
    const auth = accessAuth({
      teamDomain: TEAM,
      audience: AUD,
      keys: (kid) => accessKeys(TEAM, { fetch: fetcher, kid }),
    });
    const token = await sign(pair.privateKey, valid());
    const request = () =>
      new Request("https://forge.example/api/state", {
        headers: { "cf-access-jwt-assertion": token },
      });
    expect((await auth.authenticate(request())).actor).toBe("ops@gmac.io");

    // An unknown kid forces a refetch attempt; it fails, and the cached set must still work.
    fail = true;
    const unknownKid = await sign(pair.privateKey, valid(), { alg: "RS256", kid: "rotated" });
    await expect(
      auth.authenticate(
        new Request("https://forge.example/api/state", {
          headers: { "cf-access-jwt-assertion": unknownKid },
        }),
      ),
    ).rejects.toBeInstanceOf(Problem);
    // A blip fetching keys must not lock out everyone holding a valid assertion.
    expect((await auth.authenticate(request())).actor).toBe("ops@gmac.io");
  });
});
