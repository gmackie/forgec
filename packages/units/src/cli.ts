#!/usr/bin/env node
// forge-units <app> [--plan <unit plan>] [--out <dir>]
// Run `forgec build <app> --units` first; this bundles impl/ per unit and seals the manifest.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { seal, writeSealed, type UnitPlan } from "./seal.ts";

const { values, positionals } = parseArgs({ allowPositionals: true, options: { plan: { type: "string" }, out: { type: "string" } } });
const app = resolve(positionals[0] ?? ".");
const out = resolve(values.out ?? `${app}/generated/units`);
const plan = JSON.parse(readFileSync(resolve(values.plan ?? `${out}/plan.json`), "utf8")) as UnitPlan;
const sealed = await seal(plan, app);
writeSealed(sealed, out);
const m = sealed.manifest;
const kinds = Object.values(m.units).reduce<Record<string, number>>((acc, u) => ({ ...acc, [u.kind]: (acc[u.kind] ?? 0) + 1 }), {});
console.log(`${m.package.name}: ${Object.keys(m.units).length} units (${Object.entries(kinds).map(([k, n]) => `${n} ${k}`).join(", ")}), ${Object.keys(m.modules).length} modules, ${m.entryPoints.length} entry points`);
console.log(`manifest ${m.manifestHash} -> ${out}/manifest.json`);
