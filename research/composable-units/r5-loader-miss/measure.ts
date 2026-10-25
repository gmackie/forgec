// FORG-48 measurements of linker B's loader miss (README). Run after the lab is deployed (or against local
// `wrangler dev` hosts through MISS_BASE_URL / MISS_B_URL / MISS_SMART_URL) and the local prerequisites are
// built (forgec, acme sealed with `units:build`, linker B's libraries):
//
//   FORG48_SECRETS=/path/secrets.json node research/composable-units/r5-loader-miss/measure.ts <section>...
//
// Sections: rtt seed cache r2 miss floor fresh d1 placement. Each writes results/<section>.json (RUN=<tag> keeps
// repeats side by side). The secrets file holds MISS_LAB_TOKEN and MISS_LINKER_ADMIN_TOKEN; it is never
// committed. MEASURED=local labels a local run. Host times are wall time measured inside the Worker; on
// deployed Workers timers advance only across I/O, so they are time spent waiting, not CPU.
import { readdirSync, readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { stableJson } from "../../../packages/units/src/index.ts";
// @ts-expect-error plain module
import { url as labUrl, WORKERS } from "./lab/names.mjs";

const here = import.meta.dirname;
const root = join(here, "../../..");
const acme = join(root, "examples/acme");
const unitsOut = join(acme, "generated/units");
const libsDir = join(root, "packages/linker-dynamic/generated/libs");
const secrets = JSON.parse(readFileSync(process.env["FORG48_SECRETS"] ?? "/tmp/forg48-lab/secrets.json", "utf8")) as Record<string, string>;
const MEASURED = process.env["MEASURED"] ?? "deployed";
const BASES: Record<string, string> = {
  "miss-base": process.env["MISS_BASE_URL"] ?? labUrl("miss-base"),
  "miss-b": process.env["MISS_B_URL"] ?? labUrl("miss-b"),
  "miss-smart": process.env["MISS_SMART_URL"] ?? labUrl("miss-smart"),
};
const TARGETS = (process.env["TARGETS"] ?? Object.keys(WORKERS).join(",")).split(",");
const LAB = { "x-lab-token": secrets["MISS_LAB_TOKEN"]! };
const ADMIN = { ...LAB, "x-linker-admin": secrets["MISS_LINKER_ADMIN_TOKEN"]! };

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
  writeFileSync(join(here, "results", file), stableJson({ version: "r5-loader-miss/1", issue: "FORG-48", measured: MEASURED, section: name, run: process.env["RUN"] ?? null, at: new Date().toISOString(), ...(data as object) }));
  console.log(`results/${file}`);
};

const KEEP = /^(x-(forge|lab)-|cf-placement|cf-ray)/;
async function call(base: string, method: string, path: string, body?: string, headers: Record<string, string> = {}) {
  const t0 = performance.now();
  const r = await fetch(`${base}${path}`, { method, headers: { ...LAB, "content-type": "application/json", ...headers }, ...(body === undefined ? {} : { body }) });
  const text = await r.text();
  const ms = round(performance.now() - t0);
  const h: Record<string, string> = {};
  r.headers.forEach((v, k) => {
    if (KEEP.test(k)) h[k] = v;
  });
  let json: any = text;
  try {
    json = JSON.parse(text);
  } catch {}
  return { status: r.status, ms, json, h };
}
const breakdown = (h: Record<string, string>) => Object.fromEntries((h["x-forge-link-breakdown"] ?? "").split(";").filter(Boolean).map((kv) => kv.split("=")).map(([k, v]) => [k, Number.isNaN(Number(v)) ? v : Number(v)]));
const host = (h: Record<string, string>) => ({ isolate: h["x-lab-b-isolate"] ?? null, ageMs: h["x-lab-b-isolate-age-ms"] === undefined ? null : Number(h["x-lab-b-isolate-age-ms"]), requests: h["x-lab-b-requests"] === undefined ? null : Number(h["x-lab-b-requests"]), colo: h["x-lab-colo"] ?? null, placement: h["cf-placement"] ?? null });

async function admin(base: string, method: string, path: string, body?: string | Uint8Array) {
  const t0 = performance.now();
  const r = await fetch(`${base}${path}`, { method, headers: ADMIN, ...(body === undefined ? {} : { body: body as BodyInit }) });
  const text = await r.text();
  if (!r.ok) throw new Error(`${method} ${path}: ${r.status} ${text.slice(0, 500)}`);
  return { ms: round(performance.now() - t0), json: JSON.parse(text) };
}
const manifestText = () => readFileSync(join(unitsOut, "manifest.json"), "utf8");

