#!/usr/bin/env node
// forge-link-packed <app> [--strategy per-entry-point|per-entry-point-shared|single] [--manifest <dir>] [--env <wrangler.jsonc>] [--out <dir>] [--full-app-json]
// Run `forgec build <app> --units` and the units sealer first.
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { link } from "./link.ts";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { strategy: { type: "string", default: "per-entry-point" }, manifest: { type: "string" }, env: { type: "string" }, out: { type: "string" }, "full-app-json": { type: "boolean", default: false } },
});
const app = resolve(positionals[0] ?? ".");
const out = resolve(values.out ?? `${app}/generated/linked/${values.strategy}`);
const result = await link({
  app,
  manifestDir: resolve(values.manifest ?? `${app}/generated/units`),
  environment: resolve(values.env ?? `${app}/deploy/cloudflare/wrangler.jsonc`),
  strategy: values.strategy!,
  out,
  appJson: values["full-app-json"] ? "full" : "slice",
});
const total = result.scripts.reduce((n, s) => n + (s.bytes?.raw ?? 0), 0);
console.log(`${result.package.name} @ ${result.manifestHash}: ${result.scripts.length} scripts${result.router ? " + router" : ""} (${result.strategy}), ${total} bytes -> ${out}`);
for (const s of result.scripts) console.log(`  ${s.name.padEnd(60)} ${String(s.bytes?.raw ?? "-").padStart(8)} ${s.slice.mode.padEnd(8)} ${s.dispatch}`);
