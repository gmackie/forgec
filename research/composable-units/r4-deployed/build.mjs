#!/usr/bin/env node
// FORG-38: builds one lab Worker into dist/<target>/ (worker.js + wrangler.jsonc). ForgeGraph's deploy
// agent runs it as each staging target's buildCommand, from this directory, after `pnpm install
// --frozen-lockfile` at the repository root; the target's deployCommand then uploads
// dist/<target>/wrangler.jsonc with the pinned wrangler under the target's workerName.
//
//   node build.mjs <target>          targets: lab/names.mjs WORKERS
//
// forgec: the C targets and the probe need acme's or pricing's sealed units, so they build forgec
// (`cargo build --locked -p forgegraph-cli`) first. On the agent, CARGO_TARGET_DIR points at a cache
// outside the clone, so only the first deploy compiles it. Everything else is the repository's own
// tooling: the units sealer, linker C (which links A and bundles B), and the units harness for JSPI.
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { D1, QUEUE, R2, WORKERS } from "./lab/names.mjs";

const here = import.meta.dirname;
const root = resolve(here, "../../..");
const acme = join(root, "examples/acme");
const pricing = join(root, "examples/pricing");
const require_ = createRequire(join(root, "packages/linker-tiered/package.json"));
const { build } = require_("esbuild");
const target = process.argv[2];
if (!target || !WORKERS[target]) throw new Error(`usage: build.mjs <${Object.keys(WORKERS).join("|")}>`);
const out = join(here, "dist", target);
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

const ACME_VARS = { FORGE_AUTH: "dev-headers", FORGE_CORS: "http://localhost:5173" };
const OBSERVABILITY = { enabled: true, head_sampling_rate: 1 };
const run = (cmd, args, cwd = root) => execFileSync(cmd, args, { cwd, stdio: "inherit", env: process.env });

/**
 * What `pnpm --filter "@forgegraph/linker-tiered^..." run build` does, without pnpm (the agent's is a
 * corepack shim): the dist/ of the runtime and its one workspace dependency (linker A imports the
 * runtime's dist), then B's libraries.
 */
function workspaceDeps() {
  for (const p of ["packages/contracts/capability-manifest", "packages/runtime"]) run("node", [join(root, p, "node_modules/typescript/bin/tsc"), "-p", "tsconfig.build.json"], join(root, p));
  run("node", [join(root, "packages/linker-dynamic/scripts/build-libs.mjs")]);
}

function forgec() {
  const dir = process.env.CARGO_TARGET_DIR ?? join(root, "target");
  run("cargo", ["build", "--locked", "-p", "forgegraph-cli"]);
  return join(dir, "debug/forgec");
}

/** esbuild as linker C bundles its scripts: workspace packages from source, workerd builtins external. */
async function bundle(entry, file, options = {}) {
  const r = await build({
    entryPoints: [entry],
    absWorkingDir: root,
    bundle: true,
    write: false,
    format: "esm",
    platform: "neutral",
    target: "es2022",
    mainFields: ["module", "main"],
    conditions: ["source", "workerd", "worker", "browser", "import"],
    external: ["cloudflare:*", "node:*", ...(options.external ?? [])],
    minify: true,
    legalComments: "none",
    charset: "utf8",
    logLevel: "warning",
    plugins: options.plugins ?? [],
  });
  writeFileSync(join(out, file), r.outputFiles[0].contents);
  return r.outputFiles[0].contents.byteLength;
}

// ForgeGraph's agent writes FG_COMMIT_HASH into the wrangler config it finds in appDir, before the
// build. These configs are written by the build under dist/, so the agent never sees them; without the
// var, the source-order guard refuses every later deploy of the Worker ("serving version ... has no
// immutable FG_COMMIT_HASH"). The build therefore sets it to the commit it built.
const source = { FG_APP: "forge-console", FG_COMMIT_HASH: execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim() };

function writeConfig(config) {
  const vars = { ...(config.vars ?? {}), ...source };
  writeFileSync(join(out, "wrangler.jsonc"), `${JSON.stringify({ name: WORKERS[target], main: "worker.js", observability: OBSERVABILITY, ...config, vars }, null, 2)}\n`);
}

const acmeD1 = { binding: "DB", database_name: D1.acme };
const queueProducer = { producers: [{ binding: "Q_FULFILL_ORDER", queue: QUEUE }] };

// ------------------------------------------------------------------------------------- linker B
if (target === "linker-b") {
  await bundle(join(here, "lab/linker-b.js"), "worker.js");
  writeConfig({
    no_bundle: true,
    compatibility_date: "2026-09-25",
    workers_dev: true,
    worker_loaders: [{ binding: "LOADER" }],
    vars: ACME_VARS,
    r2_buckets: [{ binding: "UNITS", bucket_name: R2.unitsB }],
    d1_databases: [acmeD1],
    queues: queueProducer,
    "//secrets": ["LAB_TOKEN", "LINKER_ADMIN_TOKEN", "CURSOR_SECRET"],
  });
}

