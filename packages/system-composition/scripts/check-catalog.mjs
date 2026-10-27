#!/usr/bin/env node
/**
 * Read-only check against the current Foundation catalog. Run from any cwd:
 * node packages/system-composition/scripts/check-catalog.mjs [--json]
 */
import { readFileSync, readdirSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { planCatalog } from '../src/index.mjs';
const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../../..');
const foundation = join(root, 'packages/foundation');
const catalog = JSON.parse(readFileSync(resolve(here, '../catalog/systems.json'), 'utf8'));
const contracts = readdirSync(foundation, { withFileTypes: true }).filter(x => x.isDirectory()).map(x => {
  const path = join(foundation, x.name, 'contract.json');
  try { return JSON.parse(readFileSync(path, 'utf8')); }
  catch (error) { throw new Error(`invalid/missing contract: ${path}: ${error.message}`); }
});
const plans = planCatalog(catalog, contracts);
if (process.argv.includes('--json')) console.log(JSON.stringify({ schema: 'forge-system-catalog/1', plans }, null, 2));
else {
  for (const p of plans) {
    const missing = p.readiness.missingLocalAcceptance.length;
    console.log(`${p.system.padEnd(23)} ${String(p.foundation.length).padStart(2)} Foundation packages, ${missing} pending local claims; host + app integration unverified`);
  }
  console.log(`Checked ${plans.length} systems against ${contracts.length} Foundation contracts. No deployments or authorizations performed.`);
}
