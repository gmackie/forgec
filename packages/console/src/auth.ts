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
