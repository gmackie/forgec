/**
 * Opt-in publisher for RFC 9727 API catalogs and RFC 9728 OAuth protected-resource metadata.
 * This is a publication contract, NOT a token validator or an authorization grant.
 * In particular, publishing scopes never relaxes the AuthHost or runtime policies.
 */
export interface PublishedService {
  /** API endpoint identifier that the catalog explicitly discloses. */
  endpoint: string;
  /** Absolute URL to a machine-readable description (usually OpenAPI). */
  serviceDesc: string;
  serviceDoc?: string;
  visibility: "public" | "private";
}
export interface PublishedOperation {
  visibility: "public" | "oauth2" | "private";
  /** Required OAuth scope names, used by downstream enforcement integration. */
  scopes: readonly string[];
}
export interface ApiPublicationProfile {
  version: "forge-api-publication/1";
  /** RFC 8707 protected resource identifier, HTTPS and no query/fragment. */
  resource: string;
  /** Pinned OAuth AS issuer identifiers; never discovered from untrusted requests. */
  authorizationServers: readonly string[];
  scopesSupported: readonly string[];
  services: readonly PublishedService[];
  /** Optional mapping keyed by canonical Forge operation ID. Validated against deployed operations. */
  operations?: Readonly<Record<string, PublishedOperation>>;
}
export interface ValidatedApiPublication extends ApiPublicationProfile {
  readonly origin: string;
  readonly metadataPath: string;
}
const scopePattern = /^[\x21\x23-\x5B\x5D-\x7E]{1,128}$/;
const methods = new Set(["GET", "HEAD"]);
function fail(message: string): never { throw new Error("Invalid API publication: " + message); }
function httpsUrl(value: unknown, label: string): URL {
  if (typeof value !== "string" || value.length > 2048) return fail(label + " must be a bounded HTTPS URL");
  let url: URL;
  try { url = new URL(value); } catch { return fail(label + " is not a URL"); }
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash)
    return fail(label + " must be HTTPS with no credentials, query or fragment");
  // Reject normalization that could obscure traversal or origin ownership.
  if (value !== url.href && value !== url.origin) return fail(label + " must use canonical URL spelling");
  return url;
}
function unique<T>(values: readonly T[], label: string): readonly T[] {
  if (new Set(values).size !== values.length) fail(label + " contains duplicates");
  return values;
}
/** Validate and defensively copy an operator-authored publication contract. */
export function validateApiPublication(input: ApiPublicationProfile, knownOperations: ReadonlySet<string> = new Set()): ValidatedApiPublication {
  if (!input || input.version !== "forge-api-publication/1") fail("unsupported version");
  const resource = httpsUrl(input.resource, "resource");
  if (!Array.isArray(input.authorizationServers) || input.authorizationServers.length === 0 || input.authorizationServers.length > 16)
    fail("authorizationServers must have 1–16 pinned issuers");
  const servers = unique(input.authorizationServers.map(s => { httpsUrl(s, "issuer"); return s; }), "authorizationServers");
  if (!Array.isArray(input.scopesSupported) || input.scopesSupported.length > 256 ||
      input.scopesSupported.some(s => typeof s !== "string" || !scopePattern.test(s)))
    fail("invalid OAuth scope names");
  const scopes = unique([...input.scopesSupported], "scopesSupported");
  if (!Array.isArray(input.services) || input.services.length === 0 || input.services.length > 128)
    fail("services must contain 1–128 explicitly reviewed APIs");
  const seen = new Set<string>();
  const services = input.services.map((s) => {
    if (!s || (s.visibility !== "public" && s.visibility !== "private")) fail("service visibility must be explicit");
    httpsUrl(s.endpoint, "service endpoint"); httpsUrl(s.serviceDesc, "service description");
    if (s.serviceDoc !== undefined) httpsUrl(s.serviceDoc, "service docs");
    if (seen.has(s.endpoint)) fail("duplicate catalog endpoint");
    seen.add(s.endpoint);
    return {...s};
  });
  if (!services.some(s => s.visibility === "public"))
    fail("RFC 9727 public catalog needs at least one publishable endpoint");
  const operations: Record<string, PublishedOperation> = Object.create(null);
  for (const [operationId, rule] of Object.entries(input.operations ?? {})) {
    if (operationId.length > 512 || !knownOperations.has(operationId)) fail("unrecognized canonical operation " + operationId);
    if (!rule || !["public", "oauth2", "private"].includes(rule.visibility) || !Array.isArray(rule.scopes))
      fail("invalid security rule for " + operationId);
    if (rule.scopes.some(s => typeof s !== "string" || !scopes.includes(s)) || new Set(rule.scopes).size !== rule.scopes.length)
      fail("operation uses undeclared or duplicate scope");
    if (rule.visibility === "oauth2" && rule.scopes.length === 0) fail("oauth2 operation has no required scopes");
    if (rule.visibility !== "oauth2" && rule.scopes.length > 0) fail("non-oauth2 operation declares required scopes");
    operations[operationId] = {visibility: rule.visibility, scopes: [...rule.scopes]};
  }
  const metadataPath = "/.well-known/oauth-protected-resource" + (resource.pathname === "/" ? "" : resource.pathname);
  return {
    version: "forge-api-publication/1",
    resource: input.resource,
    origin: resource.origin,
    metadataPath,
    authorizationServers: [...servers],
    scopesSupported: [...scopes],
    services,
    operations,
  };
}

