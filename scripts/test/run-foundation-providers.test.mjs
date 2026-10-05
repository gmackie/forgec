import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { providerEnvironment } from '../run-foundation-providers.mjs';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'foundation-runner-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'd1-core'), { mode: 0o700 });
  const write = (path, value) => writeFileSync(join(root, path), typeof value === 'string' ? value : JSON.stringify(value), { mode: 0o600 });
  write('setup.json', { version: 1, awsProfile: 'test', postgresUrlFile: 'postgres-url', dynamodb: 'dynamodb.json', d1: { core: 'd1-core/infrastructure.json' } });
  write('postgres-url', 'postgres://test:test@127.0.0.1:55479/test');
  write('dynamodb.json', { provider: 'dynamodb', status: 'ready', production: false, environment: { AWS_REGION: 'us-east-1', FORGE_FOUNDATION_DYNAMO_TABLE: 'forge-foundation-test-example' } });
  write('d1-core/token', 'private-test-token');
  write('d1-core/infrastructure.json', { provider: 'd1', profile: 'core', status: 'ready', production: false, tokenFile: join(root, 'd1-core/token'), environment: { FORGE_FOUNDATION_D1_URL: 'https://foundation-test.example.workers.dev' } });
  return { root, write };
}
test('loads named provider references and keeps credentials out of commands', t => {
  const { root } = fixture(t);
  const d1 = providerEnvironment(root, 'd1', 'core', {});
  assert.equal(d1.FORGE_FOUNDATION_D1_TOKEN, 'private-test-token');
  assert.equal(providerEnvironment(root, 'dynamodb', 'core', {}).AWS_PROFILE, 'test');
  assert.match(providerEnvironment(root, 'postgres', 'core', {}).FORGE_FOUNDATION_PG_URL, /^postgres:/);
});
test('does not substitute a core D1 deployment for a package profile', t => {
  const { root } = fixture(t);
  assert.throws(() => providerEnvironment(root, 'd1', 'notifications', {}), /No D1 state for profile notifications/);
});
test('refuses public tokens, path escapes and unfinished resource receipts', t => {
  const { root, write } = fixture(t);
  chmodSync(join(root, 'd1-core/token'), 0o644);
  assert.throws(() => providerEnvironment(root, 'd1', 'core', {}), /private/);
  write('setup.json', {version:1,postgresUrlFile:'../outside'});
  assert.throws(() => providerEnvironment(root, 'postgres', 'core', {}), /outside/);
  write('setup.json', {version:1,dynamodb:'dynamodb.json',awsProfile:'test'});
  write('dynamodb.json', {provider:'dynamodb',status:'provisioning',production:false});
  assert.throws(() => providerEnvironment(root, 'dynamodb', 'core', {}), /ready/);
});
test('refuses ambient endpoint overrides and static AWS keys instead of silently overriding a profile', t => {
  const { root } = fixture(t);
  assert.throws(() => providerEnvironment(root, 'dynamodb', 'core', {AWS_ENDPOINT_URL:'http://localhost:8000'}), /endpoint/);
  assert.throws(() => providerEnvironment(root, 'dynamodb', 'core', {AWS_ACCESS_KEY_ID:'example'}), /AWS_PROFILE/);
});
