// FORG-50: the build service. forgec (forgegraph-wasm) plans units and @forgegraph/units seals the
// Closure Manifest and bundles them with esbuild-wasm, all in this one Worker, from a source
// snapshot: a file map in the request, or a commit in a Cloudflare Artifacts repository.
//
//   POST /v1/builds          build; see README.md "API"
//   GET  /v1/blobs/<digest>  a stored output (plan, manifest or module) when the BLOBS bucket is bound
//   GET  /healthz
import forgecModule from "./forgec.wasm";
import esbuildModule from "./esbuild.wasm";
import * as esbuild from "esbuild-wasm";
import { sealWith } from "../../../packages/units/src/sealer.ts";
import { lockedLibraries, memoryHost } from "../../../packages/units/src/memory.ts";
import { memoryFiles, join, normalize } from "../../../packages/units/src/files.ts";
import { digest, gitBlob, sha256, stableJson } from "../../../packages/units/src/hash.ts";
import { SHARED_LIBRARIES } from "../../../packages/units/src/bundle-core.ts";
import { artifactsSource } from "./artifacts.mjs";

const API = "forge-build/1";
const REQUEST_DOMAIN = "forge:build-request:";
const SOURCE_DOMAIN = "forge:build-source:";
const encoder = new TextEncoder();
const decoder = new TextDecoder();

// forgec: one instance per isolate. The module imports nothing (no WASI, no glue).
const forgec = new WebAssembly.Instance(forgecModule, {});
function callForgec(name, request) {
  const { memory, forgec_alloc, forgec_free } = forgec.exports;
  const input = encoder.encode(JSON.stringify(request));
  const ptr = forgec_alloc(input.length);
  new Uint8Array(memory.buffer, ptr, input.length).set(input);
  const packed = forgec.exports[`forgec_${name}`](ptr, input.length);
  forgec_free(ptr, input.length);
  const outPtr = Number(packed >> 32n);
  const outLen = Number(packed & 0xffffffffn);
  const text = decoder.decode(new Uint8Array(memory.buffer, outPtr, outLen));
  forgec_free(outPtr, outLen);
  return JSON.parse(text);
}

// esbuild-wasm runs Go timers, which Workers allow only inside a request: initialize on first use.
// Its instance is captured on the way through WebAssembly.instantiate, only to report its memory.
let esbuildReady;
let esbuildInstance;
const ensureEsbuild = () => {
  if (esbuildReady) return esbuildReady;
  const instantiate = WebAssembly.instantiate;
  WebAssembly.instantiate = async (module, imports) => {
    const result = await instantiate(module, imports);
    if (module === esbuildModule) esbuildInstance = result.instance ?? result;
    return result;
  };
  return (esbuildReady = esbuild.initialize({ wasmModule: esbuildModule, worker: false }).finally(() => (WebAssembly.instantiate = instantiate)));
};

class BuildError extends Error {
  constructor(status, code, message, extra = {}) {
    super(message);
    Object.assign(this, { status, code, extra });
  }
}

const isHex40 = (s) => typeof s === "string" && /^[0-9a-f]{40}$/.test(s);

/** A snapshot of repository files, filled from the request or fetched on demand from a remote tree. */
class Snapshot {
  constructor(remote) {
    this.remote = remote;
    this.files = new Map();
    this.dirs = new Map();
    this.absent = new Set();
  }
  known(path) {
    return this.files.has(path) || this.dirs.has(path) || this.absent.has(path);
  }
  /** Fetches whatever `paths` are (file, directory, nothing). Returns how many were new. */
  async fetch(paths) {
    if (!this.remote) return 0;
    const fresh = [...new Set(paths.map(normalize))].filter((p) => !this.known(p));
    await Promise.all(fresh.map((p) => this.fetchOne(p)));
    return fresh.length;
  }
  async fetchOne(path) {
    const entry = await this.remote.stat(path);
    if (!entry) return void this.absent.add(path);
    if (entry.type === "blob") return void this.files.set(path, await this.remote.blob(entry.hash));
    await this.fetchDir(path);
  }
  /** Lists a directory and its subdirectories, and fetches the forgec inputs in them (README: "Source"). */
  async fetchDir(dir) {
    const entries = await this.remote.list(dir);
    this.dirs.set(dir, entries.map((e) => [e.name, e.type === "tree"]));
    await Promise.all(
      entries.map(async (e) => {
        const path = join(dir, e.name);
        if (this.known(path)) return;
        if (e.type === "tree") return this.fetchDir(path);
        if (e.name.endsWith(".forge") || e.name === "forge.toml" || e.name === "forge.lock") this.files.set(path, await this.remote.blob(e.hash));
      }),
    );
  }
  /** Every file under `dir`, fetched. */
  async fetchTree(dir) {
    const entry = await this.remote?.stat(dir);
    if (!entry || entry.type !== "tree") return;
    await Promise.all(
      (await this.remote.list(dir)).map(async (e) => {
        const path = join(dir, e.name);
        if (e.type === "tree") await this.fetchTree(path);
        else if (e.type === "blob" && !this.files.has(path)) this.files.set(path, await this.remote.blob(e.hash));
      }),
    );
  }
  forgecInput() {
    const files = {};
    for (const [p, b] of this.files) files[p] = decoder.decode(b);
    return { files, dirs: Object.fromEntries(this.dirs) };
  }
}

