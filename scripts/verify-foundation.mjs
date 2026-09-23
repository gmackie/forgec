#!/usr/bin/env node
import { readdirSync, readFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { runProviders } from './verify-foundation-providers.mjs';
import { fingerprint, schedule, validateGraph } from './foundation-state.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const scope = JSON.parse(readFileSync(join(root, 'specs/foundation/scope.json'), 'utf8')).packages;
const kinds = new Set(['compile', 'runtime', 'concurrency', 'provider', 'fixture']);
const statuses = new Set(['planned', 'passing', 'blocked']);
export function validateContracts(contracts, { complete = true, expectedScope = scope } = {}) {
  const errors = [], names = new Map(), cases = new Set(), issues = new Set();
  const fail = (slug, text) => errors.push(`${slug}: ${text}`);
  for (const c of contracts) {
    if (!c || typeof c !== 'object') { errors.push('contract must be an object'); continue; }
    const s = c.slug;
    if (typeof s !== 'string' || !/^[a-z]+(?:-[a-z]+)*$/.test(s)) fail(String(s), 'invalid slug');
    if (names.has(s)) fail(s, 'duplicate slug');
    names.set(s, c);
    if (!['substrate', 'system'].includes(c.layer)) fail(s, 'invalid layer');
    if (!Number.isInteger(c.issue) || !expectedScope.some(p => p.issue === c.issue) || issues.has(c.issue)) fail(s, 'invalid or duplicate issue');
    issues.add(c.issue);
    if (!expectedScope.some(p => p.issue === c.issue && p.slug === s && p.layer === c.layer)) fail(s, 'issue/slug/layer does not match explicit scope');
    for (const field of ['facts', 'operations', 'invariants', 'fixtures']) {
      if (!Array.isArray(c[field]) || c[field].length === 0 || c[field].some(x => typeof x !== 'string' || !x.trim())) fail(s, `${field} must contain nonempty strings`);
    }
    if (!Array.isArray(c.dependencies) || c.dependencies.some(x => typeof x !== 'string')) fail(s, 'dependencies must be an array of slugs');
    else if (new Set(c.dependencies).size !== c.dependencies.length) fail(s, 'duplicate dependency');
    if (!Array.isArray(c.acceptance) || c.acceptance.length === 0) { fail(s, 'acceptance cases required'); continue; }
    for (const a of c.acceptance) {
      if (!a || typeof a.id !== 'string' || !a.id.trim() || cases.has(a.id)) fail(s, 'invalid or duplicate acceptance id');
      if (a) cases.add(a.id);
      if (!a || typeof a.description !== 'string' || !a.description.trim() || !kinds.has(a.kind) || !statuses.has(a.status)) fail(s, 'invalid acceptance case');
      if (a?.status === 'passing' && (a.verification !== 'local' || !existsSync(join(root, `packages/foundation/${s}/verification.json`)) || !Array.isArray(a.evidence) || !a.evidence.length || a.evidence.some(path => typeof path !== 'string' || !/^(packages\/runtime\/test\/foundation-[a-z-]+\.test\.ts|packages\/runtime\/test\/blobs\.test\.ts|crates\/forgegraph-semantic\/tests\/append_only\.rs)$/.test(path) || !existsSync(join(root, path))))) fail(s, `${a.id}: passing requires evidence and a supported local verification suite`);
    }
  }
  const visiting = new Set(), visited = new Set(), order = [];
  function visit(s, path = []) {
    if (visiting.has(s)) { errors.push(`dependency cycle: ${[...path, s].join(' -> ')}`); return; }
    if (visited.has(s)) return;
    visiting.add(s);
    const c = names.get(s);
    for (const d of Array.isArray(c?.dependencies) ? c.dependencies : []) {
      if (!names.has(d)) { fail(s, `unknown dependency ${d}`); continue; }
      if (c.layer === 'substrate' && names.get(d).layer === 'system') fail(s, `substrate cannot depend on system ${d}`);
      visit(d, [...path, s]);
    }
    visiting.delete(s); visited.add(s); order.push(s);
  }
  [...names.keys()].sort().forEach(s => visit(s));
  if (complete) for (const { issue } of expectedScope) if (!issues.has(issue)) errors.push(`missing issue #${issue}`);
  return { errors, order, packages: contracts.length, cases: cases.size };
}
export function validateCatalogs(contracts, catalogs) {
  const errors = [];
  for (const layer of ['substrate', 'system']) {
    const catalog = catalogs[layer];
    if (catalog?.schemaVersion !== 1 || catalog.layer !== layer || !Array.isArray(catalog.packages)) {
      errors.push(`${layer}: invalid catalog`); continue;
    }
    const expected = contracts.filter(c => c.layer === layer).map(c => ({ slug: c.slug, issue: c.issue, dependencies: [...c.dependencies].sort(), contract: `packages/foundation/${c.slug}/contract.json`, acceptanceIds: c.acceptance.map(a => a.id).sort() })).sort((a,b) => a.slug.localeCompare(b.slug));
    let actual;
    try {
      actual = catalog.packages.map(c => ({ slug: c.slug, issue: c.issue, dependencies: [...c.dependencies].sort(), contract: c.contract, acceptanceIds: [...c.acceptanceIds].sort() })).sort((a,b) => a.slug.localeCompare(b.slug));
    } catch { errors.push(`${layer}: invalid catalog entry`); continue; }
    if (JSON.stringify(actual) !== JSON.stringify(expected)) errors.push(`${layer}: catalog does not match package contracts`);
  }
  return errors;
}
export function readContracts(repoRoot = root) {
  const dir = join(repoRoot, 'packages/foundation');
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).filter(d => d.isDirectory()).sort((a,b) => a.name.localeCompare(b.name)).map(d => {
    const c = JSON.parse(readFileSync(join(dir, d.name, 'contract.json'), 'utf8'));
    if (c.slug !== d.name) throw new Error(`${d.name}: contract slug does not match directory`);
    return c;
  });
}
function run(cmd, args, env = {}) {
  const r = spawnSync(cmd, args, { cwd: root, env: { ...process.env, ...env }, stdio: 'inherit' });
  if (r.error) throw r.error;
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(' ')} failed (${r.status ?? r.signal})`);
}
function main() {
  const args = process.argv.slice(2);
  let suite = 'contracts', slug, all = false, statePath;
  const providerArgs = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--suite') suite = args[++i];
    else if (args[i] === '--package') slug = args[++i];
    else if (args[i] === '--all') all = true;
    else if (args[i] === '--provider' || args[i] === '--receipt-dir') providerArgs.push(args[i], args[++i]);
    else if (args[i] === '--state') statePath = args[++i];
    else throw new Error(`unknown argument: ${args[i]}`);
  }
  if (!['contracts', 'local', 'providers', 'ready'].includes(suite)) throw new Error('suite must be contracts, local, providers or ready');
  if (all && slug) throw new Error('choose --all or --package, not both');
  if (suite === 'providers') { if (slug || all || statePath) throw new Error('Provider profile uses --provider, not package/all/state acceptance selectors'); runProviders(providerArgs); return; }
  if (providerArgs.length) throw new Error('--provider/--receipt-dir require --suite providers');
  if (suite === 'contracts' || suite === 'ready') {
    const contracts = readContracts();
    if (slug && !contracts.some(c => c.slug === slug)) throw new Error(`unknown package: ${slug}`);
    // Validate the entire graph even when reviewing one package: direction is a global invariant.
    const result = validateContracts(contracts);
    result.errors.push(...validateCatalogs(contracts, Object.fromEntries(['substrate', 'system'].map(layer => [layer, JSON.parse(readFileSync(join(root, `specs/foundation/${layer}s.json`), 'utf8'))]))));
    const graph = JSON.parse(readFileSync(join(root, 'specs/foundation/dependencies.json'), 'utf8'));
    result.errors.push(...validateGraph(graph, contracts));
    if (result.errors.length) throw new Error(result.errors.join('\n'));
    if (suite === 'ready') {
      if (!statePath) throw new Error('--suite ready requires --state <execution receipts JSON>; issue status alone cannot release work');
      const state = JSON.parse(readFileSync(resolve(statePath), 'utf8'));
      const digests = new Map();
      console.log(JSON.stringify(schedule(graph, contracts, state, {kernelFingerprint: fingerprint(root, 'specification', contracts), fingerprintOf: slug => { if (!digests.has(slug)) digests.set(slug, fingerprint(root, slug, contracts)); return digests.get(slug); }}), null, 2));
      return;
    }
    console.log(JSON.stringify({ suite, status: 'passing', ...result, note: 'Contract/evidence structure only; run local package suites to execute acceptance. Hosted provider certification is separate.' }, null, 2));
    return;
  }
  if (all) {
    run(process.execPath, [fileURLToPath(import.meta.url), '--suite', 'contracts', '--all']);
    const result = validateContracts(readContracts());
    const missing = result.order.filter(name => !existsSync(join(root, `packages/foundation/${name}/verification.json`)));
    if (missing.length) throw new Error(`Missing local verifiers: ${missing.join(', ')}`);
    for (const name of result.order) run(process.execPath, [fileURLToPath(import.meta.url), '--suite', 'local', '--package', name]);
    console.log(JSON.stringify({suite: 'local', status: 'passing', packages: result.order, providers: 'live certification not run'}));
    return;
  }
  const verifierPath = slug && /^[a-z]+(?:-[a-z]+)*$/.test(slug) ? join(root, `packages/foundation/${slug}/verification.json`) : '';
  if (verifierPath && existsSync(verifierPath) && !all) {
    const verifier = JSON.parse(readFileSync(verifierPath, 'utf8'));
    if (verifier.version !== 1 || !Array.isArray(verifier.tests) || !verifier.tests.length || verifier.tests.some(t => typeof t !== 'string' || !/^test\/[a-z0-9-]+\.test\.ts$/.test(t))) throw new Error('Invalid package verifier');
    const out = mkdtempSync(join(tmpdir(), 'forge-foundation-'));
    try {
      if (slug === 'specification') run('cargo', ['test', '-p', 'forgegraph-semantic', '--test', 'append_only']);
      run('cargo', ['run', '--quiet', '-p', 'forgegraph-cli', '--', 'check', `packages/foundation/${slug}/fixtures/consumer`]);
      for (const name of ['first', 'second']) run('cargo', ['run', '--quiet', '-p', 'forgegraph-cli', '--', 'build', `packages/foundation/${slug}`, '--out', join(out, name)]);
      for (const name of ['consumer-first', 'consumer-second']) run('cargo', ['run', '--quiet', '-p', 'forgegraph-cli', '--', 'build', `packages/foundation/${slug}/fixtures/consumer`, '--out', join(out, name)]);
      const pairs = [['first', 'second'], ['consumer-first', 'consumer-second']];
      const extraEnv = {};
      if (existsSync(join(root, `packages/foundation/${slug}/fixtures/controller/forge.toml`))) {
        for (const name of ['controller-first', 'controller-second']) run('cargo', ['run', '--quiet', '-p', 'forgegraph-cli', '--', 'build', `packages/foundation/${slug}/fixtures/controller`, '--out', join(out, name)]);
        pairs.push(['controller-first', 'controller-second']);
        extraEnv[`FORGE_${slug.toUpperCase().replaceAll('-', '_')}_CONTROLLER`] = join(out, 'controller-first');
      }
      for (const [first, second] of pairs) for (const file of ['app.json', 'd1/0001_init.sql', 'postgres/0001_init.sql', 'client.ts', 'openapi.json', 'api.smithy', 'source-map.json', 'README.md']) {
        if (!readFileSync(join(out, first, file)).equals(readFileSync(join(out, second, file)))) throw new Error(`nondeterministic artifact: ${file}`);
      }
      run('pnpm', ['--filter', '@forgegraph/runtime', 'exec', 'vitest', 'run', ...verifier.tests], { ...extraEnv, FORGE_FOUNDATION_FIXTURE: join(out, 'first'), FORGE_FOUNDATION_CONSUMER: join(out, 'consumer-first') });
      if (slug === 'specification') {
        run('cargo', ['run', '--quiet', '-p', 'forgegraph-cli', '--', 'build', 'packages/foundation/artifact/fixtures/consumer', '--out', join(out, 'artifact-consumer')]);
        run('pnpm', ['--filter', '@forgegraph/runtime', 'exec', 'vitest', 'run', 'test/foundation-artifact-consumer.test.ts'], { FORGE_FOUNDATION_CONSUMER: join(out, 'artifact-consumer') });
      }
      const receipt = { version: 1, package: slug, suite: 'local', status: 'passing', fingerprint: fingerprint(root, slug, readContracts()), verifiedAt: new Date().toISOString(), commands: [`cargo check/build ${slug} and consumer; deterministic double build`, `vitest run ${verifier.tests.join(' ')}`], artifacts: pairs.flatMap(([dir]) => ['app.json', 'd1/0001_init.sql', 'postgres/0001_init.sql', 'client.ts', 'openapi.json', 'api.smithy', 'source-map.json', 'README.md'].map(file => ({path: `${dir}/${file}`, sha256: createHash('sha256').update(readFileSync(join(out, dir, file))).digest('hex')}))), providers: 'live certification not run' };
      const reportDir = join(root, 'conformance/reports/foundation'); mkdirSync(reportDir, {recursive: true}); writeFileSync(join(reportDir, `${slug}.json`), JSON.stringify(receipt, null, 2)+'\n');
      console.log(JSON.stringify({...receipt, deterministic: true, scope: 'local generated-bundle tests; package requirement acceptance and provider evidence remain separate'}));
    } finally { rmSync(out, { recursive: true, force: true }); }
    return;
  }
  if (slug !== 'composition' || all) throw new Error('No package-local verifier found; implementation acceptance remains incomplete.');
  const out = mkdtempSync(join(tmpdir(), 'forge-foundation-'));
  const fixture = 'conformance/foundation/fixtures/composition/app';
  try {
    run('cargo', ['run', '--quiet', '-p', 'forgegraph-cli', '--', 'check', fixture]);
    for (const name of ['app', 'records', 'remote']) run('cargo', ['run', '--quiet', '-p', 'forgegraph-cli', '--', 'fmt', `conformance/foundation/fixtures/composition/${name}`, '--check']);
    for (const name of ['first', 'second']) run('cargo', ['run', '--quiet', '-p', 'forgegraph-cli', '--', 'build', fixture, '--out', join(out, name)]);
    for (const file of ['app.json', 'd1/0001_init.sql', 'postgres/0001_init.sql', 'client.ts', 'openapi.json', 'api.smithy', 'source-map.json', 'README.md']) {
      if (!readFileSync(join(out, 'first', file)).equals(readFileSync(join(out, 'second', file)))) throw new Error(`nondeterministic artifact: ${file}`);
    }
    run('pnpm', ['--filter', '@forgegraph/runtime', 'exec', 'vitest', 'run', 'test/foundation-composition.test.ts'], { FORGE_FOUNDATION_BUNDLE: join(out, 'first/app.json') });
    console.log(JSON.stringify({ suite, package: slug, status: 'passing', deterministic: true, providers: 'not run', facetsAndPatterns: 'not included in this slice' }));
  } finally { rmSync(out, { recursive: true, force: true }); }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(); } catch (e) { console.error(e.message); process.exitCode = 1; }
}
