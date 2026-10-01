import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

export function lockedVersion(root, importer, name) {
  const lock = require('js-yaml').load(readFileSync(join(root, 'pnpm-lock.yaml'), 'utf8'));
  const entry = lock.importers?.[importer];
  const version = entry?.dependencies?.[name]?.version ?? entry?.devDependencies?.[name]?.version;
  return typeof version === 'string' ? version.split('(')[0] : null;
}

/** Content identity, independent of checkout path or commit metadata. Reports never hash themselves. */
export function certificationIdentity(root) {
  const paths = new Set();
  const excluded = new Set(['node_modules', 'target', 'dist', 'generated', 'cdk.out', '.wrangler', '.git', '.jj', 'outputs.json', 'wrangler.local.jsonc']);
  const walk = dir => {
    if (!existsSync(join(root, dir))) return;
    for (const entry of readdirSync(join(root, dir), { withFileTypes: true })) {
      if (excluded.has(entry.name)) continue;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile()) paths.add(path);
    }
  };
  for (const dir of ['crates', 'conformance/src', 'conformance/test', 'conformance/scenarios', 'conformance/vectors', 'examples/acme/src', 'examples/acme/impl', 'examples/acme/migrations', 'examples/acme/deploy', 'packages/contracts/data-core']) walk(dir);
  for (const pkg of ['runtime', 'adapters', 'interfaces', 'governance', 'registry', 'contracts/capability-manifest']) {
    walk(`packages/${pkg}/src`);
    paths.add(`packages/${pkg}/package.json`);
  }
  for (const file of ['Cargo.toml', 'Cargo.lock', 'pnpm-lock.yaml', 'package.json', 'conformance/package.json', 'conformance/vitest.config.ts', 'conformance/fixtures/acme.app.json', 'conformance/fixtures/acme-next.app.json', 'conformance/fixtures/acme-next.0001_init.sql', 'examples/acme/package.json', 'scripts/certification-identity.mjs', 'scripts/certification-identity.d.mts', 'scripts/release-manifest.ts']) paths.add(file);
  const digest = createHash('sha256');
  for (const path of [...paths].sort()) {
    digest.update(path).update('\0').update(readFileSync(join(root, path))).update('\0');
  }
  const bundle = JSON.parse(readFileSync(join(root, 'conformance/fixtures/acme.app.json'), 'utf8'));
  const scenarioIds = readdirSync(join(root, 'conformance/scenarios')).filter(n => n.endsWith('.json')).sort().map(n => JSON.parse(readFileSync(join(root, 'conformance/scenarios', n), 'utf8')).id).sort();
  return { buildHash: bundle.buildHash, sourceFingerprint: digest.digest('hex'), node: process.version, scenarioIds };
}
