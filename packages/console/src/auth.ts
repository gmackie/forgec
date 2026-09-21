/**
 * Who is making this request.
 *
 * The console has always authenticated with one shared administrator token, checked before
 * routing so that an unauthenticated caller cannot even learn which API paths exist. That
 * property is worth keeping, so the adapter slots into the same position rather than moving
 * the check.
 *
 * An adapter also reports whether its credential is **cookie-borne**. That matters: a token in
 * an `Authorization` header is only ever sent by code that means to send it, while a cookie is
 * attached by the browser to cross-site requests too. The CSRF check in `api.ts` tightens
 * accordingly.
 */
import { Problem } from "./model.js";

export interface Identity {
  /** Who to record in the audit log. */
  actor: string;
  via: "token" | "cloudflare-access";
}

export interface AuthAdapter {
  /** Resolves to the caller's identity, or throws a `Problem` (401/503). */
  authenticate(request: Request): Promise<Identity>;
  /**
   * True when the browser attaches the credential automatically. Such a credential rides along
   * on cross-site requests, so writes additionally require a same-origin `Origin` header.
   */
  readonly cookieBorne: boolean;
}

/**
 * Compare two secrets without leaking their contents through timing.
 *
 * Both sides are hashed first so the comparison loop runs over a fixed 32 bytes regardless of
 * input length — otherwise the loop itself would reveal how much of a guess was correct.
 */
export async function equalSecret(
  actual: string,
  expected: string,
): Promise<boolean> {
  const hash = async (s: string) =>
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)),
    );
  const [a, b] = await Promise.all([hash(actual), hash(expected)]);
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}

/** The shared-administrator-token scheme: this instance's own authority, no upstream. */
export function tokenAuth(token: string): AuthAdapter {
  return {
    cookieBorne: false,
    async authenticate(request) {
      // A short or absent token is a misconfiguration, not a rejected caller: 503, not 401.
      if (token.length < 32)
        throw new Problem(
          503,
          "Configure an administrator token of at least 32 characters.",
        );
      if (
        !(await equalSecret(
          request.headers.get("authorization") ?? "",
          `Bearer ${token}`,
        ))
      )
        throw new Problem(401, "Enter this instance’s administrator token.");
      return { actor: "operator", via: "token" };
    },
  };
}

// ---------------------------------------------------------------- Cloudflare Access

const b64urlBytes = (s: string) =>
  Uint8Array.from(
    atob(
      s.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(s.length / 4) * 4, "="),
    ),
    (c) => c.charCodeAt(0),
  );
const b64urlJson = (s: string) =>
  JSON.parse(new TextDecoder().decode(b64urlBytes(s))) as Record<string, unknown>;

export interface AccessOptions {
  /** e.g. `example.cloudflareaccess.com` */
  teamDomain: string;
  /** The application's AUD tag. Required — see below. */
  audience: string;
  keys(kid: string): Promise<Map<string, CryptoKey>>;
  /** Tolerance for clock drift between Cloudflare and this worker. */
  skewSeconds?: number;
}

/**
 * Trust the identity Cloudflare Access asserts at the edge.
 *
 * `audience` is not optional and must be the *application's* AUD tag. Access issues tokens for
 * every application in a team from the same issuer and the same key set, so without pinning
 * the audience a token minted for any other application in the team would authenticate here.
 *
 * The signing algorithm is pinned rather than read from the token header: a token is never
 * allowed to nominate how it should be verified.
 */
export function accessAuth(options: AccessOptions): AuthAdapter {
  const skew = options.skewSeconds ?? 30;
  return {
    // Access falls back to a cookie, which the browser attaches cross-site.
    cookieBorne: true,
    async authenticate(request) {
      const assertion =
        request.headers.get("cf-access-jwt-assertion") ??
        request.headers
          .get("cookie")
          ?.match(/(?:^|;\s*)CF_Authorization=([^;]+)/)?.[1] ??
        "";
      const reject = (why: string) => {
        // The caller gets one message; the reason stays in the log rather than telling a prober
        // which part of their token was wrong.
        console.warn(`access: rejected an assertion (${why})`);
        return new Problem(401, "Cloudflare Access did not authenticate this request.");
      };
      if (!assertion) throw reject("absent");
      const parts = assertion.split(".");
      if (parts.length !== 3) throw reject("malformed");
      const [head, body, signature] = parts as [string, string, string];

      let header: { alg?: string; kid?: string };
      let claims: Record<string, unknown>;
      try {
        header = b64urlJson(head) as { alg?: string; kid?: string };
        claims = b64urlJson(body);
      } catch {
        throw reject("undecodable");
      }
      if (header.alg !== "RS256") throw reject("unexpected algorithm");
      if (!header.kid) throw reject("no key id");

      const keys = await options.keys(header.kid);
      const key = keys.get(header.kid);
      if (!key) throw reject("unknown key id");
      const verified = await crypto.subtle.verify(
        { name: "RSASSA-PKCS1-v1_5" },
        key,
        b64urlBytes(signature),
        new TextEncoder().encode(`${head}.${body}`),
      );
      if (!verified) throw reject("bad signature");

      if (claims["iss"] !== `https://${options.teamDomain}`) throw reject("issuer");
      const audience = claims["aud"];
      const audiences = Array.isArray(audience) ? audience : [audience];
      if (!audiences.includes(options.audience)) throw reject("audience");
      const now = Math.floor(Date.now() / 1000);
      const exp = Number(claims["exp"]);
      if (!Number.isFinite(exp) || exp + skew <= now) throw reject("expired");
      const nbf = Number(claims["nbf"]);
      if (Number.isFinite(nbf) && nbf - skew > now) throw reject("not yet valid");

      // A service token has no email; common_name identifies it instead.
      const actor =
        (claims["email"] as string) ||
        (claims["common_name"] as string) ||
        (claims["sub"] as string) ||
        "unknown";
      return { actor, via: "cloudflare-access" };
    },
  };
}
