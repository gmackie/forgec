/**
 * Trust-pinned API/OAuth discovery: RFC 9727, 9264, 8631, 9728 and 8414.
 * Informational only: never turns an issuer or API link into a permission.
 */
export interface DiscoveryTrust {
  readonly origin: string;
  readonly resource: string;
  readonly issuer: string;
  readonly allowedOrigins: readonly string[];
  readonly approvedScopes: readonly string[];
  readonly fetcher?: typeof fetch;
  readonly timeoutMs?: number;
}
export interface ApiServiceLinks {
  readonly endpoint: string;
  readonly descriptions: readonly string[];
  readonly docs: readonly string[];
}
export interface DiscoverySnapshot {
  readonly catalogUrl: string;
  readonly services: readonly ApiServiceLinks[];
  readonly nestedCatalogs: readonly string[];
  readonly oauth: {
    readonly resource: string;
    readonly issuer: string;
    readonly authorizationEndpoint: string;
    readonly tokenEndpoint: string;
    readonly jwksUri?: string;
    readonly supportedScopes: readonly string[];
    readonly pkceS256: true;
  };
}
export class DiscoveryError extends Error {
  constructor(readonly code: string) { super(code); this.name = "DiscoveryError"; }
}
const fail = (code: string): never => { throw new DiscoveryError(code); };
const record = (v: unknown): v is Record<string, unknown> =>
  v!==null && typeof v==="object" && !Array.isArray(v);
