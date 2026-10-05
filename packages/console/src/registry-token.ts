/**
 * The Distribution token exchange.
 *
 * `docker login` sends HTTP Basic to the realm advertised in `WWW-Authenticate` and expects a
 * short-lived bearer back. The token is HS256 signed with a secret only this worker holds —
 * symmetric is right here because the same worker both mints and verifies; there is no third
 * party who needs to check it.
 *
 * Tokens are deliberately short-lived so that revoking a credential takes effect promptly: a
 * revoked credential cannot mint a new token, and the old one expires on its own.
 */
import { credentialStore, type CredentialStore } from "./credentials.js";

const TTL_SECONDS = 300;

const b64url = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
const b64urlText = (text: string) => b64url(new TextEncoder().encode(text));
const fromB64url = (s: string) =>
  Uint8Array.from(
    atob(s.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(s.length / 4) * 4, "=")),
    (c) => c.charCodeAt(0),
  );

async function key(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

export interface RegistryClaims {
  sub: string;
  aud: string;
  exp: number;
  scopes: string[];
}

export async function mintRegistryToken(
  secret: string,
  claims: RegistryClaims,
): Promise<string> {
  const head = b64urlText(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const body = b64urlText(JSON.stringify(claims));
  const signature = await crypto.subtle.sign(
    "HMAC",
    await key(secret),
    new TextEncoder().encode(`${head}.${body}`),
  );
  return `${head}.${body}.${b64url(new Uint8Array(signature))}`;
}

export async function verifyRegistryToken(
  secret: string,
  token: string,
  audience: string,
): Promise<RegistryClaims | null> {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [head, body, signature] = parts as [string, string, string];
  // The algorithm is pinned here rather than read from the header: a token is never allowed to
  // nominate how it should be checked.
  let header: { alg?: string };
  try {
    header = JSON.parse(new TextDecoder().decode(fromB64url(head)));
  } catch {
    return null;
  }
  if (header.alg !== "HS256") return null;
  const ok = await crypto.subtle.verify(
    "HMAC",
    await key(secret),
    fromB64url(signature),
    new TextEncoder().encode(`${head}.${body}`),
  );
  if (!ok) return null;
  let claims: RegistryClaims;
  try {
    claims = JSON.parse(new TextDecoder().decode(fromB64url(body)));
  } catch {
    return null;
  }
  if (claims.aud !== audience) return null;
  if (!Number.isFinite(claims.exp) || claims.exp * 1000 <= Date.now()) return null;
  return claims;
}

export interface TokenEndpointOptions {
  store: CredentialStore;
  secret: string;
  service: string;
  repository: string;
}

/** `GET /v2/token` — exchange HTTP Basic credentials for a bearer token. */
export function createTokenEndpoint(options: TokenEndpointOptions) {
  return async function issueToken(request: Request): Promise<Response> {
    const header = request.headers.get("authorization") ?? "";
    const deny = () =>
      new Response(
        JSON.stringify({
          errors: [{ code: "UNAUTHORIZED", message: "Invalid registry credentials." }],
        }),
        {
          status: 401,
          headers: {
            "content-type": "application/json",
            "www-authenticate": `Basic realm="${options.service}"`,
          },
        },
      );
    if (!header.startsWith("Basic ")) return deny();
    let decoded: string;
    try {
      decoded = atob(header.slice(6));
    } catch {
      return deny();
    }
    const split = decoded.indexOf(":");
    if (split < 0) return deny();
    const id = decoded.slice(0, split);
    const secret = decoded.slice(split + 1);

    const credential = await options.store.verify(id, secret);
    if (!credential) return deny();

    // Grant the intersection of what was asked for and what the credential actually holds.
    const requested = new URL(request.url).searchParams.get("scope") ?? "";
    const asked = requested.split(":").pop()?.split(",").filter(Boolean) ?? [];
    const scopes = asked.length
      ? credential.scopes.filter((s) => asked.includes(s))
      : credential.scopes;

    const exp = Math.floor(Date.now() / 1000) + TTL_SECONDS;
    const token = await mintRegistryToken(options.secret, {
      sub: credential.id,
      aud: options.service,
      exp,
      scopes,
    });
    await options.store.touch(credential.id, new Date().toISOString());
    return Response.json({
      token,
      access_token: token,
      expires_in: TTL_SECONDS,
      issued_at: new Date().toISOString(),
    });
  };
}

export { credentialStore };
