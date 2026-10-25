// FORG-47 measurements on the deployed r4 lab (research/composable-units/r4-deployed: build.mjs, lab/),
// with the manifest pointer in a Durable Object. Run after the lab Workers are deployed:
//
//   FORG38_SECRETS=/path/secrets.json node research/composable-units/r4-manifest-pointer/measure.ts <section>...
//
// Sections: seed read swap-b cas swap-c stats-c. Each writes results/<section>.json (deployed).
// Visibility is measured from this client: a swap's PUT answers after the DO committed it, so a request
// sent `ttlMs` after that answer must be served the new version on every isolate. Each answer names
// its host isolate (x-lab-b-isolate / x-lab-tier-isolate, the lab gate) and its pointer version
// (x-forge-pointer), and the host reports the DO read time (x-forge-pointer-ms).
import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { seal, stableJson, writeSealed } from "../../../packages/units/src/index.ts";
// @ts-expect-error plain module
import { url as labUrl } from "../r4-deployed/lab/names.mjs";

const here = import.meta.dirname;
const root = join(here, "../../..");
const acme = join(root, "examples/acme");
const unitsOut = join(acme, "generated/units");
const libsDir = join(root, "packages/linker-dynamic/generated/libs");
const secrets = JSON.parse(readFileSync(process.env["FORG38_SECRETS"] ?? "/tmp/forg47-lab/secrets.json", "utf8")) as Record<string, string>;
const B = process.env["B_URL"] ?? labUrl("linker-b");
const C = process.env["C_URL"] ?? labUrl("c-router");
const TIER = process.env["TIER_URL"] ?? labUrl("c-dynamic");
const LAB = { "x-lab-token": secrets["LAB_TOKEN"]! };
const ADMIN = { ...LAB, "x-linker-admin": secrets["LINKER_ADMIN_TOKEN"]! };
const TTL = Number(process.env["TTL_MS"] ?? 1000);

const round = (x: number) => Math.round(x * 100) / 100;
const q = (xs: number[], p: number) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? round(s[Math.min(s.length - 1, Math.max(0, Math.ceil(p * s.length) - 1))]!) : null;
};
const summary = (xs: number[]) => ({ n: xs.length, min: q(xs, 0), median: q(xs, 0.5), p95: q(xs, 0.95), max: q(xs, 1) });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const save = (name: string, data: unknown) => {
  mkdirSync(join(here, "results"), { recursive: true });
  const file = process.env["RUN"] ? `${name}.${process.env["RUN"]}.json` : `${name}.json`;
  writeFileSync(join(here, "results", file), stableJson({ version: "r4-manifest-pointer/1", issue: "FORG-47", measured: "deployed", section: name, run: process.env["RUN"] ?? null, at: new Date().toISOString(), ttlMs: TTL, ...(data as object) }));
  console.log(`results/${file}`);
};

