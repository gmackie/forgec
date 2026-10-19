/**
 * Reviewed public OpenAPI projection.
 *
 * A raw app bundle is never a public API document: it can include private
 * operations, unused internal schemas and generated x- metadata. This
 * projector starts with only explicitly approved OAuth/public operations
 * and copies only their transitively referenced local components.
 */
import type {ValidatedApiPublication, PublishedOperation} from "./api-publication.js";
import {projectOpenApiOAuthSecurity,type OAuthServerPublication} from "./api-openapi-security.js";

const METHODS=new Set(["get","put","post","delete","patch","head","options","trace"]);
const COMPONENT_GROUPS=new Set(["schemas","parameters","requestBodies","responses","headers"]);
const DISALLOWED_FIELDS=new Set(["example","examples","default","externalDocs","callbacks","webhooks","links"]);
const fatal=(reason:string):never=>{throw new Error("Unsafe public OpenAPI projection: "+reason);};
const isObject=(x:unknown):x is Record<string,unknown> =>
  x!==null&&typeof x==="object"&&!Array.isArray(x);
function sanitize(value:unknown,depth=0,counter:{count:number}={count:0}):unknown {
  if(++counter.count>30000 || depth>40)return fatal("input exceeds structural budget");
  if(Array.isArray(value))return value.map(x=>sanitize(x,depth+1,counter));
  if(!isObject(value))return value;
  const clean:Record<string,unknown>=Object.create(null);
  for(const [key,entry] of Object.entries(value)) {
    if(["__proto__","constructor","prototype"].includes(key))return fatal("unsafe key");
    if(key.startsWith("x-")||DISALLOWED_FIELDS.has(key))continue;
    if(key==="$dynamicRef"||key==="$recursiveRef")return fatal("unsupported dynamic reference");
    clean[key]=sanitize(entry,depth+1,counter);
  }
  return clean;
}
function refComponent(ref:string):[string,string] {
  if(!ref.startsWith("#/components/"))return fatal("external or unresolved reference");
  const parts=ref.slice("#/components/".length).split("/");
  if(parts.length!==2 || !COMPONENT_GROUPS.has(parts[0]!))return fatal("unsupported component reference");
  const name=parts[1]!.replace(/~1/g,"/").replace(/~0/g,"~");
  if(!name||name.length>256)return fatal("invalid referenced component");
  return [parts[0]!,name];
}
function refsIn(value:unknown,found:Set<string>,depth=0):void {
  if(depth>40)return fatal("reference graph is too deep");
  if(Array.isArray(value)){for(const x of value)refsIn(x,found,depth+1);return;}
  if(!isObject(value))return;
  const ref=value["$ref"];
  if(ref!==undefined) {
    if(typeof ref!=="string")return fatal("non-string reference");
    const [group,name]=refComponent(ref);
    found.add(group+":"+name);
  }
  for(const child of Object.values(value))refsIn(child,found,depth+1);
}
export function projectReviewedPublicOpenApi(
  source:unknown,publication:ValidatedApiPublication,oauth:OAuthServerPublication,
):Record<string,unknown> {
  if(!isObject(source)||typeof source.openapi!=="string" ||
     !/^3\.1\.\d+$/.test(source.openapi)||!isObject(source.paths)||
     !isObject(source.components)||!isObject(source.components.schemas))
    return fatal("requires an OpenAPI 3.1 document with component schemas");
  const raw=JSON.stringify(source);
  if(!raw||raw.length>4_194_304)return fatal("source exceeds byte budget");
  const original=JSON.parse(raw) as Record<string,unknown>;
  const paths=original.paths as Record<string,unknown>;
  const components=original.components as Record<string,unknown>;
  const published=publication.operations??{};
  const included=new Set<string>();
  const rules:Record<string,PublishedOperation>=Object.create(null);
  const selectedPaths:Record<string,unknown>=Object.create(null);
  for(const [path,item] of Object.entries(paths)) {
    if(!path.startsWith("/")||!isObject(item))return fatal("invalid path item");
    const selected:Record<string,unknown>=Object.create(null);
    for(const [method,operation] of Object.entries(item)) {
      if(!METHODS.has(method))continue;
      if(!isObject(operation)||typeof operation.operationId!=="string")
        return fatal("missing operation identifier");
      const id=operation.operationId;
      const rule=published[id];
      if(!rule || rule.visibility==="private")continue;
      if(included.has(id))return fatal("duplicate reviewed operation");
      if(operation.security!==undefined)return fatal("unreviewed operation security");
      included.add(id);
      rules[id]={visibility:rule.visibility,scopes:[...rule.scopes]};
      // Drop entire unreviewed PathItem metadata, vendor extensions and
      // examples. The reviewed operation keeps only its functional contract.
      const allowed:Record<string,unknown>={operationId:id};
      for(const key of ["summary","description","deprecated","parameters","requestBody","responses"]) {
        if(operation[key]!==undefined)allowed[key]=operation[key];
      }
      if(!allowed.responses)return fatal("public operation has no response");
      selected[method]=sanitize(allowed);
    }
    if(Object.keys(selected).length)selectedPaths[path]=selected;
  }
  if(!included.size)return fatal("publication has no public operations");
  for(const [id,rule] of Object.entries(published)) {
    if(rule.visibility!=="private" && !included.has(id))
      return fatal("reviewed public operation missing from source");
  }

  const requestedRefs=new Set<string>();
  refsIn(selectedPaths,requestedRefs);
  const outputGroups:Record<string,Record<string,unknown>>=Object.create(null);
  const visited=new Set<string>();
  while(requestedRefs.size) {
    if(visited.size>1024)return fatal("too many referenced components");
    const next=requestedRefs.values().next().value as string;
    requestedRefs.delete(next);
    if(visited.has(next))continue;
    visited.add(next);
    const delimiter=next.indexOf(":");
    const group=next.slice(0,delimiter),name=next.slice(delimiter+1);
    const sourceGroup=components[group];
    if(!isObject(sourceGroup)||!Object.hasOwn(sourceGroup,name))
      return fatal("missing referenced component");
    const cleaned=sanitize(sourceGroup[name]);
    const targetGroup=outputGroups[group]??Object.create(null) as Record<string,unknown>;
    targetGroup[name]=cleaned;
    outputGroups[group]=targetGroup;
    const children=new Set<string>();
    refsIn(cleaned,children);
    for(const child of children)if(!visited.has(child))requestedRefs.add(child);
  }
  const requiredScopes=[...new Set(Object.values(rules).flatMap(rule=>rule.scopes))].sort();
  const subset:ValidatedApiPublication={
    ...publication,operations:rules,scopesSupported:requiredScopes,
  };
  const selectedDescriptions:Record<string,string>={};
  for(const [scope,description] of Object.entries(oauth.scopeDescriptions??{}))
    if(requiredScopes.includes(scope))selectedDescriptions[scope]=description;
  const output={
    openapi:original.openapi,
    info:{title:"Published API",version:"1.0.0"},
    servers:[{url:publication.origin}],
    paths:selectedPaths,
    components:{schemas:{},...outputGroups},
  };
  return projectOpenApiOAuthSecurity(output,subset,{
    ...oauth,scopeDescriptions:selectedDescriptions,
  });
}
