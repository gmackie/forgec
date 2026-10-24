// FORG-33: Linker B's conformance differential, run as T4 ran it (the conformance section of
// research/composable-units/t4-linker-dynamic/measure.ts): the scenarios through the generated
// client against today's whole-app Worker, the Linker B host in strict mode, and the host with the
// reported whole-app fallback enabled, each on local workerd with fresh D1. Run from the repository
// root after `cargo build -p forgegraph-cli`, `pnpm install` and `pnpm -r run build`:
//   node research/composable-units/r2-coverage/conformance-dynamic.ts
// Writes results/linker-dynamic.json.
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { stableJson } from "../../../packages/units/src/index.ts";
// @ts-expect-error untyped harness module
import * as harness from "../../../packages/linker-dynamic/scripts/harness.mjs";

const h = harness as any;
const here = import.meta.dirname;

async function runConformance(base: string, name: string) {
  const code = await new Promise<number>((resolve) => {
    const p = spawn("pnpm", ["vitest", "run", "test/remote.test.ts"], { cwd: join(h.root, "conformance"), env: { ...process.env, FORGE_TARGET_URL: base, FORGE_TARGET_NAME: name }, stdio: "ignore" });
    p.on("close", (c) => resolve(c ?? 1));
  });
  const report = JSON.parse(readFileSync(join(h.root, "conformance/reports", `${name}.json`), "utf8")) as { scenarios: Array<{ id: string; steps: number; failures: Array<{ step: string; actual: any }> }> };
  const scenarios = report.scenarios
    .map((s) => ({ id: s.id, steps: s.steps, failures: s.failures.length, failureCodes: [...new Set(s.failures.map((f) => String((f.actual as { code?: string } | null)?.code ?? "value")))].sort(), passed: s.failures.length === 0 }))
    .sort((a, b) => (a.id < b.id ? -1 : 1));
  return { exitCode: code, passed: scenarios.filter((s) => s.passed).length, total: scenarios.length, steps: scenarios.reduce((n, s) => n + s.steps, 0), scenarios };
}

h.prepare({ force: true });
const manifest = JSON.parse(readFileSync(join(h.unitsOut, "manifest.json"), "utf8")) as { manifestHash: string; uncovered: unknown[]; entryPoints: Array<{ id: string; closureHash: string }> };
const sweepClosure = manifest.entryPoints.find((e) => e.id === "forge:sweep")!.closureHash;
const targets: Record<string, unknown> = {};
for (const [name, kind, vars] of [
  ["whole-app-local", "whole-app", {}],
  ["linker-dynamic-strict", "host", {}],
  ["linker-dynamic-fallback", "host", { LINKER_UNCOVERED: "runtime" }],
] as const) {
  const w = await h.startWorker({ kind, port: 8963, vars });
  try {
    if (kind === "host") {
      await h.seedKit(w.base);
      const linked = await h.linkManifest(w.base);
      if (linked.status !== 200) throw new Error(`link failed: ${JSON.stringify(linked.body)}`);
    }
    const result: Record<string, unknown> = await runConformance(w.base, name);
    if (kind === "host") {
      const st = await h.stats(w.base);
      result["linker"] = {
        distinctChildren: st.closures.length,
        privilegedChildren: st.closures.filter((x: any) => x.privileged).map((x: any) => x.label),
        childLabels: [...new Set(st.closures.map((x: any) => x.label.split(":")[0]))].sort(),
        // The post-commit dispatch() child: narrowed to the sweep entry point's closure (FORG-33).
        dispatchChildren: st.closures.filter((x: any) => x.label === "runtime:dispatch").map((x: any) => ({ closureHash: x.closureHash, isSweepClosure: x.closureHash === sweepClosure, privileged: x.privileged, calls: x.cold + x.warm })),
        denials: st.denials,
        fallbacks: st.fallbacks,
        refused: [...new Set(st.refused)].sort(),
      };
    }
    targets[name] = result;
    console.log(name, `${(result as any).passed}/${(result as any).total}`, kind === "host" ? JSON.stringify({ denials: (result as any).linker.denials.length, fallbacks: (result as any).linker.fallbacks.length, refused: (result as any).linker.refused.length }) : "");
  } finally {
    await w.stop();
  }
}
writeFileSync(join(here, "results/linker-dynamic.json"), stableJson({ version: "r2-linker-dynamic/1", issue: "FORG-33", local: true, date: new Date().toISOString().slice(0, 10), node: process.version, manifestHash: manifest.manifestHash, uncovered: manifest.uncovered, targets }));
