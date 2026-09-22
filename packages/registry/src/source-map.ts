/** Verified operator metadata. Never a source of runtime authority. */
import { createHash } from "node:crypto";
import type { AppBundle } from "@forgegraph/runtime";
export interface SourceMap {
  version: "forge-source-map/1";
  package: string;
  buildHash: string;
  compilerVersion: string;
  revision?: string;
  sources: Record<string, { digest: string; byteLength: number }>;
  anchors: Record<string, { file: string; start: number; end: number }>;
  derivations: Record<string, { kind: string; from: string }[]>;
}
const object=(v:unknown):v is Record<string,unknown>=>!!v&&typeof v==="object"&&!Array.isArray(v);
const exact=(v:Record<string,unknown>,keys:string[])=>Object.keys(v).every(k=>keys.includes(k));
const text=(v:unknown,max=1000):v is string=>typeof v==="string"&&v.length>0&&v.length<=max;
const integer=(v:unknown):v is number=>typeof v==="number"&&Number.isSafeInteger(v)&&v>=0;
export function verifySourceMap(value:unknown,bundle:AppBundle,commit?:string):SourceMap {
  const fail=():never=>{throw Error("Invalid or mismatched Forge source map");};
  if(!object(value)||!exact(value,["version","package","buildHash","compilerVersion","revision","sources","anchors","derivations"]))return fail();
  if(value["version"]!=="forge-source-map/1"||value["package"]!==bundle.ir.package.name||value["buildHash"]!==bundle.buildHash||!text(value["compilerVersion"],100))return fail();
  if(value["revision"]!==undefined&&(!text(value["revision"],200)||(commit!==undefined&&value["revision"]!==commit)))return fail();
  const sources=value["sources"],anchors=value["anchors"],derivations=value["derivations"];
  if(!object(sources)||!object(anchors)||!object(derivations)||Object.keys(sources).length>10000||Object.keys(anchors).length>100000||Object.keys(derivations).length>100000)return fail();
  for(const [path,source]of Object.entries(sources)) {
    if(!text(path)||path.startsWith('/')||path.includes('\\')||path.includes(':')||path.split('/').some(p=>!p||p==='.'||p==='..'))return fail();
    if(!object(source)||!exact(source,["digest","byteLength"])||typeof source["digest"]!=="string"||!/^sha256:[a-f0-9]{64}$/.test(source["digest"])||!integer(source["byteLength"]))return fail();
  }
  for(const [anchor,span]of Object.entries(anchors)) {
    if(!text(anchor,2000)||!object(span)||!exact(span,["file","start","end"])||typeof span["file"]!=="string"||!Object.hasOwn(sources,span["file"]))return fail();
    const source=sources[span["file"]] as {byteLength:number};
    if(!integer(span["start"])||!integer(span["end"])||span["end"]<span["start"]||span["end"]>source.byteLength)return fail();
  }
  for(const [anchor,edges]of Object.entries(derivations)) {
    if(!text(anchor,2000)||!Array.isArray(edges)||edges.length>100)return fail();
    for(const edge of edges)if(!object(edge)||!exact(edge,["kind","from"])||!text(edge["kind"],100)||!text(edge["from"],2000))return fail();
  }
  return value as unknown as SourceMap;
}
/** Resolve compatibility subjects (`Resource.field`) or direct semantic anchors. */
export function sourceFor(map:SourceMap,subject:string) {
  if(Object.hasOwn(map.anchors,subject))return map.anchors[subject];
  const dot=subject.lastIndexOf('.');
  if(dot>subject.lastIndexOf('/'))return map.anchors[subject.slice(0,dot)+'#field:'+subject.slice(dot+1)];
  return undefined;
}

/** Check checked-out UTF-8 bytes before navigating; a matching path alone is insufficient. */
export function verifySourceBytes(map: SourceMap, path: string, bytes: Uint8Array): boolean {
  const source = Object.hasOwn(map.sources, path) ? map.sources[path] : undefined;
  return !!source && source.byteLength === bytes.byteLength && source.digest === `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}
