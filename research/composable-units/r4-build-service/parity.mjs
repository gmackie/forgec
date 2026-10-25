// CI check (FORG-50): the build-service Worker, in workerd through Miniflare, writes the bytes that
// native `forgec build --units` + `forge-units` write for examples/acme, from a file map and from
// the Artifacts source (fake-artifacts.mjs over this checkout's HEAD). Exits non-zero otherwise.
// usage: node parity.mjs     env: FORGEC (default target/debug/forgec), FORGEC_WASM (skip cargo in build.mjs)
import { execFileSync, spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { acmeRequest, repoRoot } from "./request.mjs";

const here = import.meta.dirname;
// The Miniflare (and workerd) of the wrangler that run.sh and the deploy use, so the compatibility date matches.
const wrangler = createRequire(join(repoRoot, "packages/runtime/package.json")).resolve("wrangler/package.json");
const { Miniflare, convertV4MiniflareOptions } = createRequire(wrangler)("miniflare");
const native = mkdtempSync(join(tmpdir(), "forge-build-service-"));
const children = [];
let mf;
const cleanup = async () => {
  children.forEach((c) => c.kill());
  await mf?.dispose();
  rmSync(native, { recursive: true, force: true });
};

try {
  const forgec = process.env.FORGEC ?? join(repoRoot, "target/debug/forgec");
  execFileSync(forgec, ["build", "examples/acme", "--units", "--out", native], { cwd: repoRoot, stdio: "inherit" });
  execFileSync(process.execPath, ["packages/units/src/cli.ts", "examples/acme", "--out", join(native, "units")], { cwd: repoRoot, stdio: "inherit" });
  execFileSync(process.execPath, [join(here, "build.mjs")], { stdio: "inherit" });

  const expected = {};
  const walk = (dir) => readdirSync(dir).forEach((n) => (statSync(join(dir, n)).isDirectory() ? walk(join(dir, n)) : (expected[relative(native, join(dir, n))] = readFileSync(join(dir, n)))));
  walk(join(native, "units"));

  const token = randomBytes(8).toString("hex");
  const fake = spawn(process.execPath, [join(here, "fake-artifacts.mjs"), "0", token], { stdio: ["ignore", "pipe", "inherit"] });
  children.push(fake);
  const port = await new Promise((ok, fail) => {
    fake.stdout.on("data", (d) => {
      const m = /ready (\d+)/.exec(String(d));
      if (m) ok(Number(m[1]));
    });
    fake.on("exit", (code) => fail(new Error(`fake-artifacts exited ${code}`)));
  });

  const gen = join(here, "generated");
  mf = new Miniflare(convertV4MiniflareOptions({
    workers: [
      {
        name: "build-service",
        modulesRoot: gen,
        modules: [
          { type: "ESModule", path: join(gen, "worker.mjs") },
          { type: "CompiledWasm", path: join(gen, "forgec.wasm") },
          { type: "CompiledWasm", path: join(gen, "esbuild.wasm") },
        ],
        compatibilityDate: "2026-09-25",
        compatibilityFlags: ["nodejs_compat"],
        r2Buckets: ["BLOBS"],
        bindings: { ARTIFACTS_API_BASE: `http://127.0.0.1:${port}`, ARTIFACTS_API_TOKEN: token, ARTIFACTS_ACCOUNT_ID: "local" },
      },
    ],
  }));

  const commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repoRoot, encoding: "utf8" }).trim();
  const cases = {
    files: acmeRequest(),
    artifacts: { root: "examples/acme", source: { artifacts: { namespace: "ci", repo: "forgec", commit } } },
  };
  const failures = [];
  const manifests = new Set();
  for (const [name, request] of Object.entries(cases)) {
    const res = await mf.dispatchFetch("http://build/v1/builds", { method: "POST", body: JSON.stringify(request) });
    const body = await res.json();
    if (res.status !== 200) {
      failures.push(`${name}: ${res.status} ${JSON.stringify(body).slice(0, 1500)}`);
      continue;
    }
    manifests.add(body.manifestHash);
    const paths = [...new Set([...Object.keys(expected), ...Object.keys(body.files)])].sort();
    for (const path of paths) {
      const ref = body.files[path];
      const got = ref && Buffer.from(body.blobs[ref.digest] ?? "", "base64");
      const ok = expected[path] && got && expected[path].equals(got) && `sha256:${createHash("sha256").update(got).digest("hex")}` === ref.digest;
      if (!ok) failures.push(`${name}: ${path} differs from the native output`);
    }
    console.log(`${name}: ${paths.length} files, manifest ${body.manifestHash}, ${res.headers.get("server-timing")}, ${res.headers.get("x-forge-build-stats")}`);
  }
  if (manifests.size > 1) failures.push(`file map and Artifacts sealed different manifests: ${[...manifests].join(", ")}`);
  if (failures.length) {
    console.error(failures.join("\n"));
    process.exitCode = 1;
  } else console.log(`build service: byte-identical to native forgec + forge-units (${Object.keys(expected).length} files)`);
} finally {
  await cleanup();
}
