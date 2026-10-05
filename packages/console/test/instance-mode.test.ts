/**
 * The instance's two configuration switches, and the defaults that must not drift.
 *
 * The CSP assertions matter more than they look. Under Cloudflare Access, an expired session
 * answers an in-page `fetch` with a redirect to the team login domain, and CSP is enforced
 * against every hop of a redirect chain — so a `connect-src` that omits the team domain turns
 * re-authentication into an opaque network error. That only happens *after* a session expires,
 * which is precisely long enough to survive manual testing and reach production.
 */
import { describe, it, expect } from "vitest";
import { authFrom, securityHeadersFor } from "../src/config.js";

const csp = (config: Parameters<typeof securityHeadersFor>[0]) =>
  securityHeadersFor(config)["Content-Security-Policy"]!;

describe("instance mode", () => {
  it("leaves the self-contained CSP exactly as it was by default", () => {
    // scripts/http-smoke.mjs asserts this literal string; a self-hosted instance talks only to
    // its own origin and must keep doing so.
    expect(csp({})).toContain("connect-src 'self';");
    expect(csp({})).toContain("form-action 'self'");
    expect(csp({})).not.toContain("cloudflareaccess.com");
  });

  it("admits the team domain only when Access is actually configured", () => {
    const access = csp({
      AUTH_MODE: "cloudflare-access",
      ACCESS_TEAM_DOMAIN: "gmacko.cloudflareaccess.com",
      ACCESS_AUD: "a".repeat(64),
    });
    expect(access).toContain("connect-src 'self' https://gmacko.cloudflareaccess.com");
    expect(access).toContain("form-action 'self' https://gmacko.cloudflareaccess.com");
    // Naming a team domain without turning Access on must not widen anything.
    expect(csp({ ACCESS_TEAM_DOMAIN: "gmacko.cloudflareaccess.com" })).not.toContain(
      "cloudflareaccess.com",
    );
  });

  it("defaults to the shared administrator token, whose credential is not cookie-borne", () => {
    const auth = authFrom({ ADMIN_TOKEN: "x".repeat(40) });
    expect(auth.cookieBorne).toBe(false);
  });

  it("refuses to start half-configured for Access rather than quietly accepting tokens", () => {
    // Falling back to token auth here would leave an instance the operator believes is behind
    // SSO still accepting a bearer token.
    expect(() => authFrom({ AUTH_MODE: "cloudflare-access" })).toThrow(/ACCESS_TEAM_DOMAIN/);
    expect(() =>
      authFrom({ AUTH_MODE: "cloudflare-access", ACCESS_TEAM_DOMAIN: "t.example" }),
    ).toThrow(/ACCESS_AUD/);
    const ok = authFrom({
      AUTH_MODE: "cloudflare-access",
      ACCESS_TEAM_DOMAIN: "t.example",
      ACCESS_AUD: "a".repeat(64),
    });
    // A cookie rides along on cross-site requests, so writes require a same-origin Origin.
    expect(ok.cookieBorne).toBe(true);
  });
});