// ------------------------------------------------------------------------------- the RPC callee
if (target === "rpc-callee") {
  await bundle(join(here, "lab/rpc-callee.js"), "worker.js");
  writeConfig({ no_bundle: true, compatibility_date: "2026-09-25", workers_dev: false });
}

// ------------------------------------------------------------------------------------- the probe
if (target === "probe") {
  workspaceDeps();
  const bin = forgec();
  const { seal } = await import("../../../packages/units/src/seal.ts");
  const { bindUnit, D1_RESOURCE_HOST, D1_RESOURCE_HOST_SCHEMA } = await import("../../../packages/units/src/harness.ts");
  const planDir = mkdtempSync(join(tmpdir(), "forg38-pricing-"));
  execFileSync(bin, ["build", pricing, "--units", "--out", planDir], { stdio: "pipe" });
  const plan = JSON.parse(readFileSync(join(planDir, "units/plan.json"), "utf8"));
  const sealed = await seal(plan, pricing, { components: { "@acme/pricing/_/PriceCart": "impl/price-cart.wasm", "@acme/pricing/_/QuoteOrder": "impl/quote-order.wasm" } });
  // The dynamic copy's host: the same query as D1_RESOURCE_HOST, through the parent's HarnessDb stub.
  const dynamicHost = D1_RESOURCE_HOST.replace("const row = await env.DB.prepare(\"SELECT body FROM \" + TABLE + \" WHERE resource = ? AND id = ?\").bind(resource, id).first();", "const row = await env.DB.first(\"SELECT body FROM \" + TABLE + \" WHERE resource = ? AND id = ?\", [resource, id]);");
  if (dynamicHost === D1_RESOURCE_HOST) throw new Error("D1_RESOURCE_HOST changed shape; update the dynamic host rewrite");
  const units = {};
  for (const [name, symbol, host] of [["price-cart", "@acme/pricing/_/PriceCart", D1_RESOURCE_HOST], ["quote-order", "@acme/pricing/_/QuoteOrder", undefined]]) {
    const bound = await bindUnit(sealed, symbol, pricing, host ? { host } : {});
    if (bound.kind !== "wasm-component") throw new Error(`${symbol} sealed as ${bound.kind}`);
    mkdirSync(join(out, name), { recursive: true });
    for (const m of bound.modules) writeFileSync(join(out, name, m.path), m.contents);
    const dyn = bound.modules.map((m) => ({ path: m.path, type: m.type, b64: Buffer.from(m.path === "host.js" && host ? dynamicHost : m.contents).toString("base64") }));
    const digest = createHash("sha256").update(JSON.stringify(dyn)).digest("hex").slice(0, 16);
    units[name] = { digest, modules: dyn, bytes: bound.modules.reduce((n, m) => n + m.contents.byteLength, 0) };
  }
  const CATALOG = Array.from({ length: 100 }, (_, i) => ({ id: `p-${i}`, sku: `SKU-${String(i).padStart(4, "0")}`, unitPrice: `${(i * 37) % 500}.${String((i * 13) % 100).padStart(2, "0")}`, active: true }));
  const gen = join(here, "dist/probe-generated");
  mkdirSync(gen, { recursive: true });
  writeFileSync(join(gen, "jspi.js"), `export const JSPI_UNITS = ${JSON.stringify(units)};\nexport const D1_SCHEMA = ${JSON.stringify(D1_RESOURCE_HOST_SCHEMA)};\nexport const CATALOG = ${JSON.stringify(CATALOG)};\nexport const PRODUCT = "@acme/pricing/_/Product";\n`);
  writeFileSync(join(out, "probe.wasm"), Buffer.from("0061736d0100000001060160017f017f020c0104686f7374036765740000030201000707010372756e00010a0b0109002000100041016a0b", "hex"));
  const generated = { name: "probe-generated", setup: (b) => b.onResolve({ filter: /^\.\/generated\/jspi\.js$/ }, () => ({ path: join(gen, "jspi.js") })) };
  await bundle(join(here, "lab/probe.js"), "worker.js", { external: ["./price-cart/caller.js", "./quote-order/caller.js", "./probe.wasm"], plugins: [generated] });
  writeFileSync(join(out, "units.json"), `${JSON.stringify(Object.fromEntries(Object.entries(units).map(([k, v]) => [k, { digest: v.digest, bytes: v.bytes, modules: v.modules.map((m) => m.path) }])), null, 2)}\n`);
  writeConfig({
    no_bundle: true,
    compatibility_date: "2026-09-25",
    workers_dev: true,
    rules: [
      { type: "ESModule", globs: ["**/*.js"] },
      { type: "CompiledWasm", globs: ["**/*.wasm"] },
    ],
    find_additional_modules: true,
    worker_loaders: [{ binding: "LOADER" }],
    d1_databases: [{ binding: "DB", database_name: D1.pricing }],
    services: [{ binding: "CALLEE", service: WORKERS["rpc-callee"] }],
    "//secrets": ["LAB_TOKEN"],
  });
}