function parseRequest(body) {
  if (!body || typeof body !== "object") throw new BuildError(400, "invalid_request", "expected a JSON object");
  const root = typeof body.root === "string" ? normalize(body.root) : null;
  if (!root || root.startsWith("..") || root.startsWith("/")) throw new BuildError(400, "invalid_request", "root must be a repository-relative path");
  const output = body.output ?? "bytes";
  if (output !== "bytes" && output !== "refs") throw new BuildError(400, "invalid_request", "output is bytes or refs");
  const libraries = body.libraries ?? null;
  if (libraries !== null && (typeof libraries !== "object" || Object.values(libraries).some((v) => typeof v !== "string")))
    throw new BuildError(400, "invalid_request", "libraries maps a shared library to its version");
  const source = body.source ?? {};
  if (source.files && typeof source.files === "object") {
    const files = new Map();
    for (const [path, value] of Object.entries(source.files)) {
      if (typeof value !== "string") throw new BuildError(400, "invalid_request", `source.files[${path}] must be a string`);
      const p = normalize(path);
      if (p.startsWith("..") || p.startsWith("/")) throw new BuildError(400, "invalid_request", `source path ${path} leaves the repository`);
      files.set(p, source.encoding === "base64" ? Uint8Array.from(atob(value), (c) => c.charCodeAt(0)) : encoder.encode(value));
    }
    return { root, output, libraries, source: { kind: "files", files } };
  }
  if (source.artifacts && typeof source.artifacts === "object") {
    const { namespace, repo, commit, ref } = source.artifacts;
    if (typeof namespace !== "string" || typeof repo !== "string") throw new BuildError(400, "invalid_request", "source.artifacts needs namespace and repo");
    if (!isHex40(commit) && typeof ref !== "string") throw new BuildError(400, "invalid_request", "source.artifacts needs a 40-hex commit (or a ref, resolved to one)");
    return { root, output, libraries, source: { kind: "artifacts", namespace, repo, commit: isHex40(commit) ? commit : null, ref: ref ?? null } };
  }
  throw new BuildError(400, "invalid_request", "source is {files} or {artifacts}");
}

