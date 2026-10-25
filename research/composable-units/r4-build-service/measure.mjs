// Measures the build service and checks its outputs against native `forgec build --units` +
// `forge-units`. Writes results/<name>.json (default results/local.json).
// usage: node measure.mjs <url> <native-generated-dir> <runs> [results-name]
// env: COMMIT (the Artifacts commit to build), ARTIFACTS_NAMESPACE/ARTIFACTS_REPO, WORKERD_PID (local RSS/CPU),
//      BUILD_SERVICE_TOKEN (deployed), HOST (label), FAKE_ARTIFACTS (url of fake-artifacts.mjs, for its request count)
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { gzipSync } from "node:zlib";
import { acmeRequest } from "./request.mjs";

const [url, nativeDir, runsArg, name = "local"] = process.argv.slice(2);
if (!url || !nativeDir) throw new Error("usage: node measure.mjs <url> <native-generated-dir> <runs> [results-name]");
const runs = Number(runsArg ?? 10);
const here = import.meta.dirname;
const env = process.env;
const auth = env.BUILD_SERVICE_TOKEN ? { authorization: `Bearer ${env.BUILD_SERVICE_TOKEN}` } : {};
const sha = (b) => `sha256:${createHash("sha256").update(b).digest("hex")}`;
const stats = (xs) => {
  const s = [...xs].filter((x) => typeof x === "number").sort((a, b) => a - b);
  if (!s.length) return null;
  const q = (p) => s[Math.min(s.length - 1, Math.floor(p * s.length))];
  return { n: s.length, min: s[0], median: q(0.5), p90: q(0.9), max: s.at(-1) };
};
const round = (x) => +x.toFixed(1);

// workerd's own accounting, locally: process RSS and cumulative CPU time (ps), sampled around requests.
function proc() {
  if (!env.WORKERD_PID) return null;
  const [rss, time] = execFileSync("ps", ["-o", "rss=,time=", "-p", env.WORKERD_PID], { encoding: "utf8" }).trim().split(/\s+/);
  const [m, s] = time.split(":");
  return { rssBytes: Number(rss) * 1024, cpuMs: (Number(m) * 60 + Number(s)) * 1000 };
}

async function post(body) {
  const before = proc();
  const t = performance.now();
  const res = await fetch(`${url}/v1/builds`, { method: "POST", headers: { "content-type": "application/json", ...auth }, body });
  const text = await res.text();
  const wall = performance.now() - t;
  const after = proc();
  const timing = Object.fromEntries((res.headers.get("server-timing") ?? "").split(", ").filter(Boolean).map((p) => [p.split(";")[0], Number(p.split("dur=")[1])]));
  return {
    status: res.status,
    text,
    json: JSON.parse(text),
    clientWallMs: round(wall),
    timing,
    stats: JSON.parse(res.headers.get("x-forge-build-stats") ?? "null"),
    workerdCpuMs: before && after ? round(after.cpuMs - before.cpuMs) : null,
    workerdRssBytes: after?.rssBytes ?? null,
  };
}

async function series(label, body) {
  const first = await post(body);
  if (first.status !== 200) throw new Error(`${label}: ${first.status} ${first.text.slice(0, 2000)}`);
  const warm = [];
  for (let i = 0; i < runs; i++) warm.push(await post(body));
  const bad = warm.find((w) => w.status !== 200);
  if (bad) throw new Error(`${label}: ${bad.status} ${bad.text.slice(0, 2000)}`);
  const sample = (r) => ({ clientWallMs: r.clientWallMs, serverTiming: r.timing, stats: r.stats, workerdCpuMs: r.workerdCpuMs });
  const keys = [...new Set(warm.flatMap((w) => Object.keys(w.timing)))];
  return {
    first: sample(first),
    warm: {
      clientWallMs: stats(warm.map((w) => w.clientWallMs)),
      serverTimingMs: Object.fromEntries(keys.map((k) => [k, stats(warm.map((w) => w.timing[k]))])),
      workerdCpuMs: stats(warm.map((w) => w.workerdCpuMs)),
    },
    stats: warm.at(-1).stats,
    requestBytes: body.length,
    responseBytes: first.text.length,
    responseGzipBytes: gzipSync(first.text).length,
    deterministic: new Set([first.text, ...warm.map((w) => w.text)].map(sha)).size === 1,
    responseDigest: sha(first.text),
    last: warm.at(-1).json,
    rss: warm.map((w) => w.workerdRssBytes),
  };
}

// The native reference: every file under <native>/units.
const nativeFiles = {};
const walk = (dir) => {
  for (const n of readdirSync(dir)) {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) walk(p);
    else nativeFiles[relative(nativeDir, p)] = readFileSync(p);
  }
};
walk(join(nativeDir, "units"));

