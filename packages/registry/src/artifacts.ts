/**
 * Immutable artifact publication and resolution (FORGE-057; PAR-124/125).
 *
 * Layout follows OCI: content-addressed blobs (`sha256:<hex>`), a manifest
 * blob naming the layers (bundle, ir, contracts, openapi) with provenance,
 * and mutable tags (`name` + `version` -> manifest digest) that are pointers,
 * never authority. A lock names digests; `pullLocked` uses the digest and
 * fails when it is not available rather than following the tag. Every pull
 * re-verifies the manifest digest, every layer digest, the Ed25519 signature
 * against the trust policy for this authority, and the IR schema (unknown
 * critical features fail closed) before anything is returned for activation.
 * Path/workspace dependencies bypass the registry and are never signed by it.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { KNOWN_FEATURES, DOMAIN_IR_VERSION, type AppBundle } from "@forge/runtime";

export interface Signer { keyId: string; privateKey: CryptoKey; publicKey: JsonWebKey }
export interface TrustPolicy { authority: string; signers: Record<string, JsonWebKey> }
export interface Provenance { builder: string; commit: string; built_at: string; owner?: string; dependencies?: { name: string; version: string; hash?: string }[] }
export interface Manifest {
  version: "manifest/1";
  authority: string;
  name: string;
  packageVersion: string;
  layers: Record<string, string>;
  provenance: Provenance;
  audience?: string[];
}
export interface Signature { keyId: string; authority: string; signature: string }
export interface Published { digest: string; layers: Record<string, string>; manifest: Manifest }
export interface Pulled { digest: string; manifest: Manifest; bundle: AppBundle; source: "registry" | "path" }
export interface LockedDependency { name: string; version: string; hash: string; path?: string }

export function canonical(v: unknown): string {
  return JSON.stringify(sortKeys(v));
}
function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v as object).sort()) out[k] = sortKeys((v as Record<string, unknown>)[k]);
    return out;
  }
  return v;
}
export function digestOf(text: string): string {
  return `sha256:${createHash("sha256").update(text).digest("hex")}`;
}

// ---------------------------------------------------------------- signing
export async function generateSigner(keyId: string): Promise<Signer> {
  const pair = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"])) as CryptoKeyPair;
  const publicKey = await crypto.subtle.exportKey("jwk", pair.publicKey);
  return { keyId, privateKey: pair.privateKey, publicKey };
}
export async function signBytes(signer: Signer, text: string): Promise<string> {
  const sig = await crypto.subtle.sign({ name: "Ed25519" }, signer.privateKey, new TextEncoder().encode(text));
  return Buffer.from(sig).toString("base64url");
}
export async function verifyBytes(jwk: JsonWebKey, signature: string, text: string): Promise<boolean> {
  try {
    const key = await crypto.subtle.importKey("jwk", jwk, { name: "Ed25519" }, false, ["verify"]);
    return await crypto.subtle.verify({ name: "Ed25519" }, key, Buffer.from(signature, "base64url"), new TextEncoder().encode(text));
  } catch {
    return false;
  }
}
/** Bytes a manifest signature covers: authority-bound so a signature cannot be replayed under another registry. */
export const signedMaterial = (authority: string, digest: string) => `forge-manifest\n${authority}\n${digest}`;

// ------------------------------------------------------------------ stores
export interface ArtifactStore {
  putBlob(digest: string, text: string): Promise<void>;
  getBlob(digest: string): Promise<string | null>;
  putSignature(digest: string, sig: Signature): Promise<void>;
  getSignature(digest: string): Promise<Signature | null>;
  setTag(name: string, version: string, digest: string): Promise<void>;
  getTag(name: string, version: string): Promise<string | null>;
  listTags(): Promise<{ name: string; version: string; digest: string }[]>;
}

