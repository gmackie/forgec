import { relative, sep } from 'node:path';
import { planSystem } from './index.mjs';

/**
 * Generate an inert Forge package shell with the exact co-deployed Foundation
 * roots. No domain-owned schema, policy, binding, migration or deployment is
 * fabricated; a real app author must supply domain types and impl/ logic.
 */
export function scaffoldSystem({ catalog, contracts, systemId, repositoryRoot, targetDirectory }) {
  for (const [value, name] of [[repositoryRoot, 'repository root'], [targetDirectory, 'target directory']]) {
    if (typeof value !== 'string' || !value) throw new TypeError(`missing ${name}`);
  }
  const plan = planSystem(catalog, contracts, systemId);
  const system = catalog.systems.find(s => s.id === systemId);
  const imports = [...system.foundation].sort();
  const normalize = p => p.split(sep).join('/');
  const dependencies = imports.map(slug => {
    const folder = normalize(relative(targetDirectory, `${repositoryRoot}/packages/foundation/${slug}`));
    // TOML string escaping, not shell escaping. This is generated data, never executed.
    return `[dependencies.${slug}]\npath = ${JSON.stringify(folder.startsWith('.') ? folder : `./${folder}`)}\ndeploy = true`;
  }).join('\n\n');
  const manifest = `[package]\nname = "@systems/${system.id}"\nversion = "0.1.0"\nedition = "2027"\n\n${dependencies}\n`;
  const source = `// Add domain-specific exported resources, typed satellites and commands here.\n// Imports alone do not install handler implementations, approvals or policies.\n${imports.map(slug => `import ${slug}`).join('\n')}\n`;
  const readme = `# ${system.id}\n\nGenerated from plan digest \`${plan.fingerprint}\`.\n\n${system.description}\n\nThis is an **inert application package shell**. Before publishing or deploying:\n\n- Define application-owned domain records and handlers.\n- Implement and authenticate each external adapter port.\n- Restrict generated CRUD to trusted controllers and Gatekeeper policies.\n- Run \`forgec lock .\`, \`forgec check .\`, \`forgec build .\`, and provider tests.\n- Verify all hosted, data migration, audit and integration requirements.\n\n## Required trusted ports\n\n${system.ports.map(p => `- \`${p.id}\` (${p.mode}) — ${p.authority}`).join('\n')}\n\n## Invariants\n\n${system.invariants.map(x => `- ${x}`).join('\n')}\n`;
  return { plan, files: { 'forge.toml': manifest, 'src/index.forge': source, 'README.md': readme } };
}
