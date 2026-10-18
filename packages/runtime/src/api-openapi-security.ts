/**
 * Strict OpenAPI 3.1 security projection from a separately reviewed Forge
 * publication profile. Pure and opt-in: it does not grant OAuth permission
 * or change live HTTP/MCP handling. Do not publish this document unless the
 * downstream AuthHost/PEP enforces the represented security requirements.
 */
import type {ValidatedApiPublication, PublishedOperation} from "./api-publication.js";

const METHODS = new Set(["get","put","post","delete","patch","head","options","trace"]);
export interface OAuthServerPublication {
  /** Pinned RFC 8414 issuer, also declared in the resource publication profile. */
  readonly issuer: string;
  readonly authorizationUrl: string;
  readonly tokenUrl: string;
  readonly scopeDescriptions?: Readonly<Record<string,string>>;
}
function fail(message: string): never {throw new Error("Invalid OAuth OpenAPI projection: " + message);}
function obj(value: unknown): value is Record<string,unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function endpoint(input: unknown, label: string, issuerOrigin: string): string {
  if (typeof input !== "string" || input.length > 2048) return fail(label + " must be a bounded HTTPS URL");
  let url: URL; try {url = new URL(input);} catch{return fail(label + " is not a URL");}
  if (url.protocol !== "https:" || url.username || url.password || url.hash ||
      url.origin !== issuerOrigin || (input !== url.href && input !== url.origin))
    return fail(label + " must be a canonical URL on the pinned issuer origin");
  return input;
}
export function projectOpenApiOAuthSecurity(
  document: unknown,
  publication: ValidatedApiPublication,
  oauth: OAuthServerPublication,
): Record<string, unknown> {
  const issuer = new URL(publication.authorizationServers.includes(oauth.issuer) ? oauth.issuer : fail("unknown issuer"));
  endpoint(oauth.issuer,"issuer",issuer.origin);
  const authorizationUrl = endpoint(oauth.authorizationUrl,"authorization URL",issuer.origin);
  const tokenUrl = endpoint(oauth.tokenUrl,"token URL",issuer.origin);
  const rules = publication.operations ?? {};
  if (!Object.keys(rules).length) return fail("no reviewed operation security rules");
  if (!obj(document) || typeof document.openapi !== "string" || !/^3\.1\.\d+$/.test(document.openapi) ||
      !obj(document.paths) || !obj(document.components))
    return fail("an OpenAPI 3.1 document with paths and components is required");
  // JSON round-trip creates a fresh document and prohibits mutated shared bundle objects.
  const serialized = JSON.stringify(document);
  if (serialized === undefined || serialized.length > 4_194_304) return fail("OpenAPI document is too large");
  const doc = JSON.parse(serialized) as Record<string,unknown>;
  const paths = doc.paths as Record<string,unknown>;
  const components = doc.components as Record<string,unknown>;
  if (!obj(components.schemas)) return fail("component schemas missing");
  const schemes = components.securitySchemes === undefined ? {} : components.securitySchemes;
  if (!obj(schemes) || "forgeOAuth" in schemes) return fail("forgeOAuth scheme name is already in use");

  const descriptions = oauth.scopeDescriptions ?? {};
  if (Object.keys(descriptions).some(s=>!publication.scopesSupported.includes(s))) return fail("unknown scope description");
  if (Object.values(descriptions).some(v=>typeof v !== "string" || v.length > 512)) return fail("invalid scope description");
  const scopeMap: Record<string,string> = Object.create(null);
  for(const scope of publication.scopesSupported) scopeMap[scope] = descriptions[scope] ?? "";
  const matched = new Set<string>();
  for(const [path,item] of Object.entries(paths)) {
    if (!obj(item)) return fail("invalid path item " + path);
    for(const [method,raw] of Object.entries(item)) {
      if (!METHODS.has(method)) continue;
      if (!obj(raw) || typeof raw.operationId !== "string" || !raw.operationId) return fail("missing canonical operationId at " + method + " " + path);
      const operationId = raw.operationId;
      if (matched.has(operationId)) return fail("duplicate operationId " + operationId);
      const requirement: PublishedOperation | undefined = rules[operationId];
      if (!requirement) return fail("unmapped operation " + operationId);
      if (requirement.visibility === "private") return fail("private operation needs an authenticated, private-document projection instead");
      if (raw.security !== undefined) return fail("operation already declares security; review before replacing");
      matched.add(operationId);
      raw.security = requirement.visibility === "public" ? [] : [{forgeOAuth: [...requirement.scopes]}];
    }
  }
  if (matched.size !== Object.keys(rules).length) return fail("security profile references operations not in OpenAPI");
  const nextSchemes = {...schemes, forgeOAuth: {
    type:"oauth2",
    description:"Access tokens must target the published protected resource and satisfy server-side policy.",
    flows:{authorizationCode:{authorizationUrl,tokenUrl,scopes:scopeMap}},
  }};
  components.securitySchemes = nextSchemes;
  return doc;
}
