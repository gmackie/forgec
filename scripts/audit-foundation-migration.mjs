#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const key = row => JSON.stringify([row.tenant, row.id]);
const present = value => typeof value === 'string' && value.trim().length > 0;

/** Read-only review of an exported migration candidate. This never executes a
 * migration or certifies historical chronology from backfilled timestamps. */
export function auditMigration(input) {
  const errors = [];
  const fail = message => errors.push(message);
  if (!input || input.version !== 1) throw new Error('Expected migration export version 1');
  const rows = (name, value) => {
    if (!Array.isArray(value)) throw new Error(`${name} must be an array`);
    const seen = new Set();
    for (const row of value) {
      if (!row || !present(row.id) || !present(row.tenant)) throw new Error(`${name} requires explicit id and tenant on every row`);
      if (seen.has(key(row))) fail(`${name}: duplicate tenant/id ${key(row)}`);
      seen.add(key(row));
    }
    return value;
  };
  const legacy = rows('legacyParticipants', input.legacyParticipants);
  const parties = rows('parties', input.parties);
  const before = rows('before.participations', input.before?.participations);
  const after = rows('after.participations', input.after?.participations);
  const oldEnds = rows('before.ends', input.before?.ends);
  const newEnds = rows('after.ends', input.after?.ends);
  const starts = rows('legacyEvaluationStarts', input.legacyEvaluationStarts);
  const requireFields = (name, records, fields) => {
    for (const row of records) for (const field of fields)
      if (!present(row[field])) throw new Error(`${name} requires ${field} on ${key(row)}`);
  };
  for (const [name, records] of [['before.participations', before], ['after.participations', after]])
    requireFields(name, records, ['participant', 'participationSet', 'role', 'validFrom', 'recordedBy', 'reason', 'createdAt']);
  for (const records of [before, after]) for (const row of records) {
    if (!Object.hasOwn(row, 'validUntil') || (row.validUntil !== null && !present(row.validUntil))) throw new Error('participations requires explicit validUntil (datetime or null)');
  }
  for (const [name, records] of [['before.ends', oldEnds], ['after.ends', newEnds]]) {
    requireFields(name, records, ['participation', 'effectiveAt', 'recordedBy', 'reason', 'createdAt']);
    for (const row of records) if (typeof row.revoked !== 'boolean') throw new Error(`${name} requires boolean revoked`);
  }
  requireFields('legacyEvaluationStarts', starts, ['run']);
  if (!Array.isArray(input.mapping)) throw new Error('mapping must be an array');
  const legacyKeys = new Set(legacy.map(key)), partyKeys = new Set(parties.map(key));
  const mapping = new Map(), targets = new Set();
  for (const row of input.mapping) {
    if (!row || !present(row.tenant) || !present(row.participant) || !present(row.party)) throw new Error('mapping requires tenant, participant and party');
    const source = key({tenant: row.tenant, id: row.participant}), target = key({tenant: row.tenant, id: row.party});
    if (!legacyKeys.has(source)) fail(`mapping: unknown legacy participant ${source}`);
    if (!partyKeys.has(target)) fail(`mapping: missing Party in the same tenant ${target}`);
    if (mapping.has(source)) fail(`mapping: duplicate source ${source}`);
    // Identity merges can collapse membership uniqueness and require separate review.
    if (targets.has(target)) fail(`mapping: many-to-one identity merge ${target}`);
    mapping.set(source, row.party); targets.add(target);
  }
  for (const row of legacy) if (!mapping.has(key(row))) fail(`mapping: unmapped legacy participant ${key(row)}`);
  const compare = (name, oldRows, newRows, transform = row => row) => {
    const proposed = new Map(newRows.map(row => [key(row), row]));
    for (const row of oldRows) {
      const expected = transform(row), actual = proposed.get(key(row));
      if (!actual) fail(`${name}: missing historical row ${key(row)}`);
      else if (stable(expected) !== stable(actual)) fail(`${name}: changed historical fields ${key(row)}`);
      proposed.delete(key(row));
    }
    for (const id of proposed.keys()) fail(`${name}: unexpected historical row ${id}`);
  };
  compare('participations', before, after, row => {
    const party = mapping.get(key({tenant: row.tenant, id: row.participant}));
    if (!party) fail(`participations: unmapped identity ${key(row)}`);
    return {...row, participant: party};
  });
  compare('ends', oldEnds, newEnds);
  const membershipKeys = new Set(after.map(key));
  const naturalKeys = new Set();
  for (const row of after) {
    if (!partyKeys.has(key({tenant: row.tenant, id: row.participant}))) fail(`participations: missing Party ${key(row)}`);
    const natural = JSON.stringify([row.tenant, row.participationSet, row.participant, row.role, row.validFrom]);
    if (naturalKeys.has(natural)) fail(`participations: duplicate membership identity ${key(row)}`);
    naturalKeys.add(natural);
  }
  const ended = new Set();
  for (const row of newEnds) {
    const membership = key({tenant: row.tenant, id: row.participation});
    if (!membershipKeys.has(membership)) fail(`ends: dangling or cross-tenant membership ${key(row)}`);
    if (ended.has(membership)) fail(`ends: duplicate terminal fact ${membership}`);
    ended.add(membership);
  }
  // Legacy EvaluationStart did not own createdAt. No exported timestamp, even a
  // plausible one, can upgrade it to evidence that a binding preceded execution.
  const reevaluate = starts.map(row => ({tenant: row.tenant, start: row.id, run: row.run,
    disposition: 'reevaluate', reason: 'Legacy start lacks server-owned binding chronology'}));
  return {version: 1, inputSha256: digest(input), status: errors.length ? 'blocked' : 'ready-for-review',
    errors, counts: {identities: legacy.length, participations: before.length, ends: oldEnds.length},
    evaluations: reevaluate, deploymentAuthorized: false,
    limitations: ['Export completeness must be checked against a quiesced source database.',
      'Only identity references and membership history are compared; consumer satellites, principal representations and storage constraints require separate review.',
      'Legacy evaluation results cannot authorize publication or knowledge feedback until re-evaluated with fresh bindings and server-owned starts.']};
}
function stable(value) {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${stable(value[k])}`).join(',')}}`;
  return JSON.stringify(value);
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    if (process.argv.length !== 3) throw new Error('Usage: node scripts/audit-foundation-migration.mjs <export.json>');
    const result = auditMigration(JSON.parse(readFileSync(process.argv[2], 'utf8')));
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    if (result.errors.length) process.exitCode = 1;
  } catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1; }
}