/** RFC 9264 Linkset with RFC 9727 membership and RFC 8631 service links. */
export function apiCatalog(profile: ValidatedApiPublication): {linkset: Record<string, unknown>[]} {
  const publicServices = profile.services.filter(s => s.visibility === "public");
  const anchor = profile.origin + "/.well-known/api-catalog";
  const entries: Record<string, unknown>[] = [{
    anchor,
    item: publicServices.map(s => ({href: s.endpoint})),
  }];
  for (const service of publicServices) {
    const entry: Record<string, unknown> = {
      anchor: service.endpoint,
      "service-desc": [{href: service.serviceDesc, type: "application/json"}],
    };
    if (service.serviceDoc) entry["service-doc"] = [{href: service.serviceDoc, type: "text/html"}];
    entries.push(entry);
  }
  return {linkset: entries};
}
export function protectedResourceMetadata(profile: ValidatedApiPublication) {
  return {
    resource: profile.resource,
    authorization_servers: [...profile.authorizationServers],
    bearer_methods_supported: ["header"],
    ...(profile.scopesSupported.length ? {scopes_supported: [...profile.scopesSupported]} : {}),
  };
}
export function resourceMetadataChallenge(profile: ValidatedApiPublication): string {
  return 'Bearer resource_metadata="' + profile.origin + profile.metadataPath + '"';
}

/** Handles only the exact configured, publishable well-known paths. No credential is needed to discover them. */
export function serveApiPublication(req: Request, profile: ValidatedApiPublication): Response | undefined {
  const url = new URL(req.url);
  if (url.origin !== profile.origin) return undefined;
  const catalog = url.pathname === "/.well-known/api-catalog";
  const metadata = url.pathname === profile.metadataPath;
  if (!catalog && !metadata) return undefined;
  if (!methods.has(req.method)) return new Response(null, {status: 405, headers: {allow: "GET, HEAD"}});
  const headers = new Headers({
    "cache-control": "public, max-age=300",
    "x-content-type-options": "nosniff",
    "content-type": catalog
      ? 'application/linkset+json; profile="https://www.rfc-editor.org/info/rfc9727"'
      : "application/json",
  });
  if (catalog) headers.set("link", "<" + profile.origin + "/.well-known/api-catalog>; rel=\"api-catalog\"");
  const body = req.method === "HEAD" ? null : JSON.stringify(catalog ? apiCatalog(profile) : protectedResourceMetadata(profile));
  return new Response(body, {status: 200, headers});
}

/** Stable checksum of the validated metadata for use in external revision pins. */
export async function apiPublicationDigest(profile: ValidatedApiPublication): Promise<string> {
  const {origin, metadataPath, ...contract} = profile;
  const data = new TextEncoder().encode(JSON.stringify(contract));
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", data));
  return [...digest].map(x => x.toString(16).padStart(2, "0")).join("");
}