async function build(request, env, timing) {
  // 1. The source snapshot.
  let snapshot;
  let source;
  let subrequests = 0;
  if (request.source.kind === "files") {
    snapshot = new Snapshot(null);
    for (const [p, b] of request.source.files) snapshot.files.set(p, b);
    const listing = [...snapshot.files].map(([p, b]) => [p, gitBlob(b)]).sort(([a], [b]) => (a < b ? -1 : 1));
    source = { kind: "files", files: listing.length, digest: digest(SOURCE_DOMAIN, listing) };
  } else {
    if (!env.ARTIFACTS_API_TOKEN || !env.ARTIFACTS_ACCOUNT_ID) throw new BuildError(501, "not_configured", "this deployment has no Artifacts credentials");
    const remote = await artifactsSource({
      accountId: env.ARTIFACTS_ACCOUNT_ID,
      token: env.ARTIFACTS_API_TOKEN,
      baseUrl: env.ARTIFACTS_API_BASE,
      ...request.source,
    });
    snapshot = new Snapshot(remote);
    source = { kind: "artifacts", namespace: request.source.namespace, repo: request.source.repo, commit: remote.commit, tree: remote.tree };
    timing.mark("resolve");
    subrequests = () => remote.requests;
  }

  // 2. forgec build --units, fetching what it reports missing until nothing new turns up.
  let planned;
  let rounds = 0;
  let forgecMs = 0;
  let fetchMs = 0;
  for (;;) {
    rounds++;
    const t = performance.now();
    planned = callForgec("build", { root: request.root, ...snapshot.forgecInput(), units: true, artifacts: false });
    forgecMs += performance.now() - t;
    const f = performance.now();
    const fresh = await snapshot.fetch(planned.missing ?? []);
    fetchMs += performance.now() - f;
    if (!fresh) break;
    if (rounds > 32) throw new BuildError(500, "no_convergence", "the source snapshot did not converge in 32 rounds");
  }
  timing.add("forgec", forgecMs);
  if (snapshot.remote) timing.add("fetch-forgec-inputs", fetchMs);
  if (!planned.ok) throw new BuildError(422, "compile_failed", planned.error ?? "forgec build failed", { rendered: planned.rendered ?? "", lock: planned.lock ?? null, missing: planned.missing });
  const planText = planned.files["units/plan.json"];
  const plan = JSON.parse(planText);

  // 3. What sealing reads beyond forgec's inputs: impl/, tsconfig, pnpm-lock.yaml and linked package.json files.
  if (snapshot.remote) {
    const t = performance.now();
    await snapshot.fetchTree(join(request.root, "impl"));
    for (let path = join(request.root, "tsconfig.json"), n = 0; path && n < 8; n++) {
      await snapshot.fetch([path]);
      const bytes = snapshot.files.get(path);
      const ext = bytes && /"extends"\s*:\s*"(\.[^"]+)"/.exec(decoder.decode(bytes))?.[1];
      path = ext ? join(path, "..", ext.endsWith(".json") ? ext : `${ext}.json`) : null;
    }
    timing.add("fetch-seal-inputs", performance.now() - t);
  }
  const tl = performance.now();
  const libraries = request.libraries ?? (await resolveLibraries(snapshot, request.root));
  timing.add("libraries", performance.now() - tl);

  // 4. Seal: bundle every js-module unit, hash, resolve closures.
  const t = performance.now();
  await ensureEsbuild();
  timing.add("esbuild-init", performance.now() - t);
  const t2 = performance.now();
  const host = memoryHost({
    files: memoryFiles(snapshot.files, request.root),
    appRoot: request.root,
    esbuild,
    libraries,
    ensure: snapshot.remote ? (p) => snapshot.fetch([join(request.root, p)]) : undefined,
  });
  let sealed;
  try {
    sealed = await sealWith(plan, host);
  } catch (e) {
    throw new BuildError(422, "seal_failed", String(e?.message ?? e));
  }
  timing.add("seal", performance.now() - t2);

  // 5. The outputs, as native `forgec build --units` + `forge-units` write them under generated/.
  const manifestText = stableJson(sealed.manifest);
  const blobs = new Map();
  const put = (path, bytes) => {
    const d = sha256(bytes);
    blobs.set(d, bytes);
    return [path, { digest: d, bytes: bytes.byteLength }];
  };
  const files = Object.fromEntries([
    put("units/plan.json", encoder.encode(planText)),
    ...Object.entries(planned.files).filter(([p]) => p.startsWith("units/wit/")).map(([p, t]) => put(p, encoder.encode(t))),
    put("units/manifest.json", encoder.encode(manifestText)),
    ...[...sealed.modules].map(([d, bytes]) => put(`units/${sealed.manifest.modules[d].path}`, bytes)),
  ].sort(([a], [b]) => (a < b ? -1 : 1)));
  const closures = sealed.manifest.entryPoints.map((e) => {
    const modules = [...new Set(e.closure.flatMap((h) => Object.values(sealed.manifest.units[h].implementation).filter((v) => typeof v === "string" && sealed.manifest.modules[v])))].sort();
    return { kind: e.kind, id: e.id, root: e.root, closureHash: e.closureHash, units: e.closure, modules, bytes: modules.reduce((n, m) => n + sealed.manifest.modules[m].bytes, 0) };
  });
  const response = {
    api: API,
    ok: true,
    request: digest(REQUEST_DOMAIN, { root: request.root, source: source.kind === "files" ? source.digest : `${source.namespace}/${source.repo}@${source.commit}`, libraries: request.libraries ?? null }),
    source,
    root: request.root,
    package: plan.package,
    libraries,
    plan: files["units/plan.json"].digest,
    manifestHash: sealed.manifest.manifestHash,
    manifest: sealed.manifest,
    files,
    closures,
    warnings: planned.warnings ?? [],
  };
  if (request.output === "bytes") {
    response.blobs = Object.fromEntries([...blobs].sort(([a], [b]) => (a < b ? -1 : 1)).map(([d, b]) => [d, base64(b)]));
  } else {
    if (!env.BLOBS) throw new BuildError(501, "not_configured", "output refs needs the BLOBS bucket; ask for output bytes");
    await Promise.all([...blobs].map(([d, b]) => env.BLOBS.put(d, b)));
  }
  const stats = { rounds, subrequests: typeof subrequests === "function" ? subrequests() : 0, snapshotFiles: snapshot.files.size, forgecMemoryBytes: forgec.exports.memory.buffer.byteLength, esbuildMemoryBytes: esbuildInstance?.exports.mem?.buffer.byteLength ?? null };
  return { response, stats };
}

