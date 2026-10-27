/**
 * Composition of existing Foundation contracts into application-level systems.
 * This plans an explicit co-deployment closure; it does NOT deploy, certify a
 * provider, infer business authority or grant access to a Foundation resource.
 */
import { createHash } from 'node:crypto';

const id = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const hasOwn = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);
const unique = (list) => new Set(list).size === list.length;

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export const digest = (value) => createHash('sha256').update(canonical(value)).digest('hex');

function checkString(value, label) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`invalid ${label}`);
}
function checkSlugs(list, label) {
  if (!Array.isArray(list) || !list.length || list.some(x => typeof x !== 'string' || !id.test(x)) || !unique(list)) {
    throw new Error(`invalid ${label}`);
  }
}

/** Fail before any generation when a system has an unresolved capability. */
export function validateCatalog(catalog) {
  if (catalog?.version !== 1 || !Array.isArray(catalog.systems) || !catalog.systems.length) throw new Error('invalid system catalog');
  const ids = new Set();
  for (const s of catalog.systems) {
    if (!id.test(s?.id ?? '') || ids.has(s.id)) throw new Error(`invalid or duplicate system id: ${s?.id}`);
    ids.add(s.id);
    checkString(s.description, `${s.id} description`);
    checkSlugs(s.foundation, `${s.id} foundation`);
    if (!Array.isArray(s.ports) || !Array.isArray(s.operations) || !Array.isArray(s.invariants) || !s.invariants.length) throw new Error(`${s.id}: missing ports, operations or invariants`);
    if (s.invariants.some(v => typeof v !== 'string' || !v.trim())) throw new Error(`${s.id}: blank invariant`);
    const ports = new Set();
    for (const p of s.ports) {
      if (!id.test(p?.id ?? '') || ports.has(p.id)) throw new Error(`${s.id}: duplicate or invalid port`);
      ports.add(p.id);
      checkString(p.authority, `${s.id}.${p.id} authority`);
      if (!['query', 'command', 'events'].includes(p.mode)) throw new Error(`${s.id}.${p.id}: invalid port mode`);
    }
    const operations = new Set();
    for (const op of s.operations) {
      if (!id.test(op?.id ?? '') || operations.has(op.id)) throw new Error(`${s.id}: invalid or duplicate operation`);
      operations.add(op.id);
      if (!['query', 'command'].includes(op.kind)) throw new Error(`${s.id}.${op.id}: invalid operation kind`);
      checkString(op.purpose, `${s.id}.${op.id} purpose`);
      // The system module is an adapter. Business authority remains at one
      // Foundation package or a trusted external system; never 'this' system.
      if (!s.foundation.includes(op.owner) && !ports.has(op.owner)) throw new Error(`${s.id}.${op.id}: unresolved operation owner ${op.owner}`);
      if (ports.has(op.owner)) {
        const port = s.ports.find(p => p.id === op.owner);
        if (op.kind === 'command' && port.mode !== 'command') throw new Error(`${s.id}.${op.id}: command bound to non-command port`);
      }
    }
  }
  return catalog;
}

/** Contract and dependency closure uses the actual Foundation contract.json. */
export function planSystem(catalog, contracts, systemId) {
  validateCatalog(catalog);
  checkString(systemId, 'system id');
  const system = catalog.systems.find(s => s.id === systemId);
  if (!system) throw new Error(`unknown system ${systemId}`);
  const bySlug = new Map();
  for (const c of contracts) {
    if (!id.test(c?.slug ?? '') || bySlug.has(c.slug)) throw new Error('duplicate/invalid Foundation contract');
    bySlug.set(c.slug, c);
  }
  const visited = new Set(), visiting = new Set(), order = [];
  function visit(slug) {
    if (visited.has(slug)) return;
    if (visiting.has(slug)) throw new Error(`Foundation cycle at ${slug}`);
    const c = bySlug.get(slug);
    if (!c) throw new Error(`missing Foundation contract: ${slug}`);
    if (!['substrate', 'system'].includes(c.layer) || !Array.isArray(c.dependencies) || !unique(c.dependencies)) throw new Error(`invalid Foundation contract: ${slug}`);
    visiting.add(slug);
    for (const dep of [...c.dependencies].sort()) {
      const d = bySlug.get(dep);
      if (d && c.layer === 'substrate' && d.layer === 'system') throw new Error(`invalid substrate -> system dependency: ${slug} -> ${dep}`);
      visit(dep);
    }
    visiting.delete(slug); visited.add(slug); order.push(slug);
  }
  for (const slug of [...system.foundation].sort()) visit(slug);
  const missingLocalAcceptance = order.flatMap(slug => {
    const c = bySlug.get(slug);
    if (!Array.isArray(c.acceptance) || !c.acceptance.length) return [`${slug}: no recorded acceptance`];
    return c.acceptance.filter(a => a.status !== 'passing').map(a => `${slug}:${a.id}:${a.status}`);
  });
  const fingerprint = digest({ system, contracts: order.map(slug => bySlug.get(slug)) });
  return {
    schema: 'forge-system-plan/1',
    system: system.id,
    fingerprint,
    foundation: order.map(slug => ({ slug, identity: `@forgegraph/foundation/${slug}`, layer: bySlug.get(slug).layer })),
    ports: system.ports,
    operations: system.operations,
    invariants: system.invariants,
    readiness: {
      localContractCoverage: missingLocalAcceptance.length ? 'incomplete' : 'declared-passing',
      missingLocalAcceptance,
      hostedProvider: 'unverified',
      applicationIntegration: 'unverified',
      executionReady: false
    }
  };
}

export function planCatalog(catalog, contracts) {
  validateCatalog(catalog);
  return catalog.systems.map(s => planSystem(catalog, contracts, s.id));
}
