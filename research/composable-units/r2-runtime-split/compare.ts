// FORG-37: results/summary.json from the FORG-29 baseline (../t3-linker-packed/results) and this
// spike's results/before.json (main before the split) and results/after.json (the split).
//   node research/composable-units/r2-runtime-split/compare.ts
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { stableJson } from "../../../packages/units/src/index.ts";

const here = import.meta.dirname;
const read = (p: string) => JSON.parse(readFileSync(join(here, p), "utf8"));
const t3 = read("../t3-linker-packed/results/sizes.json").measured;
const t3edit = read("../t3-linker-packed/results/edits.json").measured;
const bodyKey = Object.keys(t3edit).find((k) => k.startsWith("impl body"))!;
type Row = { wholeApp: { raw: number; gzip: number }; single: number; perScriptRaw: unknown; perScriptGzip: unknown; deployRaw: number; deployGzip: number; bodyEdit: { scripts: number; raw: number; gzip: number }; singleBodyEdit: { raw: number; gzip: number } };
const row = (m: any): Row => ({
  wholeApp: m.wholeAppWorker.bytes,
  single: m.strategies.single.raw.max,
  perScriptRaw: m.strategies["per-entry-point"].raw,
  perScriptGzip: m.strategies["per-entry-point"].gzip,
  deployRaw: m.strategies["per-entry-point"].deployRaw,
  deployGzip: m.strategies["per-entry-point"].deployGzip,
  bodyEdit: { scripts: m.bodyEdit["per-entry-point"].reuploaded, raw: m.bodyEdit["per-entry-point"].reuploadedRaw, gzip: m.bodyEdit["per-entry-point"].reuploadedGzip },
  singleBodyEdit: { raw: m.bodyEdit.single.reuploadedRaw, gzip: m.bodyEdit.single.reuploadedGzip },
});
const forg29: Row = {
  wholeApp: t3.wholeAppWorker.bytes,
  single: t3.strategies.single.raw.max,
  perScriptRaw: t3.strategies["per-entry-point"].raw,
  perScriptGzip: t3.strategies["per-entry-point"].gzip,
  deployRaw: t3.strategies["per-entry-point"].deployRaw,
  deployGzip: t3.strategies["per-entry-point"].deployGzip,
  bodyEdit: { scripts: t3edit[bodyKey].perStrategy["per-entry-point"].reuploaded, raw: t3edit[bodyKey].perStrategy["per-entry-point"].reuploadedRaw, gzip: t3edit[bodyKey].perStrategy["per-entry-point"].reuploadedGzip },
  singleBodyEdit: { raw: t3edit[bodyKey].perStrategy.single.reuploadedRaw, gzip: t3edit[bodyKey].perStrategy.single.reuploadedGzip },
};
const before = read("results/before.json");
const after = read("results/after.json");
const rep = (m: any) => Object.fromEntries(Object.entries(m.representative as Record<string, any>).map(([k, v]) => [k, { what: v.what, features: v.features, raw: v.raw, gzip: v.gzip, runtime: v.runtime, effect: v.effect, runtimeModules: v.runtimeModules }]));
const pct = (a: number, b: number) => Math.round(((b - a) / a) * 1000) / 10;
const a = row(after.measured);
writeFileSync(
  join(here, "results/summary.json"),
  stableJson({
    version: "r2-runtime-split-summary/1",
    issue: "FORG-37",
    rows: { "FORG-29 (t3 results)": forg29, [`before (${before.commit})`]: row(before.measured), [`after (${after.commit})`]: a },
    changeVsForg29Percent: {
      perScriptRawMedian: pct((forg29.perScriptRaw as any).median, (a.perScriptRaw as any).median),
      perScriptGzipMedian: pct((forg29.perScriptGzip as any).median, (a.perScriptGzip as any).median),
      perScriptRawMin: pct((forg29.perScriptRaw as any).min, (a.perScriptRaw as any).min),
      deployRaw: pct(forg29.deployRaw, a.deployRaw),
      deployGzip: pct(forg29.deployGzip, a.deployGzip),
      bodyEditRaw: pct(forg29.bodyEdit.raw, a.bodyEdit.raw),
      bodyEditGzip: pct(forg29.bodyEdit.gzip, a.bodyEdit.gzip),
    },
    representative: { before: rep(before.measured), after: rep(after.measured) },
  }),
);
console.log(JSON.stringify({ forg29, after: a }, null, 1));
