#!/usr/bin/env node
// Offline ownership check: protects published SDK names independently of registry credentials.
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export function checkIdentities(root, policy) {
  const problems = [], seen = new Map();
  for (const base of ['packages', 'packages/contracts']) {
    if (!existsSync(join(root, base))) continue;
    for (const entry of readdirSync(join(root, base), { withFileTypes: true })) {
      const dir = `${base}/${entry.name}`, file = join(root, dir, 'package.json');
      if (!entry.isDirectory() || !existsSync(file)) continue;
      const pkg = JSON.parse(readFileSync(file, 'utf8'));
      if (seen.has(pkg.name)) problems.push(`duplicate package identity ${pkg.name}: ${seen.get(pkg.name)}, ${dir}`);
      seen.set(pkg.name, dir);
      if (pkg.private) continue;
      if (policy.publicPackages[pkg.name] !== dir) problems.push(`${dir}: public identity ${pkg.name} has no matching owner in package-identities.json`);
      if (pkg.repository?.directory !== dir || pkg.repository?.url !== policy.repository) problems.push(`${pkg.name}: repository metadata does not match its canonical source owner`);
      if (pkg.publishConfig?.access !== 'public') problems.push(`${pkg.name}: public access must be explicit`);
    }
  }
  for (const [name, dir] of Object.entries(policy.publicPackages)) {
    const file = join(root, dir, 'package.json');
    if (!existsSync(file)) { problems.push(`${name}: owning package is missing at ${dir}`); continue; }
    const pkg = JSON.parse(readFileSync(file, 'utf8'));
    if (pkg.name !== name || pkg.private) problems.push(`${name}: owning package is renamed or private at ${dir}`);
  }
  return problems;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const policy = JSON.parse(readFileSync('package-identities.json', 'utf8'));
  const problems = checkIdentities(process.cwd(), policy);
  for (const problem of problems) console.error(`::error::${problem}`);
  if (!problems.length) console.log(`Verified ${Object.keys(policy.publicPackages).length} public package identities`);
  process.exitCode = problems.length ? 1 : 0;
}
