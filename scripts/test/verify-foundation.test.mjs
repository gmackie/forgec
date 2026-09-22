import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateContracts } from '../verify-foundation.mjs';
const contract = (slug, issue = 26, dependencies = [], layer = 'substrate') => ({ slug, issue, dependencies, layer, facts: ['fact'], operations: ['create'], invariants: ['invariant'], fixtures: ['fixture'], acceptance: [{ id: `${slug}-01`, description: 'verify', kind: 'runtime', status: 'planned' }] });
const validate = cs => validateContracts(cs, { complete: false });
test('dependency order is deterministic and accepts a diamond', () => {
  const cs = [contract('root'), contract('left', 27, ['root']), contract('right', 28, ['root']), contract('top', 39, ['left', 'right'], 'system')];
  assert.deepEqual(validate(cs).errors, []);
  assert.deepEqual(validate(cs).order, validate(cs.toReversed()).order);
  assert.ok(validate(cs).order.indexOf('root') < validate(cs).order.indexOf('top'));
});
test('cycles, missing edges and substrate-to-system edges fail', () => {
  assert.match(validate([contract('one', 26, ['two']), contract('two', 27, ['one'])]).errors.join(), /dependency cycle/);
  assert.match(validate([contract('one', 26, ['missing'])]).errors.join(), /unknown dependency/);
  assert.match(validate([contract('one', 26, ['two']), contract('two', 39, [], 'system')]).errors.join(), /substrate cannot/);
});
test('complete catalog requires every child issue and unique acceptance IDs', () => {
  assert.match(validateContracts([contract('one')]).errors.join(), /missing issue #50/);
  const a = contract('one'), b = contract('two', 27); b.acceptance[0].id = a.acceptance[0].id;
  assert.match(validate([a,b]).errors.join(), /duplicate acceptance/);
});
test('passing requires evidence and malformed cases fail', () => {
  const a = contract('one'); a.acceptance[0].status = 'passing';
  assert.match(validate([a]).errors.join(), /passing requires evidence/);
  a.acceptance[0] = null;
  assert.ok(validate([a]).errors.length > 0);
});
