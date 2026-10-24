// Linker differential (FORG-43): the conformance scenarios against today's whole-app Worker, linker A,
// linker B and linker C, each served locally in workerd (Miniflare, one instance per target, fresh
// state), compared step by step with the conformance suite's comparator, as linker A's differential
// (packages/linker-packed/test/differential.test.ts) does. Heavy, so opt-in:
//
//   TIERED_DIFFERENTIAL=1 pnpm --filter @forgegraph/linker-tiered exec vitest run test/differential.test.ts
//
// Expects research/composable-units/r3-linker-tiered/run.sh to have linked the targets first.
// Writes research/composable-units/r3-linker-tiered/results/conformance.json, or $LINK_RESULTS/conformance.json.
import { spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import * as client from "../../../conformance/fixtures/acme.client.ts";
import { compareReports, EXPLAINED_KEYS, type Difference } from "../../../conformance/src/differential.ts";
import { HttpTarget } from "../../../conformance/src/http-target.ts";
import { runScenario, type Report } from "../../../conformance/src/runner.ts";
import { loadScenarios } from "../../../conformance/src/scenarios.ts";
import type { Link } from "@forgegraph/linker-packed";
import { scriptsOf, serve, type LocalScript, type Served } from "@forgegraph/linker-packed/local";
import type { TieredLink } from "../src/link.ts";
import { dynamicHostScript, hostFetcher, linkDynamic, seedKit, tieredScriptsOf, tierStats } from "../src/local.ts";
import { acme, acmeManifestText, env, unitsOut } from "./fixtures.ts";

const root = resolve(import.meta.dirname, "../../..");
const linked = join(acme, "generated/linked");
const results = resolve(process.env["LINK_RESULTS"] ?? join(root, "research/composable-units/r3-linker-tiered/results"));

const wholeApp: LocalScript = {
  name: "forge-acme",
  scriptPath: join(linked, "whole-app/worker.js"),
  bindings: ["DB", "BLOBS", "REALTIME", "Q_FULFILL_ORDER", "WF_PROCESS_ORDER", "CURSOR_SECRET", "FORGE_AUTH", "FORGE_CORS"],
  queues: ["forge-acme-commerce-fulfill-order"],
  classes: { workflows: [{ className: "ProcessOrderWorkflow" }], realtime: "ForgeRealtime" },
  services: {},
};
const tiered = () => JSON.parse(readFileSync(join(linked, "tiered/tiered.json"), "utf8")) as TieredLink;

interface Target {
  name: string;
  describe: string;
  scripts: () => Promise<LocalScript[]>;
  /** After start: seed the dynamic tier. Returns the dynamic host's name, for its stats. */
  setup?: (s: Served) => Promise<string>;
  router?: boolean;
}
const seedHost = (name: () => string, manifest: boolean) => async (s: Served) => {
  const h = await hostFetcher(s, name());
  await seedKit(h, join(acme, "generated/app.json"));
  if (manifest) {
    const r = await linkDynamic(h, { manifestText: acmeManifestText(), modulesDir: join(unitsOut, "modules") });
    if (r.status !== 200) throw new Error(`dynamic link failed: ${JSON.stringify(r.body)}`);
  }
  return name();
};
const TARGETS: Target[] = [
  { name: "whole-app", describe: "today's Worker: deploy/cloudflare/worker.ts with the whole app.json", scripts: async () => [wholeApp] },
  { name: "whole-app-repeat", describe: "A/A control: today's Worker again, fresh instance; its differences from whole-app are run-to-run nondeterminism", scripts: async () => [wholeApp] },
  { name: "packed", describe: "linker A, per-entry-point: 87 sliced scripts, router + dispatch owner", scripts: async () => scriptsOf(JSON.parse(readFileSync(join(linked, "per-entry-point/link.json"), "utf8")) as Link, join(linked, "per-entry-point")) },
  { name: "dynamic", describe: "linker B: the host (host/acme.ts) and its children from the Worker Loader, every entry point dynamic, its own dispatch child", scripts: async () => [await dynamicHostScript(join(linked, "dynamic-host"), env())], setup: seedHost(() => "forge-acme-linker-dynamic", true) },
  { name: "tiered", describe: "linker C: the order write path and ProcessOrder dynamic (linker B's host), everything else packed (linker A); one dispatch owner", scripts: async () => tieredScriptsOf(tiered(), join(linked, "tiered")), setup: seedHost(() => tiered().host.name, true), router: true },
  { name: "tiered-fallback", describe: "linker C with no dynamic manifest linked: every dynamic entry point and workflow step falls back to its packed script", scripts: async () => tieredScriptsOf(tiered(), join(linked, "tiered")), setup: seedHost(() => tiered().host.name, false), router: true },
];

function realtime(url: string): Promise<{ status: number | null; output: string }> {
  return new Promise((done) => {
    const p = spawn("pnpm", ["exec", "vitest", "run", "test/realtime.test.ts"], { cwd: join(root, "conformance"), env: { ...process.env, FORGE_TARGET_URL: url, FORGE_TARGET_WS: url.replace(/^http/, "ws") } });
    let output = "";
    p.stdout.on("data", (d) => (output += String(d)));
    p.stderr.on("data", (d) => (output += String(d)));
    p.on("close", (status) => done({ status, output }));
  });
}

const enabled = process.env["TIERED_DIFFERENTIAL"] === "1" && existsSync(join(linked, "tiered/tiered.json")) && existsSync(join(linked, "per-entry-point/link.json"));
const runs: Array<{ name: string; describe: string; scripts: number; startupMs: number; reports: Report[]; realtime: { passed: boolean; detail: string }; tier?: unknown; dynamicHost?: unknown }> = [];

describe.skipIf(!enabled)("linker differential over examples/acme: whole-app, A, B and C", () => {
  const scenarios = loadScenarios();
  const raceSteps = Object.fromEntries(scenarios.map((s) => [s.id, s.steps.filter((st) => "race" in st).map((st) => st.name)]));

  // As linker A's differential: a difference the whole-app Worker also shows against itself is
  // run-to-run nondeterminism; a list ordered only by generated id may order same-millisecond records
  // differently (explained only when the items are the same).
  const where = (d: Difference) => `${d.scenario}\0${d.step}\0${d.path}`;
  const classify = (a: Report[], b: Report[]) => {
    const repeat = runs.find((r) => r.name === "whole-app-repeat");
    const noiseAt = new Set(repeat ? compareReports(runs.find((r) => r.name === "whole-app")!.reports, repeat.reports, raceSteps).filter((d) => !d.explained).map(where) : []);
    const all = compareReports(a, b, raceSteps).map((d) => (!d.explained && idOrderOnly(a, b, d) ? { ...d, explained: true, key: "generated-id-order" } : d));
    return { explained: all.filter((d) => d.explained), noise: all.filter((d) => !d.explained && noiseAt.has(where(d))), unexplained: all.filter((d) => !d.explained && !noiseAt.has(where(d))) };
  };
  let idOrderedLists: Set<string> | undefined;
  const idOrdered = () => {
    if (idOrderedLists) return idOrderedLists;
    const appJson = JSON.parse(readFileSync(join(acme, "generated/app.json"), "utf8")) as { ir: { modules: Array<{ resources: Array<{ id: string; lists: Array<{ name: string; order: Array<{ field: string }> }> }> }> } };
    idOrderedLists = new Set(appJson.ir.modules.flatMap((m) => m.resources.flatMap((r) => r.lists.filter((l) => l.order.length === 1 && l.order[0]!.field === "id").map((l) => `${r.id}.list.${l.name}`))));
    return idOrderedLists;
  };
  const sortedItems = (v: unknown) => JSON.stringify(((v as { value?: { items?: unknown[] } })?.value?.items ?? []).map((x) => JSON.stringify(x).replace(/\$id:\d+|\b[a-z]+_[0-9a-z]{26}\b/g, "<id>")).sort());
  const idOrderOnly = (a: Report[], b: Report[], d: Difference) => {
    const step = scenarios.find((s) => s.id === d.scenario)?.steps.find((s) => s.name === d.step) as { op?: string } | undefined;
    if (!step?.op || !idOrdered().has(step.op)) return false;
    const [ra, rb] = [a.find((r) => r.scenario === d.scenario)?.results[d.step], b.find((r) => r.scenario === d.scenario)?.results[d.step]];
    return sortedItems(ra) === sortedItems(rb);
  };

  for (const t of TARGETS) {
    it(`runs every scenario against ${t.name}`, async () => {
      const scripts = await t.scripts();
      const t0 = performance.now();
      const served = await serve(scripts, env(), { secret: "t5-local-cursor-secret", migrations: join(acme, "migrations/d1") });
      try {
        const host = t.setup ? await t.setup(served) : null;
        const startupMs = Math.round(performance.now() - t0);
        const reports: Report[] = [];
        for (const s of scenarios) reports.push(await runScenario(s, new HttpTarget(client, served.url, t.name), { tenant: `t5-${s.id}` }));
        const rt = await realtime(served.url);
        const tail = rt.output.split("\n").filter((l) => /✓|✗|×|FAIL|passed|failed|Error/.test(l)).slice(-6).join("\n");
        const run: (typeof runs)[number] = { name: t.name, describe: t.describe, scripts: scripts.length, startupMs, reports, realtime: { passed: rt.status === 0, detail: tail } };
        if (t.router) {
          const st = await tierStats(served);
          const th = (await (await (await hostFetcher(served, host!)).fetch("/_linker/tier")).json()) as { stats: unknown };
          run.tier = { router: { dynamic: st.dynamic, packed: st.packed, fallback: st.fallback, errors: st.errors, byReason: st.byReason }, workflow: th.stats };
        }
        if (host) {
          const hs = (await (await (await hostFetcher(served, host)).fetch("/_linker/stats")).json()) as { closures: Array<{ label: string; privileged: boolean; cold: number; warm: number }>; denials: string[]; fallbacks: string[]; refused: string[] };
          run.dynamicHost = { distinctChildren: hs.closures.length, privilegedChildren: hs.closures.filter((c) => c.privileged).map((c) => c.label), dispatchChildren: hs.closures.filter((c) => c.label === "runtime:dispatch").length, denials: hs.denials, refused: [...new Set(hs.refused.map((r) => r.split(":")[0]))].sort() };
        }
        runs.push(run);
      } finally {
        await served.close();
      }
    }, 900_000);
  }

  afterAll(() => {
    if (!runs.length) return;
    const base = runs.find((r) => r.name === "whole-app");
    const pairs = runs
      .filter((r) => r !== base && base)
      .map((r) => {
        const c = classify(base!.reports, r.reports);
        return { a: base!.name, b: r.name, compared: base!.reports.reduce((n, x) => n + Object.keys(x.results).length, 0), explained: c.explained.length, explainedKeys: [...new Set(c.explained.map((d) => d.key))].sort(), runToRun: c.noise.length, unexplained: c.unexplained };
      });
    const out = {
      version: "r3-linker-differential/1",
      issue: "FORG-43",
      measured: true,
      local: true,
      date: new Date().toISOString().slice(0, 10),
      node: process.version,
      harness: { runtime: "workerd via Miniflare (one instance per target, in-memory D1/R2/Queues/Workflows/DOs, Worker Loader)", compatibilityDate: env().compatibility_date, explainedKeys: [...EXPLAINED_KEYS].sort() },
      policy: tiered().policy,
      dynamic: tiered().dynamic.map((d) => d.id),
      targets: runs.map((r) => ({
        name: r.name,
        describe: r.describe,
        scripts: r.scripts,
        startupMs: r.startupMs,
        scenarios: r.reports.map((x) => ({ id: x.scenario, steps: x.steps, passed: x.failures.length === 0, failures: x.failures })),
        passed: r.reports.filter((x) => !x.failures.length).length,
        failed: r.reports.filter((x) => x.failures.length).length,
        realtime: r.realtime,
        ...(r.tier ? { tier: r.tier } : {}),
        ...(r.dynamicHost ? { dynamicHost: r.dynamicHost } : {}),
      })),
      differential: pairs,
    };
    writeFileSync(join(results, "conformance.json"), `${JSON.stringify(out, null, 2)}\n`);
  });

  it("matches the whole-app Worker on every scenario, on every target", () => {
    for (const r of runs) {
      expect(r.reports.flatMap((x) => x.failures), r.name).toEqual([]);
      if (r.name.startsWith("whole-app")) continue;
      expect(classify(runs.find((x) => x.name === "whole-app")!.reports, r.reports).unexplained, r.name).toEqual([]);
    }
    const tier = runs.find((r) => r.name === "tiered")!.tier as { router: { dynamic: number; fallback: number; errors: number } };
    expect(tier.router.dynamic).toBeGreaterThan(0);
    expect([tier.router.fallback, tier.router.errors]).toEqual([0, 0]);
    const fb = runs.find((r) => r.name === "tiered-fallback")!.tier as { router: { dynamic: number; fallback: number; byReason: Record<string, number> } };
    expect(fb.router.dynamic).toBe(0);
    expect(Object.keys(fb.router.byReason)).toEqual(["NoManifest"]);
    expect((runs.find((r) => r.name === "tiered")!.dynamicHost as { dispatchChildren: number }).dispatchChildren).toBe(0);
  });
});
