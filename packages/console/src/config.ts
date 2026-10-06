import { OciRegistry } from "./oci.js";
import { R2Oci, type R2Like } from "./r2-oci.js";
import { accessAuth, tokenAuth, type AuthAdapter } from "./auth.js";
import { accessKeys } from "./access-jwks.js";
export interface Config {
  /** Integration credentials, named by INTEGRATIONS_JSON (`INTEGRATION_*`). */
  [integrationSecret: `INTEGRATION_${string}`]: string | undefined;
  RUNTIME_TARGETS_JSON?: string;
  DEPLOYMENT_TARGETS_JSON?: string;
  GIT_PROJECTS_JSON?: string;
  GITHUB_TOKEN?: string;
  /** Forgejo origin for `provider: "forgejo"` Git projects, e.g. https://git.forgegraf.com. */
  FORGEJO_URL?: string;
  FORGEJO_TOKEN?: string;
  /** ForgeGraph origin whose contract registry lists this instance's integrations. */
  FORGEGRAPH_URL?: string;
  /** A ForgeGraph `read`-scope API token. */
  FORGEGRAPH_TOKEN?: string;
  /** Per-app integration settings (base URL, credential, writes); see src/integrations.ts. */
  INTEGRATIONS_JSON?: string;
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
/**
 * Configuration this instance's own settings imply, but which is absent.
 *
 * A health check that cannot fail is not a health check. This deployment reported `ok` on
 * every probe while answering 503 to every authenticated request, because `/healthz` returned
 * a constant and the configuration was only read further down the request path. The two stores
 * involved are easy to confuse — `wrangler secret put` writes Cloudflare's, `fg secret set`
 * writes ForgeGraph's — so "deployed with no secrets" is a routine mistake, not an exotic one.
 *
 * This reports what is *absent*, never whether a present value is valid: an unparseable
 * signing key is a different failure, and claiming to have checked it here would be the same
 * kind of lie. Only names are returned, never values.
 */
export function missingConfiguration(
  config: Config,
  bindings?: { BLOBS?: R2Like },
): string[] {
  const missing: string[] = [];
  if (!config.INSTANCE_AUTHORITY) missing.push("INSTANCE_AUTHORITY");
  if ((config.OCI_BACKEND || "http") === "r2") {
    if (!bindings?.BLOBS) missing.push("BLOBS");
    if (!config.REGISTRY_TOKEN_SECRET) missing.push("REGISTRY_TOKEN_SECRET");
    if (!config.OCI_REPOSITORY) missing.push("OCI_REPOSITORY");
    if (!config.SIGNING_KEY_JWK) missing.push("SIGNING_KEY_JWK");
  }
  if (config.AUTH_MODE === "cloudflare-access") {
    if (!config.ACCESS_TEAM_DOMAIN) missing.push("ACCESS_TEAM_DOMAIN");
    // Without the per-application AUD tag, a token minted for any other application in the
    // same Access team authenticates here.
    if (!config.ACCESS_AUD) missing.push("ACCESS_AUD");
  } else if (!config.ADMIN_TOKEN || config.ADMIN_TOKEN.length < 32)
    missing.push("ADMIN_TOKEN");
  // Each configured Git provider needs its credential; without it every request fails.
  let providers: unknown[] = [];
  try {
    const projects = JSON.parse(config.GIT_PROJECTS_JSON || "[]");
    if (Array.isArray(projects)) providers = projects.map((p) => p?.provider ?? "github");
  } catch {
    // Malformed JSON is invalid, not absent; gitRepositories reports it.
  }
  if (providers.includes("github") && !config.GITHUB_TOKEN) missing.push("GITHUB_TOKEN");
  if (providers.includes("forgejo")) {
    if (!config.FORGEJO_URL) missing.push("FORGEJO_URL");
    if (!config.FORGEJO_TOKEN) missing.push("FORGEJO_TOKEN");
  }
  if (config.FORGEGRAPH_URL && !config.FORGEGRAPH_TOKEN) missing.push("FORGEGRAPH_TOKEN");
  // Credentials named by integrations; a missing one fails every call to that integration.
  try {
    const entries = JSON.parse(config.INTEGRATIONS_JSON || "[]");
    if (Array.isArray(entries))
      for (const entry of entries) {
        const auth = entry?.auth ?? {};
        for (const name of [auth.secret, auth.clientId, auth.clientSecret])
          if (typeof name === "string" && !(config as Record<string, unknown>)[name] && !missing.includes(name))
            missing.push(name);
      }
  } catch {
    // Malformed JSON is invalid, not absent; integrationOverrides reports it.
  }
  return missing;
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
