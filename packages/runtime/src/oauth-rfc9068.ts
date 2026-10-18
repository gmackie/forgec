/**
 * Strict RFC 9068 JWT access-token AuthHost, for opt-in Forge OAuth publication.
 *
 * This adapter verifies a pinned AS signature and token profile and then
 * obtains the tenant/actor from an independently configured principal mapper.
 * It does not interpret roles, tenant memberships, or client-provided claims
 * as permission and does not implement DPoP or delegation.
 */
import type {AuthHost, Principal} from "./http.js";
import {err, type ForgeError} from "./errors.js";

export interface Rfc9068VerifiedSubject {
  readonly issuer: string;
  readonly subject: string;
  readonly clientId: string;
  readonly audiences: readonly string[];
  readonly scopes: readonly string[];
  readonly expiresAt: number;
  readonly jwtId: string;
}
export type PinnedPublicJwk = JsonWebKey & {kid:string};
export interface Rfc9068HostOptions {
  /** Exact AS issuer identifier, pre-approved by a trusted operator. */
  readonly issuer: string;
  /** RFC 8707 resource identifier, not OAuth client ID. */
  readonly resource: string;
  readonly algorithm: "RS256" | "ES256";
  /** A pinned, bounded public JWKS; no dynamic fetch from JWT headers. */
  readonly publicKeys: readonly PinnedPublicJwk[];
  readonly allowedClients?: readonly string[];
  readonly maxLifetimeSeconds?: number;
  readonly now?: () => number;
  /**
   * Authoritative PIP/identity bridge: resolves subject/client to tenant/actor.
   * Must fail closed on offboarding, cross-tenant mismatch or unavailable PIP.
   * Called ONLY after signature, issuer, audience, timestamps, scope and
   * client ID have been verified.
   */
  readonly resolvePrincipal: (subject: Rfc9068VerifiedSubject) =>
    Promise<Pick<Principal,"tenant"|"actor"|"workload"|"purposes"> | null>;
}

const b64 = /^[A-Za-z0-9_-]+$/;
const scopeSyntax = /^[\x21\x23-\x5b\x5d-\x7e]{1,128}$/;
const text = (v:unknown, max=512):v is string => typeof v==="string" && v.length>0 && v.length<=max;
const obj = (v:unknown):v is Record<string,unknown> =>
  v!==null && typeof v==="object" && !Array.isArray(v);
const invalid = ():ForgeError => err("Unauthenticated","invalid_token");
const nonLocalHttps = (v:string) => {
  const u=new URL(v);
  if(u.protocol!=="https:" || u.username || u.password || u.search || u.hash ||
     (v!==u.href && v!==u.origin)) throw new Error("issuer/resource must be canonical HTTPS identifiers");
  return u;
};
const decode=(encoded:string):Uint8Array=>{
  if(!b64.test(encoded) || encoded.length>16384) throw new Error("invalid JWS encoding");
  const value=encoded.replace(/-/g,"+").replace(/_/g,"/");
  const raw=atob(value+"=".repeat((4-value.length%4)%4));
  return Uint8Array.from(raw,c=>c.charCodeAt(0));
};
const json=(encoded:string):unknown=>JSON.parse(new TextDecoder("utf-8",{fatal:true}).decode(decode(encoded)));
const keyMaterial=(algorithm:"RS256"|"ES256",jwk:PinnedPublicJwk):boolean=>{
  if(!text(jwk.kid,128) || jwk.d!==undefined || jwk.k!==undefined ||
     (jwk.key_ops && (!Array.isArray(jwk.key_ops) || !jwk.key_ops.includes("verify"))) ||
     (jwk.use!==undefined && jwk.use!=="sig") ||
     (jwk.alg!==undefined && jwk.alg!==algorithm)) return false;
  return algorithm==="RS256"
    ? jwk.kty==="RSA" && text(jwk.n,1024) && text(jwk.e,32)
    : jwk.kty==="EC" && jwk.crv==="P-256" && text(jwk.x,256) && text(jwk.y,256);
};
const algorithmImport=(alg:"RS256"|"ES256")=>alg==="RS256"
  ? {name:"RSASSA-PKCS1-v1_5",hash:"SHA-256"} as RsaHashedImportParams
  : {name:"ECDSA",namedCurve:"P-256"} as EcKeyImportParams;
const algorithmVerify=(alg:"RS256"|"ES256")=>alg==="RS256"
  ? {name:"RSASSA-PKCS1-v1_5"} as Algorithm
  : {name:"ECDSA",hash:"SHA-256"} as EcdsaParams;