export class MemoryArtifactStore implements ArtifactStore {
  blobs = new Map<string, string>();
  signatures = new Map<string, Signature>();
  tags = new Map<string, string>();
  async putBlob(d: string, t: string) { this.blobs.set(d, t); }
  async getBlob(d: string) { return this.blobs.get(d) ?? null; }
  async putSignature(d: string, s: Signature) { this.signatures.set(d, s); }
  async getSignature(d: string) { return this.signatures.get(d) ?? null; }
  async setTag(n: string, v: string, d: string) { this.tags.set(`${n}@${v}`, d); }
  async getTag(n: string, v: string) { return this.tags.get(`${n}@${v}`) ?? null; }
  async listTags() { return [...this.tags].map(([k, digest]) => { const i = k.lastIndexOf("@"); return { name: k.slice(0, i), version: k.slice(i + 1), digest }; }).sort((a, b) => `${a.name}@${a.version}`.localeCompare(`${b.name}@${b.version}`)); }
}

/** `blobs/sha256/<hex>`, `signatures/<hex>.json`, `tags/<name>/<version>`; doubles as the offline cache. */
export class FileArtifactStore implements ArtifactStore {
  constructor(readonly root: string) {
    mkdirSync(join(root, "blobs", "sha256"), { recursive: true });
    mkdirSync(join(root, "signatures"), { recursive: true });
    mkdirSync(join(root, "tags"), { recursive: true });
  }
  private blobPath(d: string) { return join(this.root, "blobs", "sha256", d.replace(/^sha256:/, "")); }
  private tagDir(name: string) { return join(this.root, "tags", encodeURIComponent(name)); }
  async putBlob(d: string, t: string) { writeFileSync(this.blobPath(d), t); }
  async getBlob(d: string) { const p = this.blobPath(d); return existsSync(p) ? readFileSync(p, "utf8") : null; }
  async putSignature(d: string, s: Signature) { writeFileSync(join(this.root, "signatures", `${d.replace(/^sha256:/, "")}.json`), canonical(s)); }
  async getSignature(d: string) { const p = join(this.root, "signatures", `${d.replace(/^sha256:/, "")}.json`); return existsSync(p) ? (JSON.parse(readFileSync(p, "utf8")) as Signature) : null; }
  async setTag(n: string, v: string, d: string) { mkdirSync(this.tagDir(n), { recursive: true }); writeFileSync(join(this.tagDir(n), encodeURIComponent(v)), d); }
  async getTag(n: string, v: string) { const p = join(this.tagDir(n), encodeURIComponent(v)); return existsSync(p) ? readFileSync(p, "utf8").trim() : null; }
  async listTags() {
    const out: { name: string; version: string; digest: string }[] = [];
    for (const n of readdirSync(join(this.root, "tags"))) for (const v of readdirSync(join(this.root, "tags", n))) out.push({ name: decodeURIComponent(n), version: decodeURIComponent(v), digest: readFileSync(join(this.root, "tags", n, v), "utf8").trim() });
    return out.sort((a, b) => `${a.name}@${a.version}`.localeCompare(`${b.name}@${b.version}`));
  }
}

// ---------------------------------------------------------------- registry
export interface PublishRequest { name: string; version: string; bundle: AppBundle; provenance: Provenance; signer: Signer; audience?: string[]; retag?: boolean }

export class Registry {
  readonly authority: string;
  readonly store: ArtifactStore;
  readonly trust: TrustPolicy;
  constructor(o: { authority: string; store: ArtifactStore; trust: TrustPolicy }) {
    this.authority = o.authority;
    this.store = o.store;
    this.trust = o.trust;
  }

  /** Allowlisted layers only: bundle (for activation), and IR/contracts/OpenAPI for distribution. Never `impl/`. */
  static layersOf(bundle: AppBundle): Record<string, string> {
    return {
      bundle: canonical(bundle),
      ir: canonical(bundle.ir),
      contracts: canonical(bundle.contracts),
      openapi: canonical(bundle.openapi ?? {}),
    };
  }

  async publish(r: PublishRequest): Promise<Published> {
    const layerText = Registry.layersOf(r.bundle);
    const layers: Record<string, string> = {};
    for (const [k, text] of Object.entries(layerText)) {
      const d = digestOf(text);
      layers[k] = d;
      await this.store.putBlob(d, text);
    }
    const manifest: Manifest = { version: "manifest/1", authority: this.authority, name: r.name, packageVersion: r.version, layers, provenance: r.provenance, ...(r.audience ? { audience: r.audience } : {}) };
    const text = canonical(manifest);
    const digest = digestOf(text);
    const existing = await this.store.getTag(r.name, r.version);
    if (existing && existing !== digest && !r.retag) throw new Error(`${r.name}@${r.version} is already published as ${existing}; versions are immutable (pass retag to re-point the tag explicitly)`);
    await this.store.putBlob(digest, text);
    await this.store.putSignature(digest, { keyId: r.signer.keyId, authority: this.authority, signature: await signBytes(r.signer, signedMaterial(this.authority, digest)) });
    await this.store.setTag(r.name, r.version, digest);
    return { digest, layers, manifest };
  }

