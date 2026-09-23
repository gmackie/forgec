import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

/** Stable digest of actual package closure, tests and execution/compiler semantics.
 * Acceptance reports are outside these trees and cannot attest to themselves. */
export function fingerprint(root, slug, contracts) {
  const byName = new Map(contracts.map(c => [c.slug, c]));
  const closure = new Set();
  function visit(name) {
    if (closure.has(name)) return;
    const c = byName.get(name);
    if (!c) throw new Error(`unknown dependency ${name}`);
    closure.add(name); c.dependencies.forEach(visit);
  }
  visit(slug);
  const paths = new Set();
  function walk(path) {
    if (!existsSync(path)) return;
    for (const d of readdirSync(path, { withFileTypes: true })) {
      if (['node_modules', 'generated', 'target', '.jj', '.git'].includes(d.name)) continue;
      const p = join(path, d.name);
      if (d.isDirectory()) walk(p);
      else if (d.isFile()) paths.add(p);
    }
  }
  for (const name of closure) walk(join(root, 'packages/foundation', name));
  for (const name of ['syntax', 'semantic', 'planner', 'codegen', 'cli']) walk(join(root, `crates/forgegraph-${name}/src`));
  walk(join(root, 'packages/runtime/src'));
  // Tests are evidence-producing code, not merely a string attached to a status.
  walk(join(root, 'packages/runtime/test'));
  for (const path of ['Cargo.lock', 'pnpm-lock.yaml', 'scripts/verify-foundation.mjs', 'scripts/foundation-state.mjs']) if (existsSync(join(root, path))) paths.add(join(root, path));
  const h = createHash('sha256');
  for (const path of [...paths].sort()) h.update(relative(root, path)).update('\0').update(readFileSync(path)).update('\0');
  return h.digest('hex');
}

/** Evidence is an execution receipt, not approval of requirements not exercised. */
export function evidenceErrors(record, slug, expectedFingerprint) {
  const errors = [];
  if (!record || record.version !== 1 || record.package !== slug || record.status !== 'passing' || record.suite !== 'local') errors.push('missing passing local execution receipt');
  if (record?.fingerprint !== expectedFingerprint) errors.push('stale source/dependency evidence');
  if (!Array.isArray(record?.commands) || !record.commands.length || record.commands.some(c => typeof c !== 'string' || !c.trim())) errors.push('missing verifier commands');
  if (!Array.isArray(record?.artifacts) || !record.artifacts.length || record.artifacts.some(a => !a || typeof a.path !== 'string' || !/^[a-f0-9]{64}$/.test(a.sha256))) errors.push('missing generated artifact digests');
  if (!Number.isFinite(Date.parse(record?.verifiedAt))) errors.push('missing verification timestamp');
  return errors;
}

/** All dependencies mean accepted contracts + verified implementations. A producer
 * does not wait for the acceptance gate it will implement itself. */
export function schedule(graph, contracts, state, { slots = 3, fingerprintOf, kernelFingerprint } = {}) {
  if (!Number.isInteger(slots) || slots < 1) throw new Error('slots must be a positive integer');
  const nodes = new Map(graph.packages.map(p => [p.slug, p]));
  const cs = new Map(contracts.map(c => [c.slug, c]));
  const active = new Set(state.active ?? []);
  const accepted = new Set(), reasons = new Map(), validating = new Set();
  function acceptance(slug) {
    if (reasons.has(slug)) return reasons.get(slug);
    if (validating.has(slug)) throw new Error(`dependency cycle at ${slug}`);
    const node = nodes.get(slug); if (!node) throw new Error(`unknown package ${slug}`);
    validating.add(slug);
    const c = cs.get(slug);
    const why = evidenceErrors(state.packages?.[slug], slug, fingerprintOf(slug));
    if (!c || c.acceptance.some(a => a.status !== 'passing')) why.push('package acceptance remains incomplete');
    for (const gate of [...node.requiresGates, ...node.acceptanceGates]) {
      const proof = state.gates?.[gate];
      const owner = graph.gateOwnership[gate];
      const gateFingerprint = nodes.has(owner) ? fingerprintOf(owner) : kernelFingerprint;
      if (!proof || proof.status !== 'passing' || typeof proof.fingerprint !== 'string' || !gateFingerprint || proof.fingerprint !== gateFingerprint) why.push(`gate ${gate} unverified or stale`);
    }
    for (const d of node.dependencies) if (acceptance(d).length) why.push(`dependency ${d} not accepted`);
    validating.delete(slug); reasons.set(slug, why);
    if (!why.length) accepted.add(slug);
    return why;
  }
  for (const slug of nodes.keys()) acceptance(slug);
  const blocked = [], ready = [];
  for (const [slug, node] of nodes) {
    if (accepted.has(slug) || active.has(slug)) continue;
    const why = node.dependencies.filter(d => !accepted.has(d)).map(d => `dependency ${d} not accepted`);
    for (const gate of node.requiresGates) {
      if (node.acceptanceGates.includes(gate)) throw new Error(`${slug} cannot require its own acceptance gate ${gate}`);
      const proof = state.gates?.[gate], owner = graph.gateOwnership[gate];
      const expected = nodes.has(owner) ? fingerprintOf(owner) : kernelFingerprint;
      if (!proof || proof.status !== 'passing' || typeof proof.fingerprint !== 'string' || !expected || proof.fingerprint !== expected) why.push(`gate ${gate} unverified or stale`);
    }
    if (why.length) blocked.push({ package: slug, reasons: why });
    else ready.push(slug);
  }
  function fanout(name) {
    const descendants = new Set();
    function visit(n) { for (const [s,p] of nodes) if (p.dependencies.includes(n) && !descendants.has(s)) { descendants.add(s); visit(s); } }
    visit(name); return [...descendants].filter(s => !accepted.has(s)).length;
  }
  ready.sort((a,b) => fanout(b)-fanout(a) || nodes.get(a).issue-nodes.get(b).issue);
  return { accepted: [...accepted].sort(), active: [...active].sort(), ready, dispatch: ready.slice(0, Math.max(0, slots-active.size)), blocked };
}