/** Shared library versions from pnpm-lock.yaml, fetching the lockfile and linked package.json files as asked. */
async function resolveLibraries(snapshot, root) {
  const parts = root.split("/");
  const lockPaths = parts.map((_, i) => join(...parts.slice(0, parts.length - i), "pnpm-lock.yaml")).concat("pnpm-lock.yaml");
  await snapshot.fetch(lockPaths);
  const lockPath = lockPaths.find((p) => snapshot.files.has(p));
  if (!lockPath) throw new BuildError(422, "no_lockfile", `no pnpm-lock.yaml at or above ${root}; pass libraries`);
  const lockDir = lockPath === "pnpm-lock.yaml" ? "." : lockPath.slice(0, -"/pnpm-lock.yaml".length);
  const lock = decoder.decode(snapshot.files.get(lockPath));
  const appInLock = lockDir === "." ? root : root.slice(lockDir.length + 1);
  for (let i = 0; i < 4; i++) {
    const asked = [];
    try {
      return lockedLibraries(lock, appInLock, SHARED_LIBRARIES, (p) => {
        const repo = join(lockDir, p);
        const bytes = snapshot.files.get(repo);
        if (!bytes) asked.push(repo);
        return bytes;
      });
    } catch (e) {
      if (!(await snapshot.fetch(asked))) throw new BuildError(422, "no_library", String(e.message));
    }
  }
  throw new BuildError(422, "no_library", "shared libraries did not resolve");
}

function base64(bytes) {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

function timer() {
  const marks = [];
  const start = performance.now();
  let last = start;
  return {
    mark(name) {
      const now = performance.now();
      marks.push([name, now - last]);
      last = now;
    },
    add(name, ms) {
      marks.push([name, ms]);
    },
    header() {
      marks.push(["total", performance.now() - start]);
      return marks.map(([n, ms]) => `${n};dur=${ms.toFixed(1)}`).join(", ");
    },
  };
}

const json = (value, status = 200, headers = {}) =>
  new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json", ...headers } });

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (url.pathname === "/healthz") return json({ ok: true, api: API });
    if (env.BUILD_TOKEN && req.headers.get("authorization") !== `Bearer ${env.BUILD_TOKEN}`) return json({ ok: false, code: "unauthorized" }, 401);
    const blob = /^\/v1\/blobs\/(sha256:[0-9a-f]{64})$/.exec(url.pathname);
    if (blob && req.method === "GET") {
      const object = await env.BLOBS?.get(blob[1]);
      if (!object) return json({ ok: false, code: "not_found" }, 404);
      return new Response(object.body, { headers: { "content-type": "application/octet-stream", etag: `"${blob[1]}"`, "cache-control": "public, max-age=31536000, immutable" } });
    }
    if (url.pathname !== "/v1/builds" || req.method !== "POST") return json({ ok: false, code: "not_found", error: "POST /v1/builds" }, 404);
    const timing = timer();
    try {
      const request = parseRequest(await req.json().catch(() => null));
      timing.mark("parse");
      const { response, stats } = await build(request, env, timing);
      return json(response, 200, {
        "server-timing": timing.header(),
        etag: `"${response.manifestHash}"`,
        "x-forge-build-stats": JSON.stringify(stats),
      });
    } catch (e) {
      if (e instanceof BuildError) return json({ api: API, ok: false, code: e.code, error: e.message, ...e.extra }, e.status, { "server-timing": timing.header() });
      return json({ api: API, ok: false, code: "internal", error: String(e?.stack ?? e) }, 500);
    }
  },
};
