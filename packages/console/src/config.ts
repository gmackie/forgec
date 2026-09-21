import { OciRegistry } from "./oci.js";
export interface Config {
  ADMIN_TOKEN?: string;
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
): Promise<OciRegistry | null> {
  if (!config.OCI_URL) return null;
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
  return new OciRegistry({
    url: config.OCI_URL,
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
export const securityHeaders = {
  "Content-Security-Policy":
    "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
};
export function secure(response: Response): Response {
  const copy = new Response(response.body, response);
  for (const [key, value] of Object.entries(securityHeaders))
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
