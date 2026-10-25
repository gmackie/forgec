// Local harness shared by the tests, the measurement script and the conformance run:
// builds what the host needs, starts `wrangler dev --local` for the host (or for today's
// whole-app acme Worker), and links a manifest into the host through /_linker/*.
import { execFileSync, spawn } from "node:child_process";
import { appendFileSync, cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { connect, createServer } from "node:net";
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

async function waitFor(url, child, ms = 90_000) {
  const until = Date.now() + ms;
  for (;;) {
    if (child.exitCode !== null || child.signalCode !== null) throw new Error(`wrangler dev exited (${child.exitCode ?? child.signalCode}) before ${url} answered`);
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

/** A port the OS just handed out on 127.0.0.1, so parallel runs (other worktrees) never share one. */
async function freePort() {
  const server = createServer();
  await new Promise((resolve, reject) => server.once("error", reject).listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

/** Whether anything accepts connections on localhost:port (IPv4 or IPv6). */
async function listening(port) {
  const probe = (host) =>
    new Promise((resolve) => {
      const socket = connect({ host, port });
      socket.setTimeout(1000);
      socket.once("connect", () => (socket.destroy(), resolve(true)));
      socket.once("timeout", () => (socket.destroy(), resolve(false)));
      socket.once("error", () => resolve(false));
    });
  return (await probe("127.0.0.1")) || (await probe("::1"));
}

const exited = (child, ms) =>
  child.exitCode !== null || child.signalCode !== null ? Promise.resolve(true) : new Promise((resolve) => {
    const t = setTimeout(() => resolve(false), ms);
    child.once("exit", () => (clearTimeout(t), resolve(true)));
  });

const killGroup = (child, signal) => {
  try {
    process.kill(-child.pid, signal);
  } catch {
    // the group is gone already
  }
};

/**
 * Starts wrangler dev --local on 127.0.0.1 with a fresh persisted state dir and migrated D1.
 * kind = "host" (Linker B) or "whole-app" (examples/acme/deploy/cloudflare).
 */
export async function startWorker({ kind = "host", port, vars = {}, log } = {}) {
  // FORG-45: without a port, take a free one. A fixed port is shared with every other checkout on
  // the machine: two hosts on "localhost:8951" can bind ::1 and 127.0.0.1 side by side, and a test
  // then talks to the other checkout's host until it stops. Listening on 127.0.0.1 only (--ip)
  // keeps one address per port.
  port ??= await freePort();
  // FORG-45: a previous run's wrangler (or an orphaned workerd) still on the port would answer the
  // ping below in place of this one, and then vanish mid-test. Refuse instead.
  if (await listening(port)) throw new Error(`port ${port} is already in use; is another wrangler dev (or an orphaned workerd) still running?`);
  const config = kind === "host" ? join(pkg, "host/wrangler.jsonc") : join(acme, "deploy/cloudflare/wrangler.jsonc");
  const state = mkdtempSync(join(tmpdir(), `forg30-${kind}-`));
  execFileSync(wrangler, ["d1", "migrations", "apply", "forge-acme", "--local", "--config", config, "--persist-to", state], { stdio: "pipe", env: { ...process.env, CI: "1" } });
  const allVars = { CURSOR_SECRET, ...(kind === "host" ? { LINKER_ADMIN_TOKEN: ADMIN_TOKEN } : {}), ...vars };
  const args = ["dev", "--config", config, "--local", "--ip", "127.0.0.1", "--port", String(port), "--persist-to", state, "--show-interactive-dev-session=false", ...Object.entries(allVars).flatMap(([k, v]) => ["--var", `${k}:${v}`])];
  // Its own process group, so stop() also reaches the two workerd processes wrangler starts.
  const child = spawn(wrangler, args, { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, CI: "1" }, detached: true });
  const lines = [];
  // LINKER_HARNESS_WRANGLER_LOG=<file> appends wrangler's output there (FORG-45 diagnosis).
  const tee = process.env.LINKER_HARNESS_WRANGLER_LOG;
  const onData = (d) => {
    lines.push(String(d));
    if (log) log(String(d));
    if (tee) appendFileSync(tee, `[${new Date().toISOString()} ${kind}:${port}] ${String(d)}`);
  };
  child.stdout.on("data", onData);
  child.stderr.on("data", onData);
  const base = `http://127.0.0.1:${port}`;
  outputs.set(base, lines);
  try {
    await waitFor(`${base}/_linker/ping`, child);
  } catch (e) {
    killGroup(child, "SIGKILL");
    throw new Error(`${e.message}\n${lines.join("").slice(-2000)}`, { cause: e });
  }
  return {
    base,
    state,
    output: () => lines.join(""),
    async stop() {
      // Let wrangler dispose its workerd processes, then kill whatever of the group is left and
      // wait for the port to close, so the next startWorker cannot reach a dying instance.
      killGroup(child, "SIGTERM");
      await exited(child, 5000);
      killGroup(child, "SIGKILL");
      await exited(child, 5000);
      for (const until = Date.now() + 10_000; Date.now() < until && (await listening(port)); ) await new Promise((r) => setTimeout(r, 200));
      outputs.delete(base);
      rmSync(state, { recursive: true, force: true });
    },
  };
}

const admin = (base, path, init = {}) => fetch(`${base}${path}`, { ...init, headers: { "x-linker-admin": ADMIN_TOKEN, ...(init.headers ?? {}) } });

/** wrangler dev output per running Worker, so a dropped request can be logged with what wrangler saw. */
const outputs = new Map();

/**
 * FORG-45. Every request crosses two keep-alive HTTP hops: Node -> wrangler's ProxyWorker (a
 * workerd on `port`) -> the user Worker's own workerd. workerd closes a connection idle for 5 s.
 * A request sent on a pooled connection at that moment is lost:
 * - on the Node hop as `fetch failed` (ECONNRESET or a closed socket), for instance when the test
 *   process blocks its event loop past 5 s, so undici cannot expire the socket first (4 s);
 * - on the proxy hop as 500 "Error: Network connection lost." from the proxy's entry Worker,
 *   because the ProxyWorker retries only GET and HEAD itself (or 503 "Your worker restarted
 *   mid-request" if the user Worker restarted).
 * The admin PUTs below are idempotent (blobs are content-addressed, the kit is written whole), so
 * the harness retries exactly those failures, at most PUT_ATTEMPTS times with backoff, and logs
 * each retry with its error and wrangler's own report. Anything else fails at once. Manifest links
 * are not retried (a repeat would change `previous`), and the host (src/) never retries.
 */
const PUT_ATTEMPTS = Math.max(1, Number(process.env.LINKER_HARNESS_PUT_ATTEMPTS ?? 3));
const droppedHop = (status, text) => (status === 500 && text.includes("Network connection lost")) || (status === 503 && text.includes("restarted mid-request"));
const droppedSocket = (e) => e instanceof TypeError && /ECONNRESET|EPIPE|UND_ERR_SOCKET|UND_ERR_CLOSED/.test(String(e.cause?.code ?? ""));

async function idempotentPut(base, path, body, what) {
  for (let attempt = 1; ; attempt++) {
    let r;
    let error = "";
    try {
      r = await admin(base, path, { method: "PUT", body });
      if (r.ok) return r;
    } catch (e) {
      if (!droppedSocket(e) || attempt >= PUT_ATTEMPTS) throw attempt > 1 ? new Error(`${what} failed: ${e} (${e.cause?.code}, attempt ${attempt} of ${PUT_ATTEMPTS})`, { cause: e }) : e;
      error = `${e.message} (${e.cause.code})`;
    }
    if (r) {
      const text = await r.text();
      if (!droppedHop(r.status, text) || attempt >= PUT_ATTEMPTS) {
        const seen = droppedHop(r.status, text) ? wranglerReport(base) : "";
        throw new Error(`${what} failed: ${r.status} ${text}${droppedHop(r.status, text) ? ` (attempt ${attempt} of ${PUT_ATTEMPTS})${seen}` : ""}`);
      }
      error = `${r.status} ${text.split("\n")[0]}`;
    }
    const delay = 250 * 2 ** (attempt - 1);
    console.warn(`[harness] ${what}: attempt ${attempt} of ${PUT_ATTEMPTS} lost its connection (${error}); retrying in ${delay} ms.${wranglerReport(base)}`);
    await new Promise((res) => setTimeout(res, delay));
  }
}

/** wrangler's own lines about a dropped request (the ProxyWorker reports "failed after N attempts"). */
function wranglerReport(base) {
  const seen = (outputs.get(base) ?? []).join("").split("\n").filter((l) => /dropped connection|failed after|Network connection lost|restarted/.test(l)).slice(-3);
  return seen.length ? ` wrangler: ${seen.join(" | ")}` : "";
}

export async function putBlob(base, bytes) {
  const r = await idempotentPut(base, "/_linker/blobs", bytes, "blob upload");
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
  await idempotentPut(base, "/_linker/kit", JSON.stringify({ libraries, apps }), "kit upload");
  return { libraries, apps };
}

/**
 * Uploads module blobs from a sealed output dir (unless skipped) and links the manifest. FORG-47:
 * `ifMatch` names the pointer version the swap replaces (a compare-and-swap); `scope` the pointer.
 */
export async function linkManifest(base, { manifestText, modulesDir = join(unitsOut, "modules"), skipModules = [], ifMatch, scope } = {}) {
  const text = manifestText ?? readFileSync(join(unitsOut, "manifest.json"), "utf8");
  if (modulesDir && existsSync(modulesDir)) {
    for (const f of readdirSync(modulesDir)) if (!skipModules.includes(`sha256:${f.replace(/\.js$/, "")}`)) await putBlob(base, readFileSync(join(modulesDir, f)));
  }
  const r = await admin(base, `/_linker/manifest${scope ? `?scope=${encodeURIComponent(scope)}` : ""}`, { method: "PUT", body: text, headers: ifMatch === undefined ? {} : { "if-match": `"${ifMatch}"` } });
  return { status: r.status, body: await r.json() };
}

/** FORG-47: the shared pointer as its Durable Object holds it, and this isolate's cached view. */
export async function pointer(base, { scope } = {}) {
  return (await admin(base, `/_linker/pointer${scope ? `?scope=${encodeURIComponent(scope)}` : ""}`)).json();
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
  // The sealer checks the plan's .forge spans against the files it seals (FORG-33).
  cpSync(join(acme, "src"), join(app, "src"), { recursive: true });
  cpSync(join(acme, "package.json"), join(app, "package.json"));
  symlinkSync(join(acme, "node_modules"), join(app, "node_modules"), "dir");
  edit(join(app, "impl"));
  const plan = JSON.parse(readFileSync(join(unitsOut, "plan.json"), "utf8"));
  const sealed = await seal(plan, app);
  const dir = join(app, "sealed");
  writeSealed(sealed, dir);
  return { dir, manifest: sealed.manifest, text: stableJson(sealed.manifest) };
}
