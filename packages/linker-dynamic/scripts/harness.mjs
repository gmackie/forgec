// Local harness shared by the tests, the measurement script and the conformance run:
// builds what the host needs, starts `wrangler dev --local` for the host (or for today's
// whole-app acme Worker), and links a manifest into the host through /_linker/*.
import { execFileSync, spawn } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const pkg = dirname(dirname(fileURLToPath(import.meta.url)));
export const root = join(pkg, "../..");
export const acme = join(root, "examples/acme");
export const unitsOut = join(acme, "generated/units");
export const ADMIN_TOKEN = "local-linker-admin";
export const CURSOR_SECRET = "local-conformance-secret";
const wrangler = join(pkg, "node_modules/.bin/wrangler");

/** forgec build --units + seal for acme, and the linker libraries. Idempotent. */
export function prepare({ force = false } = {}) {
  if (force || !existsSync(join(unitsOut, "manifest.json")) || !existsSync(join(acme, "generated/app.json"))) {
    execFileSync("pnpm", ["--filter", "@acme/commerce-deploy", "units:build"], { cwd: root, stdio: "inherit" });
  }
  if (force || !existsSync(join(pkg, "generated/libs/libs.json"))) execFileSync("node", [join(pkg, "scripts/build-libs.mjs")], { stdio: "inherit" });
}

async function waitFor(url, ms = 90_000) {
  const until = Date.now() + ms;
  for (;;) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(2000) });
      await r.arrayBuffer();
      return;
    } catch {
      if (Date.now() > until) throw new Error(`timed out waiting for ${url}`);
      await new Promise((r) => setTimeout(r, 500));
    }
  }
}

/**
 * Starts wrangler dev --local with a fresh persisted state dir and migrated D1.
 * kind = "host" (Linker B) or "whole-app" (examples/acme/deploy/cloudflare).
 */
export async function startWorker({ kind = "host", port, vars = {}, log } = {}) {
  const config = kind === "host" ? join(pkg, "host/wrangler.jsonc") : join(acme, "deploy/cloudflare/wrangler.jsonc");
  const state = mkdtempSync(join(tmpdir(), `forg30-${kind}-`));
  execFileSync(wrangler, ["d1", "migrations", "apply", "forge-acme", "--local", "--config", config, "--persist-to", state], { stdio: "pipe", env: { ...process.env, CI: "1" } });
  const allVars = { CURSOR_SECRET, ...(kind === "host" ? { LINKER_ADMIN_TOKEN: ADMIN_TOKEN } : {}), ...vars };
  const args = ["dev", "--config", config, "--local", "--port", String(port), "--persist-to", state, "--show-interactive-dev-session=false", ...Object.entries(allVars).flatMap(([k, v]) => ["--var", `${k}:${v}`])];
  const child = spawn(wrangler, args, { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, CI: "1" } });
  const lines = [];
  const onData = (d) => {
    lines.push(String(d));
    if (log) log(String(d));
  };
  child.stdout.on("data", onData);
  child.stderr.on("data", onData);
  const base = `http://localhost:${port}`;
  await waitFor(`${base}/_linker/ping`);
  return {
    base,
    state,
    output: () => lines.join(""),
    async stop() {
      child.kill("SIGTERM");
      await new Promise((r) => setTimeout(r, 500));
      if (child.exitCode === null) child.kill("SIGKILL");
      rmSync(state, { recursive: true, force: true });
    },
  };
}

const admin = (base, path, init = {}) => fetch(`${base}${path}`, { ...init, headers: { "x-linker-admin": ADMIN_TOKEN, ...(init.headers ?? {}) } });

export async function putBlob(base, bytes) {
  const r = await admin(base, "/_linker/blobs", { method: "PUT", body: bytes });
  if (!r.ok) throw new Error(`blob upload failed: ${r.status} ${await r.text()}`);
  return (await r.json()).digest;
}

/** Uploads the libraries and app bundle and writes the kit. */
export async function seedKit(base, { appJson = join(acme, "generated/app.json") } = {}) {
  const libs = JSON.parse(readFileSync(join(pkg, "generated/libs/libs.json"), "utf8"));
  const libraries = {};
  for (const [name, l] of Object.entries(libs)) libraries[name] = await putBlob(base, readFileSync(join(pkg, "generated/libs", l.file)));
  const appBytes = readFileSync(appJson);
  const app = JSON.parse(appBytes.toString("utf8"));
  const apps = { [app.buildHash]: await putBlob(base, appBytes) };
  const r = await admin(base, "/_linker/kit", { method: "PUT", body: JSON.stringify({ libraries, apps }) });
  if (!r.ok) throw new Error(`kit upload failed: ${r.status}`);
  return { libraries, apps };
}

/** Uploads module blobs from a sealed output dir (unless skipped) and links the manifest. */
export async function linkManifest(base, { manifestText, modulesDir = join(unitsOut, "modules"), skipModules = [] } = {}) {
  const text = manifestText ?? readFileSync(join(unitsOut, "manifest.json"), "utf8");
  if (modulesDir && existsSync(modulesDir)) {
    for (const f of readdirSync(modulesDir)) if (!skipModules.includes(`sha256:${f.replace(/\.js$/, "")}`)) await putBlob(base, readFileSync(join(modulesDir, f)));
  }
  const r = await admin(base, "/_linker/manifest", { method: "PUT", body: text });
  return { status: r.status, body: await r.json() };
}

export async function stats(base) {
  return (await admin(base, "/_linker/stats")).json();
}
export async function resetStats(base) {
  await admin(base, "/_linker/stats/reset", { method: "POST" });
}
export async function evictHostCache(base) {
  await admin(base, "/_linker/evict-host-cache", { method: "POST" });
}

/**
 * Re-seals acme's unit plan with an edited copy of impl/. The copy keeps acme's layout (impl/ at the
 * app root, node_modules linked) so unedited modules come out byte-identical and only the edited
 * units get new hashes. `edit(implDir)` changes the copy. Returns { dir, manifest, text }, where dir
 * holds manifest.json and modules/.
 */
export async function sealVariant(edit) {
  const { seal, stableJson, writeSealed } = await import("../../units/src/index.ts");
  const app = mkdtempSync(join(tmpdir(), "forg30-variant-"));
  cpSync(join(acme, "impl"), join(app, "impl"), { recursive: true });
  cpSync(join(acme, "package.json"), join(app, "package.json"));
  symlinkSync(join(acme, "node_modules"), join(app, "node_modules"), "dir");
  edit(join(app, "impl"));
  const plan = JSON.parse(readFileSync(join(unitsOut, "plan.json"), "utf8"));
  const sealed = await seal(plan, app);
  const dir = join(app, "sealed");
  writeSealed(sealed, dir);
  return { dir, manifest: sealed.manifest, text: stableJson(sealed.manifest) };
}
