import test from 'node:test';
import assert from 'node:assert/strict';
import { planSystem, planCatalog, validateCatalog, digest } from '../src/index.mjs';
import { readFileSync } from 'node:fs';
const catalog = JSON.parse(readFileSync(new URL('../catalog/systems.json', import.meta.url)));
const slugs = new Set(catalog.systems.flatMap(s => s.foundation));
const contracts = [...slugs].map(slug => ({ slug, layer: 'system', dependencies: [], acceptance: [{id: 'test', status: 'passing'}] }));

test('all ten systems declare typed ports, operations, owners, and invariants', () => {
  assert.equal(validateCatalog(catalog), catalog);
  assert.equal(catalog.systems.length, 10);
  assert.equal(new Set(catalog.systems.map(s => s.id)).size, 10);
});
test('plans are deterministic and never claim execution or provider certification', () => {
  const one = planCatalog(catalog, contracts), two = planCatalog(catalog, [...contracts].reverse());
  assert.deepEqual(one, two);
  assert.equal(one.length, 10);
  for (const plan of one) {
    assert.equal(plan.readiness.executionReady, false);
    assert.equal(plan.readiness.hostedProvider, 'unverified');
    assert.equal(plan.readiness.applicationIntegration, 'unverified');
  }
});
test('closure includes transitive contracts in dependency order', () => {
  const cs = contracts.map(c => c.slug === 'risk' ? {...c, dependencies: ['evidence']} : c);
  const plan = planSystem(catalog, cs, 'change-intelligence');
  assert.ok(plan.foundation.findIndex(c => c.slug === 'evidence') < plan.foundation.findIndex(c => c.slug === 'risk'));
});
test('missing transitive module fails, not a partial plan', () => {
  const cs = contracts.map(c => c.slug === 'risk' ? {...c, dependencies: ['missing']} : c);
  assert.throws(() => planSystem(catalog, cs, 'change-intelligence'), /missing Foundation contract/);
});
test('Foundation cycles fail closed', () => {
  const cs = contracts.map(c => c.slug === 'risk' ? {...c, dependencies: ['change']} : c.slug === 'change' ? {...c, dependencies: ['risk']} : c);
  assert.throws(() => planSystem(catalog, cs, 'change-intelligence'), /cycle/);
});
test('blocked Foundation acceptance remains visible', () => {
  const cs = contracts.map(c => c.slug === 'change' ? {...c, acceptance: [{id: 'STORE', status: 'planned'}]} : c);
  assert.deepEqual(planSystem(catalog, cs, 'change-intelligence').readiness.missingLocalAcceptance, ['change:STORE:planned']);
});
test('rejects unknown operation owners, incorrect command ports, and duplicate IDs', () => {
  const edited = structuredClone(catalog); edited.systems[0].operations[0].owner = 'magic';
  assert.throws(() => validateCatalog(edited), /unresolved operation owner/);
  const readonly = structuredClone(catalog); readonly.systems[0].ports[0].mode = 'query'; readonly.systems[0].operations[1].owner = 'work';
  assert.throws(() => validateCatalog(readonly), /non-command port/);
  const dupe = structuredClone(catalog); dupe.systems.push(dupe.systems[0]);
  assert.throws(() => validateCatalog(dupe), /duplicate system/);
});
test('stable fingerprints disregard map key order, not semantic changes', () => {
  assert.equal(digest({a: 1, b: {c: 2}}), digest({b: {c: 2}, a: 1}));
  assert.notEqual(digest({a:1}), digest({a:2}));
});