function parity(response) {
  const blobs = response.blobs ?? {};
  const paths = [...new Set([...Object.keys(nativeFiles), ...Object.keys(response.files)])].sort();
  const files = paths.map((path) => {
    const native = nativeFiles[path];
    const ref = response.files[path];
    const bytes = ref && blobs[ref.digest] ? Buffer.from(blobs[ref.digest], "base64") : undefined;
    return {
      path,
      nativeBytes: native?.length ?? null,
      serviceBytes: bytes?.length ?? null,
      digest: ref?.digest ?? null,
      identical: !!native && !!bytes && native.equals(bytes) && sha(bytes) === ref.digest,
    };
  });
  return { identical: files.every((f) => f.identical), files: files.length, mismatched: files.filter((f) => !f.identical), byFile: files };
}

const startRss = proc();
const results = { issue: "FORG-50", host: env.HOST ?? "wrangler dev --local (workerd), loopback HTTP", measuredAt: new Date().toISOString(), runsPerSeries: runs, url: url.replace(/\/\/[^/]*@/, "//"), commit: env.COMMIT ?? null };
results.workerdBefore = startRss;

// 1. File map.
const fileBody = JSON.stringify(acmeRequest());
const files = await series("files", fileBody);
const allRss = [...files.rss];
results.fileMap = { ...files, last: undefined, rss: undefined, parity: parity(files.last) };

// 2. Cloudflare Artifacts (the local fake, or the real API when deployed with credentials).
if (env.COMMIT) {
  const body = JSON.stringify({ root: "examples/acme", source: { artifacts: { namespace: env.ARTIFACTS_NAMESPACE ?? "forge-lab", repo: env.ARTIFACTS_REPO ?? "forgec", commit: env.COMMIT } } });
  const before = env.FAKE_ARTIFACTS ? (await (await fetch(`${env.FAKE_ARTIFACTS}/stats`)).json()).result.requests : null;
  const art = await series("artifacts", body);
  allRss.push(...art.rss);
  const after = env.FAKE_ARTIFACTS ? (await (await fetch(`${env.FAKE_ARTIFACTS}/stats`)).json()).result.requests : null;
  results.artifacts = {
    ...art,
    last: undefined,
    rss: undefined,
    fakeRequestsPerBuild: before !== null ? (after - before) / (runs + 1) : null,
    parity: parity(art.last),
    sameManifestAsFileMap: art.last.manifestHash === files.last.manifestHash,
    sameOutputsAsFileMap: JSON.stringify(art.last.files) === JSON.stringify(files.last.files),
  };
}

// 3. refs output: blobs stored in R2 and fetched back by digest.
{
  const r = await post(JSON.stringify(acmeRequest({ output: "refs" })));
  const check = [];
  if (r.status === 200)
    for (const [path, ref] of Object.entries(r.json.files)) {
      const res = await fetch(`${url}/v1/blobs/${ref.digest}`, { headers: auth });
      const bytes = Buffer.from(await res.arrayBuffer());
      check.push({ path, status: res.status, identical: !!nativeFiles[path]?.equals(bytes) });
    }
  results.refs = { status: r.status, blobsInline: "blobs" in r.json, fetched: check.length, identical: check.length > 0 && check.every((c) => c.identical), error: r.status === 200 ? null : r.json };
}

// 4. Failures answer with the compiler's diagnostics, not a 500.
{
  const broken = acmeRequest();
  broken.source.files["examples/acme/src/orders/order.forge"] += "\nresource Broken {\n";
  const r = await post(JSON.stringify(broken));
  const stale = acmeRequest();
  stale.source.files["examples/acme/impl/submit-order.ts"] = "export const nope = 1;\n";
  const s = await post(JSON.stringify(stale));
  const bad = await post(JSON.stringify({ root: "../etc", source: { files: {} } }));
  results.errors = {
    compileError: { status: r.status, code: r.json.code, renderedStartsWith: String(r.json.rendered ?? "").split("\n")[0] },
    missingImplementation: { status: s.status, code: s.json.code, error: s.json.error },
    invalidRequest: { status: bad.status, code: bad.json.code, error: bad.json.error },
  };
}

results.workerdAfter = proc();
results.workerdMaxRssBytes = env.WORKERD_PID ? Math.max(...[startRss.rssBytes, ...allRss].filter(Boolean)) : null;
results.manifestHash = files.last.manifestHash;
results.outputs = {
  files: Object.keys(files.last.files).length,
  modules: Object.keys(files.last.manifest.modules).length,
  bytesByKind: Object.entries(files.last.files).reduce((acc, [p, f]) => {
    const k = p.endsWith("plan.json") ? "plan" : p.endsWith("manifest.json") ? "manifest" : p.includes("/wit/") ? "wit" : "modules";
    acc[k] = (acc[k] ?? 0) + f.bytes;
    return acc;
  }, {}),
  closures: files.last.closures.length,
  closureBytes: stats(files.last.closures.map((c) => c.bytes)),
};
writeFileSync(join(here, "results", `${name}.json`), JSON.stringify(results, null, 2) + "\n");
console.log(JSON.stringify({ fileMap: results.fileMap.parity.identical, artifacts: results.artifacts?.parity.identical ?? null, refs: results.refs.identical, manifestHash: results.manifestHash, warm: results.fileMap.warm.serverTimingMs.total }, null, 2));
