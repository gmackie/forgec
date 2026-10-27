import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve, join } from 'node:path';
import { planCatalog } from '../src/index.mjs';
const repo = resolve(fileURLToPath(new URL('../../..', import.meta.url)));
const contractDirectory = join(repo, 'packages/foundation');
// Standalone source-archive tests use fake contracts; the actual repo test is
// REQUIRED whenever this package is installed in the Forge workspace.
test('all composition roots resolve against actual Foundation contracts', {skip: !existsSync(contractDirectory)}, () => {
  const catalog = JSON.parse(readFileSync(new URL('../catalog/systems.json', import.meta.url), 'utf8'));
  const contracts = readdirSync(contractDirectory, {withFileTypes:true}).filter(x=>x.isDirectory()).map(x=>
    JSON.parse(readFileSync(join(contractDirectory, x.name, 'contract.json'), 'utf8')));
  const plans = planCatalog(catalog, contracts);
  assert.equal(plans.length, 10);
  assert.ok(plans.every(p => p.foundation.length >= 1));
  assert.ok(plans.every(p => p.readiness.executionReady === false));
});