  /** Verified pull by digest. Throws before returning anything on any verification failure. */
  async pull(digest: string): Promise<Pulled> {
    const text = await this.store.getBlob(digest);
    if (text === null) throw new Error(`artifact ${digest} is not available in this store`);
    if (digestOf(text) !== digest) throw new Error(`manifest digest mismatch for ${digest}`);
    const manifest = JSON.parse(text) as Manifest;
    if (manifest.version !== "manifest/1") throw new Error(`unknown manifest version ${String(manifest.version)}`);
    if (manifest.authority !== this.authority) throw new Error(`manifest was published under authority ${manifest.authority}, this registry is ${this.authority}`);
    const sig = await this.store.getSignature(digest);
    if (!sig) throw new Error(`artifact ${digest} carries no signature`);
    const jwk = this.trust.signers[sig.keyId];
    if (!jwk) throw new Error(`signer ${sig.keyId} is not trusted by ${this.authority}`);
    if (sig.authority !== this.authority || !(await verifyBytes(jwk, sig.signature, signedMaterial(this.authority, digest)))) throw new Error(`signature on ${digest} does not verify for authority ${this.authority}`);
    const blobs: Record<string, string> = {};
    for (const [k, d] of Object.entries(manifest.layers)) {
      const b = await this.store.getBlob(d);
      if (b === null) throw new Error(`layer ${k} (${d}) is missing`);
      if (digestOf(b) !== d) throw new Error(`layer ${k} digest mismatch (${d})`);
      blobs[k] = b;
    }
    const bundle = JSON.parse(blobs["bundle"]!) as AppBundle;
    Registry.checkSchema(bundle);
    return { digest, manifest, bundle, source: "registry" };
  }

  /** Schema gate shared with the runtime: an artifact this toolchain cannot interpret is never activated. */
  static checkSchema(bundle: AppBundle): void {
    if (bundle.version !== "app-bundle/1") throw new Error(`unknown bundle version ${String(bundle.version)}`);
    if (bundle.ir?.version !== DOMAIN_IR_VERSION) throw new Error(`unknown IR version ${String(bundle.ir?.version)}`);
    const unknown = (bundle.ir.requires ?? []).find((f) => !KNOWN_FEATURES.includes(f));
    if (unknown) throw new Error(`artifact requires unknown critical feature ${unknown}; refusing to activate it`);
  }

  async resolveTag(name: string, version: string): Promise<Pulled> {
    const digest = await this.store.getTag(name, version);
    if (!digest) throw new Error(`${name}@${version} is not published on ${this.authority}`);
    return this.pull(digest);
  }

  /** Locked resolution: the digest is the identity. A moved tag is irrelevant; a missing digest is an error. */
  async pullLocked(dep: LockedDependency): Promise<Pulled> {
    if (dep.path) {
      const bundle = JSON.parse(readFileSync(dep.path, "utf8")) as AppBundle;
      Registry.checkSchema(bundle);
      return { digest: dep.hash, manifest: { version: "manifest/1", authority: "path", name: dep.name, packageVersion: dep.version, layers: {}, provenance: { builder: "workspace", commit: "", built_at: "" } }, bundle, source: "path" };
    }
    if ((await this.store.getBlob(dep.hash)) === null) throw new Error(`locked digest ${dep.hash} for ${dep.name}@${dep.version} is not available on ${this.authority}; the tag is not a substitute`);
    const pulled = await this.pull(dep.hash);
    if (pulled.manifest.name !== dep.name || pulled.manifest.packageVersion !== dep.version) throw new Error(`locked digest ${dep.hash} names ${pulled.manifest.name}@${pulled.manifest.packageVersion}, not ${dep.name}@${dep.version}`);
    return pulled;
  }
}
