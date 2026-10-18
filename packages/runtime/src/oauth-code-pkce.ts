/**
 * Registered OAuth 2.0 public-client Authorization Code + PKCE (RFC 7636),
 * resource indicators (RFC 8707) and issuer response validation (RFC 9207).
 *
 * Explicitly NOT an authorization server, OAuth discovery trust bootstrap, or
 * a token validator. This host-side helper returns tokens ONLY to trusted code.
 */
export interface OAuthPkcePending {
  readonly state:string;
  readonly verifier:string;
  /** Independently authenticated, opaque browser-session binding. */
  readonly sessionBinding:string;
  readonly resource:string;
  readonly scopes:readonly string[];
  readonly issuer:string;
  readonly redirectUri:string;
  readonly expiresAt:number;
}
export interface OAuthPkcePendingStore {
  /** Must durably and uniquely write (no overwrite). Encrypt verifier at rest. */
  readonly put:(entry:OAuthPkcePending)=>Promise<void>;
  /** Must atomically consume a state at most once across replicas. */
  readonly take:(state:string)=>Promise<OAuthPkcePending|null>;
}
export interface OAuthPkceConfig {
  readonly issuer:string;
  readonly clientId:string;
  readonly authorizationEndpoint:string;
  readonly tokenEndpoint:string;
  readonly redirectUri:string;
  readonly resource:string;
  readonly allowedScopes:readonly string[];
  readonly store:OAuthPkcePendingStore;
  readonly fetcher?:typeof fetch;
  readonly now?:()=>number;
  readonly ttlMs?:number;
  readonly timeoutMs?:number;
  /** Strict RFC 9207 default; disable only with a dedicated per-AS redirect URI. */
  readonly requireIssuerParameter?:boolean;
}
export interface OAuthPkceStart {readonly url:string;readonly state:string;}
export interface OAuthPkceToken {
  readonly accessToken:string;
  readonly tokenType:"Bearer";
  readonly resource:string;
  readonly issuer:string;
  readonly scopes:readonly string[];
  readonly expiresAt:number;
}
const scopeRx=/^[\x21\x23-\x5B\x5D-\x7E]{1,128}$/;
const invalid=(message:string):never=>{throw new Error("OAuth PKCE: "+message);};
const tokenString=(v:unknown):v is string=>
  typeof v==="string" && v.length>0 && v.length<=16384 && /^[A-Za-z0-9._~+\/-]+=*$/.test(v);
