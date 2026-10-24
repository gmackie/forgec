#!/usr/bin/env node
// forge-link-tiered <app> [--policy <tiered-policy.json>] [--manifest <dir>] [--env <wrangler.jsonc>] [--out <dir>]
// Run `forgec build <app> --units` and the units sealer first.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { linkTiered } from "./link.ts";
import type { DynamicPolicy } from "./policy.ts";

const { values, positionals } = parseArgs({ allowPositionals: true, options: { policy: { type: "string" }, manifest: { type: "string" }, env: { type: "string" }, out: { type: "string" } } });
const app = resolve(positionals[0] ?? ".");
const out = resolve(values.out ?? `${app}/generated/linked/tiered`);
const policy = JSON.parse(readFileSync(resolve(values.policy ?? `${app}/deploy/cloudflare/tiered-policy.json`), "utf8")) as DynamicPolicy;
const t = await linkTiered({ app, manifestDir: resolve(values.manifest ?? `${app}/generated/units`), environment: resolve(values.env ?? `${app}/deploy/cloudflare/wrangler.jsonc`), out, policy });
console.log(`${t.package.name} @ ${t.manifestHash}: ${t.packed.scripts.length} packed scripts + ${t.router.name} + ${t.host.name} -> ${out}`);
console.log(`dynamic (${t.dynamic.length}):`);
for (const d of t.dynamic) console.log(`  ${d.id.padEnd(56)} ${d.kind.padEnd(14)} fallback ${d.packedScript}`);
console.log(`dispatch owner: ${t.packed.dispatchOwner}`);
