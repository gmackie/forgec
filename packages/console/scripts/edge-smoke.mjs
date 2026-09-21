#!/usr/bin/env node
/**
 * Smoke-test a deployed instance from outside, the way its two kinds of client see it.
 *
 * The check that matters most is the third one. Cloudflare Access must NOT cover /v2, because
 * the Docker CLI cannot satisfy it — it reserves Authorization for the registry's own scheme
 * and sends no custom headers. If the Access bypass for that path is missing or mis-scoped,
 * /v2 answers with an HTML login page and every container client fails with a parse error far
 * from the cause. Asking for a WWW-Authenticate challenge and getting HTML instead is the
 * single clearest signal that the bypass is wrong.
 *
 *   node scripts/edge-smoke.mjs https://forge.gmac.io [credential-id] [credential-secret]
 */
import assert from "node:assert/strict";

const base = (process.argv[2] ?? "").replace(/\/$/, "");
if (!base) {
  console.error("usage: node scripts/edge-smoke.mjs <origin> [credential-id] [secret]");
  process.exit(2);
}
const [, , , id, secret] = process.argv;
let failures = 0;
const check = async (name, fn) => {
  try {
    await fn();
    console.log(`ok    ${name}`);
  } catch (error) {
    failures++;
    console.error(`FAIL  ${name}\n      ${error.message}`);
  }
};

await check("/healthz is public and reports ok", async () => {
  const response = await fetch(`${base}/healthz`);
  assert.equal(response.status, 200);
  assert.equal((await response.json()).status, "ok");
});

await check("/api/* is behind Access", async () => {
  const response = await fetch(`${base}/api/state`, { redirect: "manual" });
  // Either Access redirects to its login domain, or the worker rejects the missing assertion.
  const location = response.headers.get("location") ?? "";
  assert.ok(
    (response.status >= 300 && response.status < 400 && /cloudflareaccess\.com/.test(location)) ||
      response.status === 401,
    `expected an Access redirect or 401, got ${response.status} ${location}`,
  );
});

await check("/v2/ answers the registry challenge and is NOT behind Access", async () => {
  const response = await fetch(`${base}/v2/`, { redirect: "manual" });
  const body = await response.text();
  assert.ok(
    !/<!doctype html|<html/i.test(body),
    "got an HTML page: Access is covering /v2, so container clients will fail. Add a Bypass application scoped to the /v2 path.",
  );
  assert.equal(response.status, 401, `expected 401, got ${response.status}`);
  const challenge = response.headers.get("www-authenticate") ?? "";
  assert.match(challenge, /^Bearer realm=/, "no WWW-Authenticate challenge; docker cannot discover the token endpoint");
});

if (id && secret) {
  await check("a registry credential exchanges for a token that opens /v2/", async () => {
    const authorization = `Basic ${Buffer.from(`${id}:${secret}`).toString("base64")}`;
    const exchange = await fetch(
      `${base}/v2/token?service=${new URL(base).hostname}&scope=repository:forge:pull`,
      { headers: { authorization } },
    );
    assert.equal(exchange.status, 200, `token exchange returned ${exchange.status}`);
    const { token } = await exchange.json();
    assert.ok(token, "no token in the exchange response");
    const ping = await fetch(`${base}/v2/`, {
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(ping.status, 200, `authenticated /v2/ returned ${ping.status}`);
  });
} else {
  console.log("skip  registry credential exchange (pass an id and secret to include it)");
}

process.exit(failures ? 1 : 0);