const canonicalHttps=(value:string,label:string):URL=>{
  let u:URL;try{u=new URL(value);}catch{return invalid(label+" must be a valid URL");}
  if(u.protocol!=="https:" || u.username || u.password || u.hash ||
     (value!==u.href && value!==u.origin)) invalid(label+" must be canonical HTTPS");
  return u;
};
const b64url=(data:Uint8Array)=>{
  let raw="";for(const byte of data) raw+=String.fromCharCode(byte);
  return btoa(raw).replace(/\+/g,"-").replace(/\//g,"_").replace(/=+$/,"");
};
const randomSecret=()=>{
  const data=new Uint8Array(32);crypto.getRandomValues(data);return b64url(data);
};
const permittedScopes=(requested:readonly string[],allowed:readonly string[])=>{
  if(!Array.isArray(requested) || !requested.length || requested.length>32 ||
     requested.some(s=>typeof s!=="string" || !scopeRx.test(s) || !allowed.includes(s)) ||
     new Set(requested).size!==requested.length) invalid("scope request exceeds client registration");
  return [...requested];
};
async function boundedJson(res:Response):Promise<Record<string,unknown>> {
  const responseBody=res.body;
  if(res.status!==200 || res.redirected ||
     !/^application\/json(?:\s*;|$)/i.test(res.headers.get("content-type")??"") ||
     Number(res.headers.get("content-length")??0)>32768 || !responseBody) invalid("token response unavailable");
  const reader=responseBody!.getReader(),chunks:Uint8Array[]=[];let length=0;
  try{
    for(;;){
      const part=await reader.read();if(part.done)break;
      length+=part.value.byteLength;
      if(length>32768) invalid("token response too large");
      chunks.push(part.value);
    }
  }finally{await reader.cancel().catch(()=>undefined);reader.releaseLock();}
  const bytes=new Uint8Array(length);let offset=0;
  for(const part of chunks){bytes.set(part,offset);offset+=part.byteLength;}
  let value:unknown;
  try{value=JSON.parse(new TextDecoder("utf-8",{fatal:true}).decode(bytes));}catch{invalid("invalid token response JSON");}
  if(!value || typeof value!=="object" || Array.isArray(value)) invalid("invalid token response object");
  return value as Record<string,unknown>;
}

export function oauthPkceClient(config:OAuthPkceConfig) {
  const issuer=canonicalHttps(config.issuer,"issuer"),
    endpoint=canonicalHttps(config.authorizationEndpoint,"authorization endpoint"),
    tokenEndpoint=canonicalHttps(config.tokenEndpoint,"token endpoint"),
    redirect=canonicalHttps(config.redirectUri,"callback URI"),
    resource=canonicalHttps(config.resource,"resource");
  if(!config.clientId || config.clientId.length>512 || /[\r\n]/.test(config.clientId) ||
     issuer.search || endpoint.search || tokenEndpoint.search || redirect.search ||
     resource.search || !config.store || typeof config.store.put!=="function" ||
     typeof config.store.take!=="function") invalid("invalid registered client configuration");
  if(issuer.origin!==endpoint.origin || issuer.origin!==tokenEndpoint.origin)
    invalid("AS endpoint is not on the trusted issuer origin");
  if(!Array.isArray(config.allowedScopes) || config.allowedScopes.length>256 ||
     config.allowedScopes.some(s=>typeof s!=="string" || !scopeRx.test(s)) ||
     new Set(config.allowedScopes).size!==config.allowedScopes.length)
    invalid("invalid registered client scopes");
  const ttl=config.ttlMs??300_000, timeout=config.timeoutMs??5000;
  if(!Number.isInteger(ttl) || ttl<10_000 || ttl>600_000 ||
     !Number.isInteger(timeout) || timeout<100 || timeout>15000)
    invalid("invalid client security deadlines");
  const now=config.now??Date.now,fetcher=config.fetcher??fetch;
  const requireIssuer=config.requireIssuerParameter!==false;
  return {
    async start(scopes:readonly string[],sessionBinding:string):Promise<OAuthPkceStart> {
      if(typeof sessionBinding!=="string" || !/^[A-Za-z0-9_-]{16,256}$/.test(sessionBinding))
        invalid("trusted browser session binding is required");
      const exact=permittedScopes(scopes,config.allowedScopes);
      const state=randomSecret(),verifier=randomSecret();
      const digest=await crypto.subtle.digest("SHA-256",new TextEncoder().encode(verifier));
      const challenge=b64url(new Uint8Array(digest));
      const startedAt=now();
      if(!Number.isFinite(startedAt)) invalid("invalid issuance clock");
      const entry:OAuthPkcePending={
        state,verifier,sessionBinding,resource:config.resource,issuer:config.issuer,
        redirectUri:config.redirectUri,scopes:exact,expiresAt:startedAt+ttl,
      };
      await config.store.put(entry);
      const url=new URL(endpoint.href);
      url.searchParams.set("response_type","code");
      url.searchParams.set("client_id",config.clientId);
      url.searchParams.set("redirect_uri",config.redirectUri);
      url.searchParams.set("scope",exact.join(" "));
      url.searchParams.set("resource",config.resource);
      url.searchParams.set("state",state);
      url.searchParams.set("code_challenge",challenge);
      url.searchParams.set("code_challenge_method","S256");
      return {url:url.href,state};
    },
    async callback(callbackUrl:string,sessionBinding:string):Promise<OAuthPkceToken> {
      if(typeof sessionBinding!=="string" || !/^[A-Za-z0-9_-]{16,256}$/.test(sessionBinding))
        invalid("trusted browser session binding is required");
      const callback=canonicalHttps(callbackUrl,"callback");
      if(callback.origin!==redirect.origin || callback.pathname!==redirect.pathname ||
         callback.hash) invalid("redirect URI does not match registration");
      const stateValues=callback.searchParams.getAll("state");
      if(stateValues.length!==1 || !/^[A-Za-z0-9_-]{43}$/.test(stateValues[0]!))
        invalid("missing or malformed OAuth state");
      const entry=await config.store.take(stateValues[0]!);
      if(!entry || entry!.sessionBinding!==sessionBinding || entry!.state!==stateValues[0] ||
         entry!.issuer!==config.issuer || entry!.resource!==config.resource ||
         entry!.redirectUri!==config.redirectUri || entry!.expiresAt<=now())
        invalid("expired or replayed OAuth state");
      // State is consumed regardless of success, including error/issuer mismatch.
      const codeValues=callback.searchParams.getAll("code"),
        issuerValues=callback.searchParams.getAll("iss");
      if(callback.searchParams.has("error") ||
         [...callback.searchParams.keys()].some(k=>!["code","state","iss"].includes(k)) ||
         codeValues.length!==1 || !tokenString(codeValues[0]) ||
         issuerValues.length>1 || (requireIssuer && issuerValues.length!==1) ||
         (issuerValues.length===1 && issuerValues[0]!==config.issuer))
        invalid("authorization response rejected (issuer/code/parameters)");
      if(!/^[A-Za-z0-9_-]{43}$/.test(entry!.verifier))
        invalid("invalid pending code verifier");
      const body=new URLSearchParams({
        grant_type:"authorization_code",code:codeValues[0]!,
        redirect_uri:config.redirectUri,client_id:config.clientId,
        code_verifier:entry!.verifier,resource:config.resource,
      });
      let response:Response;
      try {
        response=await fetcher(tokenEndpoint.href,{
          method:"POST",redirect:"manual",signal:AbortSignal.timeout(timeout),
          headers:{"content-type":"application/x-www-form-urlencoded","accept":"application/json"},
          body:body.toString(),cache:"no-store",credentials:"omit",
        });
      } catch {return invalid("authorization code exchange unavailable");}
      if(response.url && response.url!==tokenEndpoint.href)
        invalid("token endpoint changed during exchange");
      const data=await boundedJson(response);
      const accessToken=data.access_token;
      const expiresIn=data.expires_in;
      if(data.token_type!=="Bearer" || !tokenString(accessToken) ||
         typeof expiresIn!=="number" ||
         !Number.isSafeInteger(expiresIn) ||
         expiresIn<=0 || expiresIn>3600 || data.refresh_token!==undefined)
        invalid("unacceptable token response");
      const granted=data.scope===undefined?entry!.scopes:
        typeof data.scope==="string"?data.scope.split(" "):invalid("invalid granted scope");
      if(!Array.isArray(granted) || !granted.length || granted.length>32 ||
         granted.some(s=>typeof s!=="string" || !scopeRx.test(s) || !entry!.scopes.includes(s)) ||
         new Set(granted).size!==granted.length)
        invalid("token granted unrequested scope");
      const instant=now();
      if(!Number.isFinite(instant)) invalid("invalid token clock");
      return {accessToken:accessToken as string,tokenType:"Bearer",resource:config.resource,
        issuer:config.issuer,scopes:[...granted],expiresAt:instant+(expiresIn as number)*1000};
    },
  };
}