const sections: Record<string, () => Promise<void>> = {
  async rtt() {
    const out: Record<string, unknown> = {};
    for (const t of TARGETS) {
      const xs: number[] = [];
      let who = null;
      for (let i = 0; i < 20; i++) {
        const r = await call(BASES[t]!, "GET", "/_lab/whoami");
        xs.push(r.ms);
        who = r.json;
      }
      out[t] = { clientMs: summary(xs.slice(1)), firstMs: xs[0], colo: (who as any)?.colo ?? null };
    }
    save("rtt", { workers: out });
  },

  /** The kit (libraries, app bundle), acme's unit modules, and the sealed manifest, into each Worker's bucket. */
  async seed() {
    const out: Record<string, unknown> = {};
    const libs = JSON.parse(readFileSync(join(libsDir, "libs.json"), "utf8")) as Record<string, { file: string; bytes: number }>;
    for (const t of TARGETS) {
      const base = BASES[t]!;
      const libraries: Record<string, string> = {};
      for (const [name, l] of Object.entries(libs)) libraries[name] = (await admin(base, "PUT", "/_linker/blobs", readFileSync(join(libsDir, l.file)))).json.digest;
      const appBytes = readFileSync(join(acme, "generated/app.json"));
      const apps = { [JSON.parse(appBytes.toString("utf8")).buildHash]: (await admin(base, "PUT", "/_linker/blobs", appBytes)).json.digest };
      await admin(base, "PUT", "/_linker/kit", JSON.stringify({ libraries, apps }));
      const dir = join(unitsOut, "modules");
      for (const f of readdirSync(dir)) await admin(base, "PUT", "/_linker/blobs", readFileSync(join(dir, f)));
      const linked = await admin(base, "PUT", "/_linker/manifest", manifestText());
      out[t] = { libraries, apps, linkMs: linked.ms, link: linked.json };
    }
    save("seed", { workers: out });
  },

  /** Does the Cache API keep an entry on a workers.dev hostname? */
  async cache() {
    const out: Record<string, unknown[]> = {};
    for (const t of TARGETS) {
      out[t] = [];
      for (let i = 0; i < 3; i++) out[t]!.push({ ...(await call(BASES[t]!, "GET", "/_lab/cache")).json });
    }
    save("cache", { workers: out });
  },

  /** Raw R2 latency of the kit's blobs, serial against parallel. */
  async r2() {
    const t = TARGETS.includes("miss-b") ? "miss-b" : TARGETS[0]!;
    const N = Number(process.env["N"] ?? 8);
    const runs: Record<string, any[]> = { serial: [], parallel: [] };
    for (let i = 0; i < N; i++) {
      runs["serial"]!.push({ ...(await call(BASES[t]!, "GET", "/_lab/r2")).json });
      runs["parallel"]!.push({ ...(await call(BASES[t]!, "GET", "/_lab/r2?parallel=1")).json });
    }
    const perKey = (xs: any[]) => {
      const by: Record<string, number[]> = {};
      for (const x of xs) for (const o of x.ops) (by[`${o.key} (${o.bytes} B)`] ??= []).push(o.ms);
      return Object.fromEntries(Object.entries(by).map(([k, v]) => [k, summary(v)]));
    };
    save("r2", { worker: t, serial: { blobsMs: summary(runs["serial"]!.map((x) => x.blobsMs)), headMs: summary(runs["serial"]!.map((x) => x.headMs)), perKey: perKey(runs["serial"]!) }, parallel: { blobsMs: summary(runs["parallel"]!.map((x) => x.blobsMs)), perKey: perKey(runs["parallel"]!) }, runs });
  },

  /**
   * Loader misses in a warm host isolate, one isolate per sample (/_lab/miss runs evict + miss + warm in one
   * request). Kinds: memory (code cache dropped), cache (memory dropped too: a new host isolate's view),
   * store (Cache API entries dropped too). On miss-base every kind reads R2 serially.
   */
  async miss() {
    const N = Number(process.env["N"] ?? 10);
    const kinds: Array<[string, string]> = [["memory", "code"], ["cache", "code,memory"], ["store", "code,memory,cache"]];
    const paths = (process.env["PATHS"] ?? "GET /v1/customers,POST /v1/customers,GET /forge/discovery").split(",").map((x) => x.split(" ") as [string, string]);
    const tenant = `m-${Date.now().toString(36)}`;
    // first sight of the tenant, outside the samples
    for (const t of TARGETS) await call(BASES[t]!, "POST", "/v1/customers", JSON.stringify({ code: `S${Date.now().toString(36).slice(-6).toUpperCase()}`, name: "Seed" }), { "x-forge-tenant": tenant, "x-forge-actor": "forg48" });
    // Samples are interleaved across Workers (one per Worker in turn), so each comparison is paired in time.
    // miss-base runs every kind too; with LINKER_UNIT_CACHE=off each is the same serial store read.
    const raw: Record<string, Record<string, any[]>> = Object.fromEntries(TARGETS.map((t) => [t, {}]));
    for (const [kind, layers] of kinds) {
      for (const [method, path] of paths) {
        for (let i = 0; i < N; i++) {
          for (const t of TARGETS) {
            const r = await call(BASES[t]!, "POST", `/_lab/miss?layers=${layers}&method=${method}&path=${encodeURIComponent(path)}&tenant=${tenant}`);
            if (r.status !== 200) throw new Error(`${t} ${kind}: ${r.status} ${JSON.stringify(r.json).slice(0, 400)}`);
            (raw[t]![`${kind} ${method} ${path}`] ??= []).push({ clientMs: r.ms, ...host(r.h), ...r.json });
          }
          await sleep(200);
        }
      }
    }
    const out: Record<string, unknown> = {};
    for (const t of TARGETS) {
      out[t] = Object.fromEntries(
        Object.entries(raw[t]!).map(([k, samples]) => {
          const ok = samples.filter((s) => s.miss.isolate === "cold" && s.miss.status < 300);
          return [
            k,
            {
              cold: `${ok.length}/${samples.length}`,
              missLinkMs: summary(ok.map((s) => s.miss.linkMs)),
              missOverWarmMs: summary(ok.map((s) => s.miss.linkMs - s.warm.linkMs)),
              missBuildMs: summary(ok.map((s) => s.miss.breakdown.build)),
              missChildMs: summary(ok.map((s) => s.miss.breakdown.child)),
              missResolveMs: summary(ok.map((s) => s.miss.breakdown.resolve)),
              warmLinkMs: summary(ok.map((s) => s.warm.linkMs)),
              layers: ok.map((s) => `m${s.miss.breakdown.memory}/c${s.miss.breakdown.cache}/s${s.miss.breakdown.store}`),
              hostIsolates: [...new Set(samples.map((s) => s.isolate))],
              placement: [...new Set(samples.map((s) => s.placement))],
              samples,
            },
          ];
        }),
      );
    }
    save("miss", { tenant, interleaved: TARGETS, workers: out });
  },

  /** The child cold start split by what it loads (/_lab/floor), in a warm host isolate. */
  async floor() {
    const t = TARGETS.includes("miss-b") ? "miss-b" : TARGETS[0]!;
    const runs: any[] = [];
    for (let i = 0; i < Number(process.env["N"] ?? 4); i++) {
      const r = await call(BASES[t]!, "GET", "/_lab/floor?n=5");
      runs.push({ ...host(r.h), ...r.json });
      await sleep(500);
    }
    // the first run may land on a fresh host isolate; keep runs on an isolate that had served before
    const warmHost = runs.filter((r) => (r.requests ?? 0) > 1);
    const names = Object.keys(runs[0].variants);
    const by = (xs: any[]) => Object.fromEntries(names.map((n) => [n, { coldMs: summary(xs.flatMap((r) => r.variants[n].cold.map((c: any) => c.ms))), warmMs: summary(xs.flatMap((r) => r.variants[n].warm)) }]));
    save("floor", { worker: t, bytes: runs[0].bytes, warmHost: by(warmHost), all: by(runs), runs });
  },

  /** The first request on a fresh host isolate: idle long enough that the next request starts one. */
  async fresh() {
    const N = Number(process.env["N"] ?? 6);
    const GAP = Number(process.env["GAP_S"] ?? 30);
    const tenant = `f-${Date.now().toString(36)}`;
    const out: Record<string, any[]> = Object.fromEntries(TARGETS.map((t) => [t, []]));
    for (let i = 0; i < N; i++) {
      await sleep(GAP * 1000);
      for (const t of TARGETS) {
        const r = await call(BASES[t]!, "GET", "/v1/customers", undefined, { "x-forge-tenant": tenant, "x-forge-actor": "forg48" });
        out[t]!.push({ status: r.status, clientMs: r.ms, ...host(r.h), childIsolate: r.h["x-forge-isolate"] ?? null, linkMs: Number(r.h["x-forge-link-ms"]), breakdown: breakdown(r.h) });
        console.log(t, JSON.stringify(out[t]!.at(-1)));
      }
    }
    const fresh = (xs: any[]) => xs.filter((x) => x.requests === 1 && x.status === 200);
    save("fresh", {
      gapS: GAP,
      summary: Object.fromEntries(TARGETS.map((t) => [t, { fresh: `${fresh(out[t]!).length}/${out[t]!.length}`, linkMs: summary(fresh(out[t]!).map((x) => x.linkMs)), resolveMs: summary(fresh(out[t]!).map((x) => x.breakdown.resolve)), buildMs: summary(fresh(out[t]!).map((x) => x.breakdown.build)), childMs: summary(fresh(out[t]!).map((x) => x.breakdown.child)), clientMs: summary(fresh(out[t]!).map((x) => x.clientMs)), layers: fresh(out[t]!).map((x) => `m${x.breakdown.memory}/c${x.breakdown.cache}/s${x.breakdown.store}`) }])),
      samples: out,
    });
  },

  /** D1 round trips from where each Worker runs: SELECT 1 one after another, and warm acme writes. */
  async d1() {
    const N = Number(process.env["N"] ?? 5);
    const tenant = `d-${Date.now().toString(36)}`;
    const out: Record<string, unknown> = {};
    for (const t of TARGETS) {
      const per: number[] = [];
      const runs: any[] = [];
      for (let i = 0; i < N; i++) {
        const r = await call(BASES[t]!, "GET", "/_lab/d1?n=20");
        per.push(...r.json.ms);
        runs.push({ ...host(r.h), ms: r.json.ms });
      }
      const writes: any[] = [];
      const reads: any[] = [];
      for (let i = 0; i < 20; i++) {
        const w = await call(BASES[t]!, "POST", "/v1/customers", JSON.stringify({ code: `D${Date.now().toString(36).slice(-6).toUpperCase()}${i}`, name: "D1" }), { "x-forge-tenant": tenant, "x-forge-actor": "forg48" });
        writes.push({ status: w.status, clientMs: w.ms, linkMs: Number(w.h["x-forge-link-ms"]), childMs: breakdown(w.h)["child"], cold: w.h["x-forge-isolate"], ...host(w.h) });
        const g = await call(BASES[t]!, "GET", "/v1/customers", undefined, { "x-forge-tenant": tenant, "x-forge-actor": "forg48" });
        reads.push({ status: g.status, clientMs: g.ms, linkMs: Number(g.h["x-forge-link-ms"]), childMs: breakdown(g.h)["child"], cold: g.h["x-forge-isolate"], ...host(g.h) });
      }
      const warm = (xs: any[]) => xs.filter((x) => x.cold === "warm" && x.status < 300);
      out[t] = { selectOneMs: summary(per), placement: [...new Set([...runs, ...writes].map((x) => x.placement))], colos: [...new Set(runs.map((x) => x.colo))], warmWrite: { linkMs: summary(warm(writes).map((x) => x.linkMs)), clientMs: summary(warm(writes).map((x) => x.clientMs)) }, warmRead: { linkMs: summary(warm(reads).map((x) => x.linkMs)), clientMs: summary(warm(reads).map((x) => x.clientMs)) }, runs, writes, reads };
    }
    save("d1", { tenant, workers: out });
  },

  /** Steady D1-bound traffic, so Smart Placement has something to analyse; prints cf-placement as it changes. */
  async placement() {
    const MIN = Number(process.env["MINUTES"] ?? 15);
    const t = process.env["PLACEMENT_TARGET"] ?? "miss-smart";
    const until = Date.now() + MIN * 60_000;
    const seen: Array<{ at: string; placement: string | null; colo: string | null; n: number }> = [];
    let n = 0;
    let last: string | null | undefined;
    while (Date.now() < until) {
      const r = await call(BASES[t]!, "GET", "/_lab/d1?n=5");
      n++;
      const p = r.h["cf-placement"] ?? null;
      if (p !== last) {
        seen.push({ at: new Date().toISOString(), placement: p, colo: r.h["x-lab-colo"] ?? null, n });
        console.log(JSON.stringify(seen.at(-1)), r.json.ms);
        last = p;
      }
      await sleep(250);
    }
    save("placement", { worker: t, minutes: MIN, requests: n, transitions: seen });
  },
};

for (const s of process.argv.slice(2)) {
  if (!sections[s]) throw new Error(`unknown section ${s}; one of ${Object.keys(sections).join(", ")}`);
  console.log(`== ${s}`);
  await sections[s]!();
}
