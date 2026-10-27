import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
test('synthetic change/approval/delivery flow does not equate submit with approval or deploy with convergence', () => {
  const result = spawnSync(process.execPath, [fileURLToPath(new URL('../examples/change-lifecycle.mjs', import.meta.url))], {encoding:'utf8'});
  assert.equal(result.status,0,result.stderr);
  assert.match(result.stdout,/Six-stage synthetic cross-system scenario passed/);
});
