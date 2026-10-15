import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkIdentities } from '../check-package-identities.mjs';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'forge-identities-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const repository = 'git+https://git.forgegraf.com/gmackie/forge.git';
  const policy = { repository, publicPackages: { '@forgegraph/registry': 'packages/registry' } };
  const write = (dir, changes = {}) => {
    mkdirSync(join(root, dir), { recursive: true });
    writeFileSync(join(root, dir, 'package.json'), JSON.stringify({ name: '@forgegraph/registry', repository: { url: repository, directory: dir }, publishConfig: { access: 'public' }, ...changes }));
  };
  write('packages/registry');
  return { root, policy, write };
}
test('keeps the existing SDK identity without a migration for consumers', t => {
  const { root, policy, write } = fixture(t);
  write('packages/console', { name: '@forgegraph/console', private: true });
  assert.deepEqual(checkIdentities(root, policy), []);
});
test('rejects public/private collisions and wrong source ownership', t => {
  const { root, policy, write } = fixture(t);
  write('packages/service', { private: true });
  write('packages/registry', { repository: { url: 'git+https://example.invalid/other', directory: 'packages/registry' } });
  const errors = checkIdentities(root, policy);
  assert(errors.some(x => x.includes('duplicate package identity')));
  assert(errors.some(x => x.includes('canonical source owner')));
});
test('rejects unknown publication names and missing or privatized owners', t => {
  const { root, policy, write } = fixture(t);
  write('packages/registry', { private: true });
  write('packages/extra', { name: '@forgegraph/unreviewed' });
  policy.publicPackages['@forgegraph/missing'] = 'packages/missing';
  const errors = checkIdentities(root, policy);
  assert(errors.some(x => x.includes('renamed or private')));
  assert(errors.some(x => x.includes('no matching owner')));
  assert(errors.some(x => x.includes('owning package is missing')));
});
