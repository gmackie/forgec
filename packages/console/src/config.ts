import { OciRegistry } from "./oci.js";
import { R2Oci, type R2Like } from "./r2-oci.js";
import { accessAuth, tokenAuth, type AuthAdapter } from "./auth.js";
import { accessKeys } from "./access-jwks.js";
export interface Config {
  RUNTIME_TARGETS_JSON?: string;
  DEPLOYMENT_TARGETS_JSON?: string;
  GIT_PROJECTS_JSON?: string;
  GITHUB_TOKEN?: string;
  ADMIN_TOKEN?: string;
  /** "token" (default) or "cloudflare-access". */
  AUTH_MODE?: string;
  ACCESS_TEAM_DOMAIN?: string;
  ACCESS_AUD?: string;
  /** "http" (default) or "r2". */
  OCI_BACKEND?: string;
  REGISTRY_TOKEN_SECRET?: string;
  INSTANCE_NAME?: string;
  INSTANCE_AUTHORITY?: string;
  OCI_URL?: string;
  OCI_REPOSITORY?: string;
  OCI_AUTHORIZATION?: string;
  OCI_ALLOW_HTTP?: string;
  OCI_BLOB_HOSTS?: string;
  SIGNING_KEY_JWK?: string;
  SIGNING_KEY_ID?: string;
}
export async function registryFrom(
  config: Config,
  bindings?: { BLOBS?: R2Like },
): Promise<OciRegistry | null> {
  const backendMode = config.OCI_BACKEND || "http";
  // Unchanged default: no OCI_URL means the registry half is simply not configured.
  if (backendMode === "http" && !config.OCI_URL) return null;
  if (backendMode === "r2" && !bindings?.BLOBS)
    throw new Error(
      "OCI_BACKEND=r2 requires an R2 bucket binding named BLOBS, which only Cloudflare Workers provides.",
    );
  if (
    !config.INSTANCE_AUTHORITY ||
    !config.OCI_REPOSITORY ||
    !config.SIGNING_KEY_JWK
  )
    throw new Error(
      "OCI requires INSTANCE_AUTHORITY, OCI_REPOSITORY and SIGNING_KEY_JWK.",
    );
  const jwk = portableSigningJwk(
    JSON.parse(config.SIGNING_KEY_JWK) as JsonWebKey,
  );
  if (jwk.kty !== "OKP" || jwk.crv !== "Ed25519" || !jwk.d || !jwk.x)
    throw new Error("SIGNING_KEY_JWK must be a private Ed25519 JWK.");
  const privateKey = await crypto.subtle.importKey(
    "jwk",
    jwk,
    { name: "Ed25519" },
    false,
    ["sign"],
  );
  const { d: _private, ...publicKey } = jwk;
  publicKey.key_ops = ["verify"];
  if (backendMode === "r2")
    return new OciRegistry({
      backend: new R2Oci({
        bucket: bindings!.BLOBS!,
        repository: config.OCI_REPOSITORY,
        url: `https://${config.INSTANCE_AUTHORITY}`,
      }),
      repository: config.OCI_REPOSITORY,
      authority: config.INSTANCE_AUTHORITY,
      signer: {
        keyId: config.SIGNING_KEY_ID || "instance-v1",
        privateKey,
        publicKey,
      },
    });
  return new OciRegistry({
    // Non-null: the http branch returned early above when this was unset.
    url: config.OCI_URL!,
    repository: config.OCI_REPOSITORY,
    authority: config.INSTANCE_AUTHORITY,
    signer: {
      keyId: config.SIGNING_KEY_ID || "instance-v1",
      privateKey,
      publicKey,
    },
    ...(config.OCI_AUTHORIZATION
      ? { authorization: config.OCI_AUTHORIZATION }
      : {}),
    allowHttp: config.OCI_ALLOW_HTTP === "true",
    blobHosts: (config.OCI_BLOB_HOSTS || "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  });
}
const BASE_CSP =
  "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'";

/**
 * Security headers for this instance.
 *
 * `connect-src 'self'` is right for a self-contained instance, and stays the default. Under
 * Cloudflare Access it is not sufficient: when the session cookie expires mid-use, a `fetch`
 * to this origin is answered with a redirect to the team's login domain, and CSP is enforced
 * against every hop of a redirect chain. Without widening this, that fetch fails with an
 * opaque network error rather than re-authenticating — and only after a session expires, so it
 * survives any amount of manual testing.
 */
export function securityHeadersFor(config: Config = {}): Record<string, string> {
  const team =
    config.AUTH_MODE === "cloudflare-access" && config.ACCESS_TEAM_DOMAIN
      ? `https://${config.ACCESS_TEAM_DOMAIN}`
      : null;
  return {
    "Content-Security-Policy": team
      ? BASE_CSP.replace("connect-src 'self'", `connect-src 'self' ${team}`).replace(
          "form-action 'self'",
          `form-action 'self' ${team}`,
        )
      : BASE_CSP,
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
  };
}
export const securityHeaders = securityHeadersFor();
export function secure(response: Response, config?: Config): Response {
  const copy = new Response(response.body, response);
  for (const [key, value] of Object.entries(
    config ? securityHeadersFor(config) : securityHeaders,
  ))
    copy.headers.set(key, value);
  return copy;
}

/** Ed25519 is selected explicitly at import. Node exports alg=Ed25519 while workerd expects EdDSA. */
export function portableSigningJwk(input: JsonWebKey): JsonWebKey {
  const { alg, ...jwk } = input;
  if (alg !== undefined && alg !== "Ed25519" && alg !== "EdDSA")
    throw new Error("Unsupported signing key algorithm.");
  return jwk;
}

/**
 * The authenticator this instance is configured for.
 *
 * Defaults to the shared administrator token, so an existing deployment keeps working with no
 * configuration change. Access mode fails fast and loudly when half-configured: silently
 * falling back to token auth would leave an instance the operator believes is behind SSO
 * accepting a bearer token instead.
 */
export function authFrom(config: Config): AuthAdapter {
  if ((config.AUTH_MODE || "token") !== "cloudflare-access")
    return tokenAuth(config.ADMIN_TOKEN || "");
  if (!config.ACCESS_TEAM_DOMAIN || !config.ACCESS_AUD)
    throw new Error(
      "AUTH_MODE=cloudflare-access requires ACCESS_TEAM_DOMAIN and ACCESS_AUD (the application's AUD tag; without it a token for any other application in the team would be accepted).",
    );
  const teamDomain = config.ACCESS_TEAM_DOMAIN;
  return accessAuth({
    teamDomain,
    audience: config.ACCESS_AUD,
    keys: (kid) => accessKeys(teamDomain, { kid }),
  });
}
