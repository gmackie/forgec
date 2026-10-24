// Linker differential (FORG-29): the conformance scenarios against today's whole-app Worker and
// against linker-A output, each served locally in workerd (Miniflare), compared step by step with the
// conformance suite's own comparator. Heavy, so opt-in:
//
//   T3_DIFFERENTIAL=1 pnpm --filter @forgegraph/linker-packed exec vitest run test/differential.test.ts
//
// Expects research/composable-units/t3-linker-packed/run.sh to have linked the targets first.
// Writes research/composable-units/t3-linker-packed/results/conformance.json, or $LINK_RESULTS/conformance.json.
import { spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import * as client from "../../../conformance/fixtures/acme.client.ts";
import { compareReports, EXPLAINED_KEYS, type Difference } from "../../../conformance/src/differential.ts";
import { HttpTarget } from "../../../conformance/src/http-target.ts";
import { runScenario, type Report } from "../../../conformance/src/runner.ts";
import { loadScenarios } from "../../../conformance/src/scenarios.ts";
import { readJsonc, type Environment, type Link } from "../src/link.ts";
import { scriptsOf, serve, type LocalScript } from "../src/local.ts";

const root = resolve(import.meta.dirname, "../../..");
const app = join(root, "examples/acme");
const linked = join(app, "generated/linked");
const results = resolve(process.env["LINK_RESULTS"] ?? join(root, "research/composable-units/t3-linker-packed/results"));
const env = readJsonc(join(app, "deploy/cloudflare/wrangler.jsonc")) as Environment;

const wholeApp: LocalScript = {
  name: "forge-acme",
  scriptPath: join(linked, "whole-app/worker.js"),
  bindings: ["DB", "BLOBS", "REALTIME", "Q_FULFILL_ORDER", "WF_PROCESS_ORDER", "CURSOR_SECRET", "FORGE_AUTH", "FORGE_CORS"],
  queues: ["forge-acme-commerce-fulfill-order"],
  classes: { workflows: [{ className: "ProcessOrderWorkflow" }], realtime: "ForgeRealtime" },
  services: {},
};
const fromLink = (name: string) => () => scriptsOf(JSON.parse(readFileSync(join(linked, name, "link.json"), "utf8")) as Link, join(linked, name));
const TARGETS: Array<{ name: string; describe: string; scripts: () => LocalScript[] }> = [
  { name: "whole-app", describe: "today's Worker: deploy/cloudflare/worker.ts with the whole app.json", scripts: () => [wholeApp] },
  { name: "whole-app-repeat", describe: "A/A control: today's Worker again, fresh instance; its differences from whole-app are run-to-run nondeterminism", scripts: () => [wholeApp] },
  { name: "single", describe: "linker A, strategy single: one script rebuilt from the manifest", scripts: fromLink("single") },
  { name: "per-entry-point", describe: "linker A, strategy per-entry-point, sliced app.json, router + dispatch owner", scripts: fromLink("per-entry-point") },
  { name: "per-entry-point-full", describe: "control: per-entry-point with the whole app.json in every script (separates splitting from slicing)", scripts: fromLink("per-entry-point-full") },
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

const enabled = process.env["T3_DIFFERENTIAL"] === "1" && existsSync(join(linked, "per-entry-point-full/link.json"));
const runs: Array<{ name: string; describe: string; scripts: number; startupMs: number; reports: Report[]; realtime: { passed: boolean; detail: string } }> = [];

describe.skipIf(!enabled)("linker differential over examples/acme", () => {
  const scenarios = loadScenarios();
  const raceSteps = Object.fromEntries(scenarios.map((s) => [s.id, s.steps.filter((st) => "race" in st).map((st) => st.name)]));

  // A difference the whole-app Worker also shows against itself (fresh ids, hashes over them,
  // timestamps) is run-to-run nondeterminism, not a linker difference.
  const where = (d: Difference) => `${d.scenario}\0${d.step}\0${d.path}`;
  const classify = (a: Report[], b: Report[]) => {
    const repeat = runs.find((r) => r.name === "whole-app-repeat");
    const noiseAt = new Set(repeat ? compareReports(runs.find((r) => r.name === "whole-app")!.reports, repeat.reports, raceSteps).filter((d) => !d.explained).map(where) : []);
    const all = compareReports(a, b, raceSteps).map((d) => (!d.explained && idOrderOnly(a, b, d) ? { ...d, explained: true, key: "generated-id-order" } : d));
    return { explained: all.filter((d) => d.explained), noise: all.filter((d) => !d.explained && noiseAt.has(where(d))), unexplained: all.filter((d) => !d.explained && !noiseAt.has(where(d))) };
  };

  // A list ordered only by its generated id returns records created in the same millisecond in an
  // order fixed by fresh random ids: same items, run-dependent order. Explained only in that case.
  // Read lazily: vitest collects a skipped describe's body too, and a fresh checkout has no
  // generated app.json until the opt-in run builds it.
  let idOrderedLists: Set<string> | undefined;
  const idOrdered = () => {
    if (idOrderedLists) return idOrderedLists;
    const appJson = JSON.parse(readFileSync(join(app, "generated/app.json"), "utf8")) as { ir: { modules: Array<{ resources: Array<{ id: string; lists: Array<{ name: string; order: Array<{ field: string }> }> }> }> } };
    idOrderedLists = new Set(appJson.ir.modules.flatMap((m) => m.resources.flatMap((r) => r.lists.filter((l) => l.order.length === 1 && l.order[0]!.field === "id").map((l) => `${r.id}.list.${l.name}`))));
    return idOrderedLists;
  };
  // The runner numbers ids it has seen (`$id:n`, by first appearance) and leaves ids it never saw raw
  // (records a changeset created): either way the id text differs between runs, so compare without it.
  const sortedItems = (v: unknown) => JSON.stringify(((v as { value?: { items?: unknown[] } })?.value?.items ?? []).map((x) => JSON.stringify(x).replace(/\$id:\d+|\b[a-z]+_[0-9a-z]{26}\b/g, "<id>")).sort());
  const idOrderOnly = (a: Report[], b: Report[], d: Difference) => {
    const step = scenarios.find((s) => s.id === d.scenario)?.steps.find((s) => s.name === d.step) as { op?: string } | undefined;
    if (!step?.op || !idOrdered().has(step.op)) return false;
    const [ra, rb] = [a.find((r) => r.scenario === d.scenario)?.results[d.step], b.find((r) => r.scenario === d.scenario)?.results[d.step]];
    return sortedItems(ra) === sortedItems(rb);
  };

  for (const t of TARGETS) {
    it(`runs every scenario against ${t.name}`, async () => {
      const scripts = t.scripts();
      const t0 = performance.now();
      const served = await serve(scripts, env, { secret: "t3-local-cursor-secret", migrations: join(app, "migrations/d1") });
      const startupMs = Math.round(performance.now() - t0);
      try {
        const reports: Report[] = [];
        // One tenant per scenario, the same on every target: each target has its own database.
        for (const s of scenarios) reports.push(await runScenario(s, new HttpTarget(client, served.url, t.name), { tenant: `t3-${s.id}` }));
        const rt = await realtime(served.url);
        const tail = rt.output.split("\n").filter((l) => /✓|✗|×|FAIL|passed|failed|Error/.test(l)).slice(-6).join("\n");
        runs.push({ name: t.name, describe: t.describe, scripts: scripts.length, startupMs, reports, realtime: { passed: rt.status === 0, detail: tail } });
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
      version: "t3-linker-differential/1",
      issue: "FORG-29",
      measured: true,
      harness: { runtime: "workerd via Miniflare (one instance per target, in-memory D1/R2/Queues/Workflows/DOs)", compatibilityDate: env.compatibility_date, explainedKeys: [...EXPLAINED_KEYS].sort() },
      targets: runs.map((r) => ({
        name: r.name,
        describe: r.describe,
        scripts: r.scripts,
        startupMs: r.startupMs,
        scenarios: r.reports.map((x) => ({ id: x.scenario, steps: x.steps, passed: x.failures.length === 0, failures: x.failures })),
        passed: r.reports.filter((x) => !x.failures.length).length,
        failed: r.reports.filter((x) => x.failures.length).length,
        realtime: r.realtime,
      })),
      differential: pairs,
    };
    writeFileSync(join(results, "conformance.json"), `${JSON.stringify(out, null, 2)}\n`);
  });

  it("matches the whole-app Worker on every scenario", () => {
    // Asserted after the runs (vitest runs `it`s in order): every target passes every scenario, and
    // differs from the whole-app Worker only where the conformance comparator explains it or where the
    // whole-app Worker also differs from itself (A/A).
    for (const r of runs) {
      expect(r.reports.flatMap((x) => x.failures), r.name).toEqual([]);
      if (r.name.startsWith("whole-app")) continue;
      expect(classify(runs.find((x) => x.name === "whole-app")!.reports, r.reports).unexplained, r.name).toEqual([]);
    }
  });
});