/** Opt-in host; never automatically replaces the existing dev or generic JWT adapter. */
export function rfc9068AuthHost(options:Rfc9068HostOptions):AuthHost {
  nonLocalHttps(options.issuer);
  nonLocalHttps(options.resource);
  const lifetime=options.maxLifetimeSeconds??900;
  if(!Number.isInteger(lifetime) || lifetime<1 || lifetime>86400 ||
     !Array.isArray(options.publicKeys) || !options.publicKeys.length ||
     options.publicKeys.length>32 || typeof options.resolvePrincipal!=="function") {
    throw new Error("invalid RFC 9068 host configuration");
  }
  if(options.allowedClients!==undefined &&
     (!Array.isArray(options.allowedClients) || options.allowedClients.length>256 ||
      options.allowedClients.some(c=>!text(c,512)))) throw new Error("invalid OAuth client allowlist");
  const publicKeys=new Map<string,PinnedPublicJwk>();
  const imported=new Map<string,Promise<CryptoKey>>();
  for(const jwk of options.publicKeys) {
    if(!keyMaterial(options.algorithm,jwk) || publicKeys.has(jwk.kid!))
      throw new Error("invalid or duplicate pinned RFC 9068 public key");
    publicKeys.set(jwk.kid!,{...jwk});
  }
  const now=options.now??Date.now;
  return {
    scheme:"bearer-rfc9068",
    async authenticate(req:Request):Promise<Principal|ForgeError>{
      if(req.headers.has("cf-access-jwt-assertion") || req.headers.has("cf-access-client-id") ||
         req.headers.has("cf-access-client-secret")) return invalid();
      const auth=req.headers.get("authorization");
      const match=auth && /^Bearer ([A-Za-z0-9_.-]+)$/i.exec(auth);
      if(!match || match[1]!.length>16384) return invalid();
      const parts=match[1]!.split(".");
      if(parts.length!==3 || parts.some(x=>!b64.test(x))) return invalid();
      try {
        const protectedHeader=json(parts[0]!);
        const payload=json(parts[1]!);
        if(!obj(protectedHeader) || !obj(payload) ||
           protectedHeader.alg!==options.algorithm ||
           !["at+jwt","application/at+jwt"].includes(String(protectedHeader.typ).toLowerCase()) ||
           !text(protectedHeader.kid,128) || protectedHeader.crit!==undefined ||
           protectedHeader.jwk!==undefined || protectedHeader.jku!==undefined ||
           protectedHeader.x5u!==undefined || protectedHeader.x5c!==undefined ||
           protectedHeader.b64!==undefined) return invalid();
        const selectedKey=publicKeys.get(protectedHeader.kid);
        if(!selectedKey) return invalid();
        // Lazy initialization avoids unhandled asynchronous configuration failures.
        let promise=imported.get(protectedHeader.kid);
        if(!promise) {
          promise=crypto.subtle.importKey("jwk",selectedKey,algorithmImport(options.algorithm),false,["verify"]);
          imported.set(protectedHeader.kid,promise);
        }
        const verified=await crypto.subtle.verify(algorithmVerify(options.algorithm),await promise,
          Uint8Array.from(decode(parts[2]!)),new TextEncoder().encode(parts[0]+"."+parts[1]));
        if(!verified) return invalid();
        if(payload.iss!==options.issuer || !text(payload.sub) || !text(payload.client_id) ||
           !text(payload.jti) || payload.nonce!==undefined ||
           payload.cnf!==undefined || payload.act!==undefined) return invalid();
        if(options.allowedClients && !options.allowedClients.includes(payload.client_id)) return invalid();
        const audiences=typeof payload.aud==="string" ? [payload.aud] : payload.aud;
        if(!Array.isArray(audiences) || audiences.length<1 || audiences.length>32 ||
           audiences.some(x=>!text(x,2048)) || !audiences.includes(options.resource)) return invalid();
        const time=now();
        if(!Number.isFinite(time) || typeof payload.iat!=="number" ||
           typeof payload.exp!=="number" || !Number.isSafeInteger(payload.iat) ||
           !Number.isSafeInteger(payload.exp) || payload.exp<=payload.iat ||
           payload.iat*1000>time+5000 || payload.exp*1000<=time ||
           payload.exp-payload.iat>lifetime ||
           (payload.nbf!==undefined &&
             (typeof payload.nbf!=="number" || !Number.isSafeInteger(payload.nbf) || payload.nbf*1000>time+5000))) return invalid();
        const rawScope=payload.scope??"";
        if(typeof rawScope!=="string" || rawScope.length>8192) return invalid();
        const scopes=rawScope ? rawScope.split(" ") : [];
        if(scopes.length>256 || scopes.some(x=>!scopeSyntax.test(x)) || new Set(scopes).size!==scopes.length)
          return invalid();
        const claims:Rfc9068VerifiedSubject={
          issuer:options.issuer, subject:payload.sub, clientId:payload.client_id,
          audiences:[...audiences], scopes:[...scopes],expiresAt:payload.exp*1000,jwtId:payload.jti,
        };
        const mapped=await options.resolvePrincipal(claims);
        if(!mapped || !text(mapped.tenant,256) || !text(mapped.actor,512) ||
           (mapped.purposes!==undefined &&
             (!Array.isArray(mapped.purposes) || mapped.purposes.some(p=>!text(p,256))))) return invalid();
        if(claims.expiresAt<=now()) return invalid();
        return {
          tenant:mapped.tenant,actor:mapped.actor,issuer:options.issuer,
          ...(mapped.workload?{workload:mapped.workload}:{}),
          ...(mapped.purposes?{purposes:[...mapped.purposes]}:{}),
          verifiedOAuth:{
            tokenType:"access-token",issuer:options.issuer,
            audiences:[...claims.audiences],scopes:[...claims.scopes],
            clientId:claims.clientId,expiresAt:claims.expiresAt,
          },
        };
      } catch {
        return invalid();
      }
    },
  };
}
