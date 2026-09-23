import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateContracts, validateCatalogs } from '../verify-foundation.mjs';
const contract = (slug, issue = 26, dependencies = [], layer = 'substrate') => ({ slug, issue, dependencies, layer, facts: ['fact'], operations: ['create'], invariants: ['invariant'], fixtures: ['fixture'], acceptance: [{ id: `${slug}-01`, description: 'verify', kind: 'runtime', status: 'planned' }] });
const validate = cs => validateContracts(cs, { complete: false, expectedScope: cs.filter(Boolean).map(c => ({issue: c.issue, slug: c.slug, layer: c.layer})) });
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

test('catalog drift fails even when contracts are valid', () => {
  const c = contract('one');
  const catalogs = {
    substrate: {schemaVersion: 1, layer: 'substrate', packages: [{slug: c.slug, issue: c.issue, dependencies: [], contract: 'packages/foundation/one/contract.json', acceptanceIds: ['one-01']}]},
    system: {schemaVersion: 1, layer: 'system', packages: []},
  };
  assert.deepEqual(validateCatalogs([c], catalogs), []);
  catalogs.substrate.packages[0].dependencies.push('missing');
  assert.match(validateCatalogs([c], catalogs).join(), /catalog does not match/);
});


test('local passing acceptance names existing evidence and rejects missing or unsafe paths', () => {
  const c = contract('specification');
  Object.assign(c.acceptance[0], { status: 'passing', verification: 'local', evidence: ['packages/runtime/test/foundation-specification.test.ts'] });
  assert.deepEqual(validate([c]).errors, []);
  for (const path of ['packages/runtime/test/foundation-missing.test.ts', '../outside.test.ts']) {
    c.acceptance[0].evidence = [path];
    assert.match(validate([c]).errors.join(), /requires evidence/);
  }
});

test('expanded scope includes new Foundation packages but excludes PR51 and does not infer layer from number', () => {
  const party = contract('party', 52, [], 'substrate');
  assert.deepEqual(validateContracts([party], {complete:false}).errors, []);
  assert.match(validateContracts([contract('pull-request', 51)], {complete:false}).errors.join(), /invalid or duplicate issue/);
  assert.match(validateContracts([{...party, layer:'system'}], {complete:false}).errors.join(), /issue\/slug\/layer/);
  assert.match(validateContracts([], {}).errors.join(), /missing issue #67/);
  for (const [slug, issue, layer] of [['resource-relations',79,'substrate'],['settlement',80,'system']]) {
    assert.deepEqual(validateContracts([contract(slug, issue, [], layer)], {complete:false}).errors, []);
    assert.match(validateContracts([], {}).errors.join(), new RegExp(`missing issue #${issue}`));
  }
});