function safeUrl(input: unknown, label: string): URL {
  if(typeof input!=="string" || input.length<9 || input.length>2048) return fail(label+":url");
  let parsed: URL;
  try { parsed=new URL(input); } catch { return fail(label+":url"); }
  if(parsed.protocol!=="https:" || parsed.username || parsed.password ||
     parsed.hash || parsed.search || (input!==parsed.href && input!==parsed.origin))
    return fail(label+":not_canonical_https");
  const host=parsed.hostname.toLowerCase();
  if(host==="localhost" || host.endsWith(".localhost") || host.endsWith(".local") ||
     host.endsWith(".internal") || host.includes(":") || /^[0-9.]+$/.test(host))
    return fail(label+":not_public_hostname");
  return parsed;
}
const origin = (v:string):string => {
  const u=safeUrl(v,"origin");
  if(u.pathname!=="/") return fail("origin:not_origin");
  return u.origin;
};
function checkedList(input: unknown, label: string, max: number): string[] {
  if(!Array.isArray(input) || !input.length || input.length>max ||
     input.some(x=>typeof x!=="string" || !x.length || x.length>2048) ||
     new Set(input).size!==input.length) return fail(label+":invalid_list");
  return input as string[];
}
function checkedScopes(input: unknown): string[] {
  if(!Array.isArray(input) || input.length>256 ||
     input.some(x=>typeof x!=="string" ||
       !/^[\x21\x23-\x5B\x5D-\x7E]{1,128}$/.test(x)) ||
     new Set(input).size!==input.length) return fail("invalid_scopes");
  return input as string[];
}
function links(value:unknown,allowed:ReadonlySet<string>):string[] {
  if(!Array.isArray(value) || value.length>128) return fail("invalid_link_relation");
  const out:string[]=[];
  for(const v of value) {
    if(!record(v)) return fail("invalid_link");
    const u=safeUrl(v.href,"link");
    if(!allowed.has(u.origin)) return fail("unreviewed_link_origin");
    out.push(u.href);
  }
  if(new Set(out).size!==out.length) return fail("duplicate_link");
  return out;
}
async function getJson(
  endpoint:string, accept:string, mime:string,fetcher:typeof fetch,
  timeout:number, maxBytes:number
):Promise<unknown> {
  let res:Response;
  try {
    res=await fetcher(endpoint,{
      method:"GET",redirect:"manual",signal:AbortSignal.timeout(timeout),
      headers:{accept},credentials:"omit"
    });
  } catch { return fail("discovery_unavailable"); }
  if(res.status!==200 || res.redirected || (res.url && res.url!==endpoint) ||
     res.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase()!==mime ||
     !res.body) return fail("invalid_discovery_response");
  if(Number(res.headers.get("content-length")??0)>maxBytes)
    return fail("discovery_oversize");
  const stream=res.body!.getReader(),parts:Uint8Array[]=[];
  let length=0;
  try {
    for(;;) {
      const part=await stream.read();
      if(part.done)break;
      length+=part.value.byteLength;
      if(length>maxBytes) return fail("discovery_oversize");
      parts.push(part.value);
    }
  } finally {
    await stream.cancel().catch(()=>undefined);
    stream.releaseLock();
  }
  const data=new Uint8Array(length);let offset=0;
  for(const part of parts){data.set(part,offset);offset+=part.byteLength;}
  try { return JSON.parse(new TextDecoder("utf-8",{fatal:true}).decode(data)); }
  catch {return fail("discovery_bad_json");}
}
function parseCatalog(
  catalogUrl:string, document:unknown, allowed:ReadonlySet<string>
):Pick<DiscoverySnapshot,"services"|"nestedCatalogs"> {
  if(!record(document) || !Array.isArray(document.linkset) ||
     document.linkset.length<1 || document.linkset.length>128)
    return fail("invalid_api_catalog");
  const members=new Set<string>(), desc=new Map<string,Set<string>>(),
    docs=new Map<string,Set<string>>(), nested=new Set<string>();
  for(const entry of document.linkset) {
    if(!record(entry)) return fail("invalid_catalog_entry");
    const anchor=safeUrl(entry.anchor,"anchor");
    if(!allowed.has(anchor.origin)) return fail("unreviewed_catalog_anchor");
    const add=(map:Map<string,Set<string>>,rel:unknown)=>{
      if(rel===undefined)return;
      const entries=links(rel,allowed);
      const set=map.get(anchor.href)??new Set<string>();
      for(const x of entries)set.add(x);
      map.set(anchor.href,set);
    };
    if(entry.item!==undefined)
      for(const href of links(entry.item,allowed))members.add(href);
    add(desc,entry["service-desc"]);
    add(docs,entry["service-doc"]);
    if(entry["api-catalog"]!==undefined)
      for(const href of links(entry["api-catalog"],allowed))nested.add(href);
  }
  for(const anchor of desc.keys()) if(anchor!==catalogUrl)members.add(anchor);
  if(members.size===0||members.size>256) return fail("empty_or_excessive_api_catalog");
  return {
    services:[...members].sort().map(endpoint=>({
      endpoint,descriptions:[...(desc.get(endpoint)??[])].sort(),
      docs:[...(docs.get(endpoint)??[])].sort(),
    })),
    nestedCatalogs:[...nested].sort(),
  };
}
/** Insert the well-known path before an optional resource path, RFC 9728. */
export function protectedResourceUrl(resource:string):string {
  const u=safeUrl(resource,"resource");
  return u.origin+"/.well-known/oauth-protected-resource"+
    (u.pathname==="/"?"":u.pathname);
}
/** Insert before the issuer's path component, RFC 8414. */
export function authorizationServerUrl(issuer:string):string {
  const u=safeUrl(issuer,"issuer");
  return u.origin+"/.well-known/oauth-authorization-server"+
    (u.pathname==="/"?"":u.pathname);
}
export interface PublicCatalogPreview {
  readonly catalogUrl:string;
  readonly services:readonly ApiServiceLinks[];
  readonly nestedCatalogs:readonly string[];
  /** Untrusted links, not approved API operations or OAuth issuers. */
  readonly reviewRequired:true;
}
export interface PublicCatalogPreviewOptions {
  readonly origin:string;
  /** Operator-reviewed cross-origin link targets; defaults to origin only. */
  readonly allowedLinkOrigins?:readonly string[];
  readonly fetcher?:typeof fetch;
  readonly timeoutMs?:number;
}
/**
 * Safe first step for an agent that knows an API origin but no OAuth issuer:
 * read only that origin's public RFC 9727 catalog without credentials.
 *
 * It does NOT fetch service-desc, select issuers, register OAuth clients, or
 * create a policy/source binding. An operator must separately approve the
 * resource and issuer before calling discoverApi or oauthPkceClient.
 */
export async function previewPublicCatalog(
  options:PublicCatalogPreviewOptions
):Promise<PublicCatalogPreview> {
  const root=origin(options.origin);
  const extras=(options.allowedLinkOrigins??[]).map(origin);
  if(extras.length>32||new Set(extras).size!==extras.length)
    return fail("invalid_link_origin_allowlist");
  const allowed=new Set([root,...extras]);
  const timeout=options.timeoutMs??3000;
  if(!Number.isInteger(timeout)||timeout<100||timeout>15000)
    return fail("invalid_timeout");
  const url=root+"/.well-known/api-catalog";
  const result=await getJson(url,"application/linkset+json",
    "application/linkset+json",options.fetcher??fetch,timeout,131072);
  const contents=parseCatalog(url,result,allowed);
  return {catalogUrl:url,...contents,reviewRequired:true};
}