// ------------------------------------------------------------------------------------- linker C
// Linker C's link of acme under the lab policy (tiered-policy.lab.json), cut to the scripts the lab
// measures: the router, the tier host, the packed scripts for GET /v1/customers and the two dynamic
// routes' fallbacks, and the dispatch owner. Every script is linker C's output, byte for byte, apart
// from the lab gate around the router and the tier host; only the configs are rewritten: lab names and
// resources, and no Durable Object, Workflows, cron or queue consumer (none of those scripts is
// deployed). The router's other routes therefore have no service binding and answer 500.
if (target.startsWith("c-")) {
  workspaceDeps();
  const bin = forgec();
  run(bin, ["build", ".", "--units"], acme);
  run("node", [join(root, "packages/units/src/cli.ts"), "."], acme);
  const { linkTiered } = await import("../../../packages/linker-tiered/src/link.ts");
  const linked = mkdtempSync(join(tmpdir(), "forg38-tiered-"));
  const policy = JSON.parse(readFileSync(join(here, "tiered-policy.lab.json"), "utf8"));
  const t = await linkTiered({ app: acme, manifestDir: join(acme, "generated/units"), environment: join(acme, "deploy/cloudflare/wrangler.jsonc"), out: linked, policy });
  const row = (method, path) => t.router.table.find((r) => r.method === method && r.path === path).script;
  const lab = {
    [t.router.name]: "c-router",
    [t.host.name]: "c-dynamic",
    [row("GET", "/v1/customers")]: "c-get-customers",
    [row("POST", "/v1/orders")]: "c-post-orders",
    [row("POST", "/v1/orders/{order}/submit")]: "c-submit",
    [t.packed.dispatchOwner]: "c-sweep",
  };
  const original = Object.entries(lab).find(([, v]) => v === target)[0];
  const srcDir = target === "c-router" || target === "c-dynamic" ? join(linked, original) : join(linked, "packed", original);
  const cfg = JSON.parse(readFileSync(join(srcDir, "wrangler.jsonc"), "utf8"));
  const services = (cfg.services ?? []).flatMap((s) => (lab[s.service] ? [{ binding: s.binding, service: WORKERS[lab[s.service]] }] : []));
  const next = { compatibility_date: cfg.compatibility_date, no_bundle: true, workers_dev: target === "c-router" || target === "c-dynamic" };
  if (cfg.worker_loaders) next.worker_loaders = cfg.worker_loaders;
  if (cfg.vars) next.vars = Object.fromEntries(Object.keys(cfg.vars).map((k) => [k, ACME_VARS[k] ?? cfg.vars[k]]));
  const r2 = (cfg.r2_buckets ?? []).filter((b) => b.binding === "UNITS").map((b) => ({ binding: "UNITS", bucket_name: R2.unitsC }));
  if (r2.length) next.r2_buckets = r2;
  if (cfg.d1_databases) next.d1_databases = [acmeD1];
  if (cfg.queues?.producers?.length) next.queues = queueProducer;
  if (services.length) next.services = services;
  const dropped = ["durable_objects", "migrations", "workflows", "triggers"].filter((k) => cfg[k]);
  if (cfg.queues?.consumers) dropped.push("queues.consumers");
  if (cfg.r2_buckets?.some((b) => b.binding !== "UNITS")) dropped.push("r2_buckets (BLOBS)");
  const droppedServices = (cfg.services ?? []).filter((s) => !lab[s.service]).length;
  next["//lab"] = { linkedAs: original, manifestHash: t.manifestHash, scriptHash: target === "c-router" ? t.router.scriptHash : target === "c-dynamic" ? t.host.scriptHash : t.packed.scripts.find((s) => s.name === original).scriptHash, dropped, droppedServices };
  if (target === "c-router" || target === "c-dynamic") {
    // The lab gate around linker C's bundle; named exports (the tier host's capability classes) pass through.
    cpSync(join(srcDir, "worker.js"), join(out, "linked.js"));
    const entry = join(out, "entry.mjs");
    writeFileSync(entry, `import inner from "./linked.js";\nimport { labGate } from ${JSON.stringify(join(here, "lab/gate.js"))};\nexport * from "./linked.js";\nexport default labGate(inner, ${JSON.stringify(target === "c-router" ? "router" : "tier")});\n`);
    await bundle(entry, "worker.js");
    rmSync(entry);
    rmSync(join(out, "linked.js"));
    next["//secrets"] = target === "c-router" ? ["LAB_TOKEN", "TIER_STATS_TOKEN"] : ["LAB_TOKEN", "LINKER_ADMIN_TOKEN", "CURSOR_SECRET"];
  } else {
    cpSync(join(srcDir, "worker.js"), join(out, "worker.js"));
    next["//secrets"] = ["CURSOR_SECRET"];
  }
  writeConfig(next);
  writeFileSync(join(out, "tiered.json"), readFileSync(join(linked, "tiered.json")));
  rmSync(linked, { recursive: true, force: true });
}

const size = readFileSync(join(out, "worker.js")).byteLength;
console.log(`forg38 lab: built ${target} (${WORKERS[target]}) -> ${relative(root, out)} (worker.js ${size} B)`);
if (!existsSync(join(out, "wrangler.jsonc"))) throw new Error("no config written");
