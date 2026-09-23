#!/usr/bin/env node
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { fingerprint } from './foundation-state.mjs';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const sha = value => createHash('sha256').update(value).digest('hex');
export const traceIds = ['capacity-race-and-restart', 'authorized-atomic-rollback', 'exact-ledger-reversal', 'usage-retry-and-isolation', 'terminal-absence-guard-race'];
export function providerConfiguration(provider, env) {
  if (!['postgres', 'd1', 'dynamodb'].includes(provider)) throw new Error('Select --provider postgres, d1, dynamodb or all');
  const requireName = name => { if (!env[name]) throw new Error(`Missing ${name}; no provider certification executed`); return env[name]; };
  if (provider === 'postgres') {
    let url; try { url = new URL(requireName('FORGE_FOUNDATION_PG_URL')); } catch { throw new Error('Missing or invalid FORGE_FOUNDATION_PG_URL'); }
    if (!['postgres:', 'postgresql:'].includes(url.protocol)) throw new Error('PostgreSQL URL required');
    return { provider, topology: ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) ? 'native-postgres-local' : 'native-postgres-remote', targetHash: sha(`${url.hostname}:${url.port}${url.pathname}`) };
  }
  if (provider === 'd1') {
    let url; try { url = new URL(requireName('FORGE_FOUNDATION_D1_URL')); } catch { throw new Error('Missing or invalid FORGE_FOUNDATION_D1_URL'); }
    if (url.protocol !== 'https:' || !url.hostname.endsWith('.workers.dev') || url.username || url.password || url.search || url.hash) throw new Error('Hosted D1 requires an HTTPS workers.dev harness URL without embedded credentials');
    requireName('FORGE_FOUNDATION_D1_TOKEN');
    return { provider, topology: 'cloudflare-d1-hosted', targetHash: sha(url.origin) };
  }
  const table = requireName('FORGE_FOUNDATION_DYNAMO_TABLE'), region = requireName('AWS_REGION');
  if (!/^[A-Za-z0-9_.-]{3,255}$/.test(table) || !/^[a-z]{2}(?:-[a-z]+)+-\d$/.test(region)) throw new Error('Invalid Dynamo table name or AWS_REGION');
  if (env.AWS_ENDPOINT_URL || env.AWS_ENDPOINT_URL_DYNAMODB) throw new Error('Dynamo endpoint overrides cannot certify AWS hosted DynamoDB');
  return { provider, topology: 'aws-dynamodb-hosted', targetHash: sha(`${region}:${table}`) };
}
export const profiles = JSON.parse(readFileSync(join(root, 'conformance/foundation/providers/profiles.json'), 'utf8'));
export function validateResult(report, requiredTraces = traceIds) {
  const assertions = (report.testResults ?? []).flatMap(s => s.assertionResults ?? []);
  if (!requiredTraces.length || new Set(requiredTraces).size !== requiredTraces.length || report.success !== true || report.numFailedTests !== 0 || report.numPendingTests !== 0 || report.numTodoTests !== 0 || assertions.length !== requiredTraces.length || assertions.some(a => a.status !== 'passed') || requiredTraces.some(id => !assertions.some(a => a.title === id))) throw new Error('Provider suite did not execute every required trace without skips');
  return requiredTraces;
}
export function sourceFingerprint(profile = "core") {
  const contracts = JSON.parse(readFileSync(join(root, 'specs/foundation/scope.json'), 'utf8')).packages.map(p => JSON.parse(readFileSync(join(root, 'packages/foundation', p.slug, 'contract.json'), 'utf8')));
  const parts = (profile === 'core' ? ['allocation', 'ledger', 'usage'] : [profile]).map(slug => fingerprint(root, slug, contracts));
  for (const path of ['scripts/verify-foundation-providers.mjs', 'scripts/verify-foundation-certification.mjs', 'conformance/foundation/providers/profiles.json', 'conformance/foundation/providers/vitest.config.mjs', 'conformance/foundation/providers/d1-worker.mjs', 'conformance/foundation/providers/dynamo-schema.mjs', 'conformance/foundation/providers/dynamo-schema.d.mts', 'conformance/foundation/providers/fixture/forge.toml', 'conformance/foundation/providers/fixture/forge.lock', 'conformance/foundation/providers/fixture/src/index.forge']) parts.push(path, readFileSync(join(root, path), 'utf8'));
  if (profile !== 'core') for (const path of ['forge.toml', 'forge.lock', 'src/index.forge']) { const file = join(root, profiles[profile].fixture, path); if (existsSync(file)) parts.push(join(profiles[profile].fixture, path), readFileSync(file, 'utf8')); }
  return sha(parts.join('\0'));
}
function run(command, args, env = {}) {
  const result = spawnSync(command, args, { cwd: root, env: { ...process.env, ...env }, stdio: 'inherit' });
  if (result.error || result.status !== 0) throw new Error(`Provider command failed: ${command} (exit ${result.status ?? 'unavailable'})`);
}
export function runProviders(args) {
  let selected, profile = 'core', receiptDirectory = join(root, 'conformance/reports/foundation/providers');
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--profile') profile = args[++i];
    else if (args[i] === '--provider') selected = args[++i];
    else if (args[i] === '--receipt-dir') receiptDirectory = resolve(args[++i]);
    else throw new Error(`Unsupported provider argument: ${args[i]}`);
  }
  if (profile !== 'core' && !profiles[profile]) throw new Error('Unknown provider profile');
  const requestedTraces = profile === 'core' ? traceIds : profiles[profile].requiredTraces;
  const providers = selected === 'all' ? ['postgres', 'd1', 'dynamodb'] : [selected];
  // Preflight every selected provider before any data is written.
  const configurations = providers.map(provider => providerConfiguration(provider, process.env));
  const out = mkdtempSync(join(tmpdir(), 'forge-foundation-providers-')), source = sourceFingerprint(profile);
  try {
    const fixture = profile === 'core' ? 'conformance/foundation/providers/fixture' : profiles[profile].fixture;
    run('cargo', ['run', '--quiet', '-p', 'forgegraph-cli', '--', 'check', fixture]);
    run('cargo', ['run', '--quiet', '-p', 'forgegraph-cli', '--', 'build', fixture, '--out', join(out, 'bundle')]);
    if (profile === 'reconciliation') run('cargo', ['run', '--quiet', '-p', 'forgegraph-cli', '--', 'build', 'packages/foundation/reconciliation/fixtures/controller', '--out', join(out, 'controller')]);
    const artifacts = ['app.json', 'd1/0001_init.sql', 'postgres/0001_init.sql'].map(path => ({ path, sha256: sha(readFileSync(join(out, 'bundle', path))) }));
    for (const configuration of configurations) {
      const id = randomUUID(), resultPath = join(out, configuration.provider + '.json'), identityPath = join(out, configuration.provider + '-identity.json');
      const receipt = { version: 1, suite: 'providers', profile: profile === 'core' ? 'foundation-core-invariants/1' : `foundation-${profile}-invariants/1`, coverageCriteria: profile === 'core' ? [] : profiles[profile].criteria, status: 'running', runId: id, ...configuration, sourceFingerprint: source, artifacts, requestedTraces, certification: 'executed profile only; acceptance requires matching PostgreSQL, hosted D1 and hosted DynamoDB receipts' };
      mkdirSync(receiptDirectory, { recursive: true });
      const receiptPath = join(receiptDirectory, `${configuration.provider}-${id}.json`);
      writeFileSync(receiptPath, JSON.stringify(receipt, null, 2) + '\n');
      try {
        run('pnpm', ['--filter', '@forgegraph/runtime', 'exec', 'vitest', 'run', '--config', join(root, 'conformance/foundation/providers/vitest.config.mjs'), '--reporter=default', '--reporter=json', `--outputFile=${resultPath}`], {
          FORGE_PROVIDER_PROFILE: profile, FORGE_FOUNDATION_CONSUMER: join(out, 'bundle'), FORGE_RECONCILIATION_CONTROLLER: join(out, 'controller'),
          FORGE_PROVIDER: configuration.provider, FORGE_PROVIDER_RUN_ID: id, FORGE_PROVIDER_FIXTURE: join(out, 'bundle'), FORGE_PROVIDER_IDENTITY: identityPath,
          FORGE_PROVIDER_BUNDLE_SHA256: artifacts[0].sha256, FORGE_PROVIDER_HARNESS_SHA256: sha(readFileSync(join(root, 'conformance/foundation/providers/d1-worker.mjs'))),
        });
        const resultBytes = readFileSync(resultPath), passed = validateResult(JSON.parse(resultBytes), requestedTraces);
        if (sourceFingerprint(profile) !== source) throw new Error('Source changed while provider traces executed');
        const identity = JSON.parse(readFileSync(identityPath, 'utf8'));
        if (identity.provider !== configuration.provider || identity.runId !== id) throw new Error('Provider identity evidence missing or mismatched');
        Object.assign(receipt, { status: 'passing', verifiedAt: new Date().toISOString(), passedTraces: passed, testReportSha256: sha(resultBytes), identity });
        writeFileSync(join(receiptDirectory, `${configuration.provider}-${id}.vitest.json`), resultBytes);
      } catch (error) {
        Object.assign(receipt, { status: 'failed', failedAt: new Date().toISOString(), failure: 'Required provider traces or source-bound evidence failed; inspect command output' });
        throw error;
      } finally { if (existsSync(resultPath)) writeFileSync(join(receiptDirectory, `${configuration.provider}-${id}.vitest.json`), readFileSync(resultPath)); writeFileSync(receiptPath, JSON.stringify(receipt, null, 2) + '\n'); }
      console.log(JSON.stringify({ receipt: receiptPath, status: receipt.status, provider: configuration.provider, scope: receipt.certification }));
    }
  } finally { rmSync(out, { recursive: true, force: true }); }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { runProviders(process.argv.slice(2)); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