/** Reviewed single-hop discovery; never sends bearer credentials or registers issuers. */
export async function discoverApi(trust:DiscoveryTrust):Promise<DiscoverySnapshot> {
  const apiOrigin=origin(trust.origin);
  const resource=safeUrl(trust.resource,"resource");
  if(resource.origin!==apiOrigin) return fail("resource_origin_mismatch");
  const pinnedIssuer=safeUrl(trust.issuer,"issuer");
  const approvedOrigins=checkedList(trust.allowedOrigins,"allowed_origins",64).map(origin);
  if(!approvedOrigins.includes(apiOrigin) ||
     new Set(approvedOrigins).size!==approvedOrigins.length)
    return fail("invalid_origin_allowlist");
  const allowed=new Set(approvedOrigins);
  checkedScopes(trust.approvedScopes);
  const timeout=trust.timeoutMs??3000;
  if(!Number.isInteger(timeout)||timeout<100||timeout>15000)
    return fail("invalid_timeout");
  const fetcher=trust.fetcher??fetch;
  const catalogUrl=apiOrigin+"/.well-known/api-catalog";
  const rawCatalog=await getJson(catalogUrl,"application/linkset+json",
    "application/linkset+json",fetcher,timeout,131072);
  const catalog=parseCatalog(catalogUrl,rawCatalog,allowed);
  const protectedDoc=await getJson(protectedResourceUrl(trust.resource),
    "application/json","application/json",fetcher,timeout,65536);
  if(!record(protectedDoc) || protectedDoc.resource!==trust.resource)
    return fail("oauth_resource_identifier_mismatch");
  const issuers=checkedList(protectedDoc.authorization_servers,"authorization_servers",16);
  if(!issuers.includes(trust.issuer)) return fail("unapproved_oauth_issuer");
  const supportedScopes=protectedDoc.scopes_supported===undefined?[]:
    checkedScopes(protectedDoc.scopes_supported);
  if(supportedScopes.length &&
     trust.approvedScopes.some(s=>!supportedScopes.includes(s)))
    return fail("requested_scope_not_supported");
  const asDoc=await getJson(authorizationServerUrl(trust.issuer),"application/json",
    "application/json",fetcher,timeout,65536);
  if(!record(asDoc)||asDoc.issuer!==trust.issuer) return fail("oauth_issuer_mismatch");
  const asEndpoint=(value:unknown,name:string):string=>{
    const u=safeUrl(value,name);
    // Narrow security profile: a separate operator-approved adapter is needed
    // for auth/token/JWKS endpoints outside the issuer's origin.
    if(u.origin!==pinnedIssuer.origin) return fail(name+":unapproved_origin");
    return u.href;
  };
  const authorizationEndpoint=asEndpoint(asDoc.authorization_endpoint,"authorization_endpoint");
  const tokenEndpoint=asEndpoint(asDoc.token_endpoint,"token_endpoint");
  if(!Array.isArray(asDoc.response_types_supported) ||
     !asDoc.response_types_supported.includes("code"))
    return fail("authorization_code_not_supported");
  if(asDoc.grant_types_supported!==undefined &&
     (!Array.isArray(asDoc.grant_types_supported)||
      !asDoc.grant_types_supported.includes("authorization_code")))
    return fail("oauth_grant_not_supported");
  if(!Array.isArray(asDoc.code_challenge_methods_supported) ||
     !asDoc.code_challenge_methods_supported.includes("S256"))
    return fail("oauth_pkce_s256_not_supported");
  const jwksUri=asDoc.jwks_uri===undefined?undefined:asEndpoint(asDoc.jwks_uri,"jwks_uri");
  return {
    catalogUrl, services:catalog.services,nestedCatalogs:catalog.nestedCatalogs,
    oauth:{
      resource:trust.resource,issuer:trust.issuer,authorizationEndpoint,tokenEndpoint,
      ...(jwksUri?{jwksUri}:{}),
      supportedScopes,pkceS256:true,
    },
  };
}