interface Answer {
  status: number;
  sentAt: number;
  clientMs: number;
  json: any;
  isolate: string | null;
  how: string | null;
  version: number | null;
  pointerMs: number | null;
  linkMs: number | null;
  tier: string | null;
  miss: string | null;
  closure: string | null;
  colo: string | null;
}
const t00 = performance.now();
async function call(base: string, method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<Answer> {
  const sentAt = performance.now();
  const r = await fetch(`${base}${path}`, { method, headers: { ...LAB, "content-type": "application/json", ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const text = await r.text();
  const clientMs = performance.now() - sentAt;
  let json: any = text;
  try {
    json = JSON.parse(text);
  } catch {}
  const ptr = r.headers.get("x-forge-pointer");
  const n = (k: string) => (r.headers.get(k) === null ? null : Number(r.headers.get(k)));
  return { status: r.status, sentAt: round(sentAt - t00), clientMs: round(clientMs), json, isolate: r.headers.get("x-lab-b-isolate") ?? r.headers.get("x-lab-tier-isolate"), how: ptr?.split(";")[0] ?? null, version: ptr ? Number(/v=(\d+)/.exec(ptr)![1]) : null, pointerMs: n("x-forge-pointer-ms"), linkMs: n("x-forge-link-ms"), tier: r.headers.get("x-forge-tier"), miss: r.headers.get("x-forge-tier-miss"), closure: r.headers.get("x-forge-closure")?.slice(7, 19) ?? null, colo: r.headers.get("x-lab-colo") };
}
const slim = ({ json: _, ...a }: Answer) => a;

async function admin(base: string, method: string, path: string, body?: string | Uint8Array, headers: Record<string, string> = {}) {
  const t0 = performance.now();
  const r = await fetch(`${base}${path}`, { method, headers: { ...ADMIN, ...headers }, ...(body === undefined ? {} : { body: body as BodyInit }) });
  const text = await r.text();
  return { status: r.status, ms: round(performance.now() - t0), at: round(performance.now() - t00), json: JSON.parse(text) as any };
}
const must = async (p: ReturnType<typeof admin>) => {
  const r = await p;
  if (r.status >= 300) throw new Error(`admin: ${r.status} ${JSON.stringify(r.json).slice(0, 500)}`);
  return r;
};
async function seedKit(base: string) {
  const libs = JSON.parse(readFileSync(join(libsDir, "libs.json"), "utf8")) as Record<string, { file: string }>;
  const libraries: Record<string, string> = {};
  for (const [name, l] of Object.entries(libs)) libraries[name] = (await must(admin(base, "PUT", "/_linker/blobs", readFileSync(join(libsDir, l.file))))).json.digest;
  const appBytes = readFileSync(join(acme, "generated/app.json"));
  const app = JSON.parse(appBytes.toString("utf8")) as { buildHash: string };
  const apps = { [app.buildHash]: (await must(admin(base, "PUT", "/_linker/blobs", appBytes))).json.digest };
  await must(admin(base, "PUT", "/_linker/kit", JSON.stringify({ libraries, apps })));
}
async function seedModules(base: string, dir: string) {
  for (const f of readdirSync(dir)) await must(admin(base, "PUT", "/_linker/blobs", readFileSync(join(dir, f))));
}
const manifestText = () => readFileSync(join(unitsOut, "manifest.json"), "utf8");
const pointer = async (base: string) => (await must(admin(base, "GET", "/_linker/pointer"))).json as { pointer: { version: number; manifestHash: string | null } };
const link = (base: string, text: string, ifMatch?: number) => admin(base, "PUT", "/_linker/manifest", text, ifMatch === undefined ? {} : { "if-match": `"${ifMatch}"` });

async function sealVariant(edit: (impl: string) => void) {
  const app = mkdtempSync(join(tmpdir(), "forg47-variant-"));
  cpSync(join(acme, "impl"), join(app, "impl"), { recursive: true });
  cpSync(join(acme, "src"), join(app, "src"), { recursive: true });
  cpSync(join(acme, "package.json"), join(app, "package.json"));
  symlinkSync(join(acme, "node_modules"), join(app, "node_modules"), "dir");
  edit(join(app, "impl"));
  const plan = JSON.parse(readFileSync(join(unitsOut, "plan.json"), "utf8"));
  const sealed = await seal(plan, app);
  const dir = join(app, "sealed");
  writeSealed(sealed, dir);
  return { dir, manifest: sealed.manifest as any, text: stableJson(sealed.manifest) };
}
const edit = (file: string, f: (s: string) => string) => (impl: string) => writeFileSync(join(impl, file), f(readFileSync(join(impl, file), "utf8")));
const raiseLimit = edit("payment-adapter.ts", (s) => s.replace("amount >= 1000", "amount >= 2000"));
const breakModule = edit("payment-adapter.ts", (s) => `${s}\nif (!(globalThis as Record<string, unknown>)["forgeNever"]) throw new Error("payment adapter failed to initialise");\n`);

/** Requests for one tenant; customers and sites go through B (C's lab cut has no packed script for them). */
function acmeClient(base: string, tenant: string, setup = B) {
  const H = { "x-forge-tenant": tenant, "x-forge-actor": "forg47" };
  let n = 0;
  let site: { customer: string; site: string } | null = null;
  const c = (method: string, path: string, body?: unknown) => call(base, method, path, body, H);
  const draft = async (subtotal = "10.00") => {
    if (!site) {
      const cu = await call(setup, "POST", "/v1/customers", { code: `P${Date.now().toString(36).slice(-5).toUpperCase()}${++n}`, name: "Lab" }, H);
      if (cu.status !== 201) throw new Error(`customer: ${cu.status} ${JSON.stringify(cu.json).slice(0, 300)}`);
      const st = await call(setup, "POST", "/v1/sites", { customer: cu.json.id, code: "hq", name: "HQ", timezone: "UTC" }, H);
      if (st.status !== 201) throw new Error(`site: ${st.status} ${JSON.stringify(st.json).slice(0, 300)}`);
      site = { customer: cu.json.id, site: st.json.id };
    }
    const o = await c("POST", "/v1/orders", { customer: site.customer, site: site.site, subtotal, tax: "1.00", requestedOn: "2026-09-20" });
    return o;
  };
  const submit = (id: string) => c("POST", `/v1/orders/${id}/submit`, { expectedVersion: 1 });
  return { c, draft, submit };
}

/** `n` requests at once, `rounds` times, `gapMs` apart: several host isolates answer. */
async function bursts(f: () => Promise<Answer>, n: number, rounds: number, gapMs: (i: number) => number) {
  const out: Answer[] = [];
  for (let i = 0; i < rounds; i++) {
    out.push(...(await Promise.all(Array.from({ length: n }, f))));
    await sleep(gapMs(i));
  }
  return out;
}

/**
 * After a swap answered at `at` (client clock) with `version`: probes in bursts until every isolate seen
 * answers the new version and `holdMs` has passed. Returns per isolate the first time it served the new
 * version, and every answer sent `TTL` or more after `at` that still served an older one (a violation).
 */
async function watch(probe: () => Promise<Answer>, at: number, version: number, holdMs = TTL + 2000, n = 8) {
  const answers: Answer[] = [];
  const until = at + holdMs;
  while (performance.now() - t00 < until) {
    answers.push(...(await Promise.all(Array.from({ length: n }, probe))));
    await sleep(40);
  }
  const first: Record<string, number> = {};
  const lastOld: Record<string, number> = {};
  for (const a of answers) {
    if (!a.isolate || a.version === null) continue;
    if (a.version >= version) first[a.isolate] = Math.min(first[a.isolate] ?? Infinity, round(a.sentAt - at));
    else lastOld[a.isolate] = Math.max(lastOld[a.isolate] ?? -Infinity, round(a.sentAt - at));
  }
  const violations = answers.filter((a) => a.version !== null && a.version < version && a.sentAt - at >= TTL).map(slim);
  const isolates = [...new Set(answers.map((a) => a.isolate))];
  return { isolates: isolates.length, firstNewMsByIsolate: first, lastOldSentMsByIsolate: lastOld, visibleWithinMs: Math.max(0, ...Object.values(first)), violations, answers: answers.length, statuses: [...new Set(answers.map((a) => a.status))], refused: answers.filter((a) => a.status >= 500).map(slim).slice(0, 5) };
}

const sections: Record<string, () => Promise<void>> = {
  async seed() {
    const out: Record<string, unknown> = {};
    for (const [name, base] of [["b", B], ["tier", TIER]] as const) {
      await seedKit(base);
      await seedModules(base, join(unitsOut, "modules"));
      const before = await pointer(base);
      const r = await must(link(base, manifestText(), before.pointer.version));
      out[name] = { previousVersion: before.pointer.version, link: r.json, linkMs: r.ms };
    }
    save("seed", out);
  },

  /** The pointer read on B: cache hits, and revalidations (one DO read) after the copy is older than TTL. */
  async read() {
    const a = acmeClient(B, `r-${Date.now().toString(36)}`);
    const xs = await bursts(() => a.c("GET", "/v1/customers"), Number(process.env["N"] ?? 12), Number(process.env["ROUNDS"] ?? 24), (i) => (i % 2 ? TTL + 300 : 100));
    const by = (how: string) => xs.filter((x) => x.how === how);
    const pm = (how: string) => summary(by(how).map((x) => x.pointerMs!).filter((x) => x !== null));
    const lm = (how: string) => summary(by(how).filter((x) => x.status === 200).map((x) => x.linkMs!).filter((x) => x !== null));
    save("read", {
      note: "pointerMs: host wall time of the DO read (x-forge-pointer-ms, 0 on a cache hit); linkMs: host time to the child's answer (x-forge-link-ms), which includes it",
      isolates: [...new Set(xs.map((x) => x.isolate))].length,
      colos: [...new Set(xs.map((x) => x.colo))],
      counts: { cached: by("cached").length, revalidated: by("revalidated").length, changed: by("changed").length, other: xs.filter((x) => !x.how).length },
      pointerMs: { revalidated: pm("revalidated"), changed: pm("changed") },
      linkMs: { cached: lm("cached"), revalidated: lm("revalidated"), changed: lm("changed") },
      clientMs: { cached: summary(by("cached").map((x) => x.clientMs)), revalidated: summary(by("revalidated").map((x) => x.clientMs)) },
      samples: xs.map(slim),
    });
  },

  /** Swap and swap-back on B, observed from every isolate that answers. */
  async "swap-b"() {
    const REPS = Number(process.env["REPS"] ?? 3);
    const v = await sealVariant(raiseLimit);
    await seedModules(B, join(v.dir, "modules"));
    const a = acmeClient(B, `s-${Date.now().toString(36)}`);
    const probe = () => a.c("GET", "/v1/customers");
    const cycles: unknown[] = [];
    for (let i = 0; i < REPS; i++) {
      await bursts(probe, 12, 4, () => 150); // warm several isolates on the current version
      const p0 = (await pointer(B)).pointer.version;
      const sw = await link(B, v.text, p0);
      if (sw.status !== 200) throw new Error(`swap: ${sw.status} ${JSON.stringify(sw.json)}`);
      const swap = await watch(probe, sw.at, sw.json.version);
      // The new closure, on whichever isolates answer: a 1501.00 order is authorized.
      const subs: Answer[] = [];
      for (let k = 0; k < 6; k++) {
        const o = await a.draft("1501.00");
        subs.push(await a.submit(o.json.id));
      }
      const back = await link(B, manifestText(), sw.json.version);
      if (back.status !== 200) throw new Error(`swap back: ${back.status} ${JSON.stringify(back.json)}`);
      const swapBack = await watch(probe, back.at, back.json.version);
      const subsBack: Answer[] = [];
      for (let k = 0; k < 6; k++) {
        const o = await a.draft("1501.00");
        subsBack.push(await a.submit(o.json.id));
      }
      cycles.push({ swap: { version: sw.json.version, putMs: sw.ms, ...swap }, submitsAfterSwap: subs.map((s) => ({ status: s.status, state: s.json?.status ?? s.json?.code, isolate: s.isolate, version: s.version })), swapBack: { version: back.json.version, putMs: back.ms, ...swapBack }, submitsAfterSwapBack: subsBack.map((s) => ({ status: s.status, state: s.json?.status ?? s.json?.code, isolate: s.isolate, version: s.version })) });
    }
    save("swap-b", { reps: REPS, cycles });
  },

  /** A stale writer is refused and the pointer does not move. */
  async cas() {
    const p = (await pointer(B)).pointer;
    const stale = await link(B, manifestText(), p.version - 1);
    const after = (await pointer(B)).pointer;
    save("cas", { before: { version: p.version, manifestHash: p.manifestHash }, stale: { status: stale.status, body: stale.json }, after: { version: after.version, manifestHash: after.manifestHash } });
  },

  /** FORG-38's C sequence: swap, break, restore; then no fallback once TTL has passed. */
  async "swap-c"() {
    const swapped = await sealVariant(raiseLimit);
    const broken = await sealVariant(breakModule);
    await seedModules(TIER, join(swapped.dir, "modules"));
    await seedModules(TIER, join(broken.dir, "modules"));
    const a = acmeClient(C, `c-${Date.now().toString(36)}`);
    const order = async () => (await a.draft()) as Answer;
    const submitMany = async (n: number) => {
      const ids = await Promise.all(Array.from({ length: n }, async () => (await a.draft("1501.00")).json.id as string));
      return Promise.all(ids.map((id) => a.submit(id)));
    };
    await bursts(order, 6, 3, () => 150);
    const steps: Record<string, unknown> = {};
    for (const [name, text] of [["swap", swapped.text], ["break", broken.text], ["restore", manifestText()]] as const) {
      const p0 = (await pointer(TIER)).pointer.version;
      const r = await link(TIER, text, p0);
      if (r.status !== 200) throw new Error(`${name}: ${r.status} ${JSON.stringify(r.json)}`);
      const seen = await watch(order, r.at, r.json.version, TTL + 1500, 6);
      const after = await submitMany(8);
      steps[name] = { version: r.json.version, putMs: r.ms, ...seen, submits: after.map((s) => ({ status: s.status, tier: s.tier, miss: s.miss, state: s.json?.status ?? s.json?.code, isolate: s.isolate, version: s.version })), fallbacks: after.filter((s) => s.tier === "packed-fallback").length };
    }
    save("swap-c", { steps });
  },

  /** The router's stats read through several router isolates: one shared answer, with a real since. */
  async "stats-c"() {
    await sleep(2500);
    const xs: unknown[] = [];
    for (let i = 0; i < 10; i++) {
      const r = await fetch(`${C}/_forge/tiered/stats`, { headers: { ...LAB, "x-forge-tier-token": secrets["TIER_STATS_TOKEN"]! } });
      const j = (await r.json()) as any;
      xs.push({ status: r.status, routerIsolate: r.headers.get("x-lab-router-isolate"), scope: j.scope, since: j.since, dynamic: j.dynamic, packed: j.packed, fallback: j.fallback, byReason: j.byReason, reportingIsolates: Object.values(j.isolates ?? {}).map((x: any) => x.kind) });
    }
    save("stats-c", { reads: xs });
  },
};

for (const s of process.argv.slice(2)) {
  if (!sections[s]) throw new Error(`unknown section ${s}; one of ${Object.keys(sections).join(", ")}`);
  console.log(`== ${s}`);
  await sections[s]!();
}
