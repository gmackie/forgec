import { test } from 'node:test';
import assert from 'node:assert/strict';
import { auditMigration } from '../audit-foundation-migration.mjs';
const fixture = () => {
  const membership = {tenant:'t', id:'membership', participant:'old', participationSet:'set', role:'role', validFrom:'2026-01-01T00:00:00Z', validUntil:null, recordedBy:'actor', reason:'Member', createdAt:'2026-01-01T00:00:00Z'};
  const end = {tenant:'t', id:'end', participation:'membership', effectiveAt:'2026-02-01T00:00:00Z', revoked:true, reason:'Revoked', recordedBy:'actor', createdAt:'2026-02-01T00:00:00Z'};
  return {version:1, legacyParticipants:[{tenant:'t',id:'old'}], parties:[{tenant:'t',id:'new'}], mapping:[{tenant:'t',participant:'old',party:'new'}], before:{participations:[membership],ends:[end]}, after:{participations:[{...membership,participant:'new'}],ends:[{...end}]}, legacyEvaluationStarts:[{tenant:'t',id:'start',run:'run',startedAt:'2026-01-01T00:00:00Z'}]};
};
test('preserves membership and terminal history through an explicit tenant-scoped mapping', () => {
  const input=fixture(), snapshot=JSON.stringify(input), result=auditMigration(input);
  assert.equal(result.status,'ready-for-review');assert.deepEqual(result.errors,[]);
  assert.equal(result.deploymentAuthorized,false);assert.equal(JSON.stringify(input),snapshot);
  assert.match(result.inputSha256,/^[a-f0-9]{64}$/);
});
test('detects discarded revocations, history edits and changed membership IDs', () => {
  for (const mutate of [x=>x.after.ends=[], x=>x.after.ends[0].revoked=false, x=>x.after.participations[0].validUntil='2027-01-01T00:00:00Z', x=>x.after.participations[0].id='replacement']) {
    const input=fixture();mutate(input);assert.equal(auditMigration(input).status,'blocked');
  }
});
test('rejects cross-tenant targets, missing mappings, duplicate mappings and identity merges', () => {
  for (const mutate of [x=>x.parties[0].tenant='other', x=>x.mapping=[], x=>x.mapping.push({...x.mapping[0]}), x=>{x.legacyParticipants.push({tenant:'t',id:'another'});x.mapping.push({tenant:'t',participant:'another',party:'new'});}]) {
    const input=fixture();mutate(input);assert.equal(auditMigration(input).status,'blocked');
  }
});
test('requires reevaluation of every legacy start even with plausible backfilled createdAt', () => {
  const input=fixture();input.legacyEvaluationStarts[0].createdAt='2026-01-02T00:00:00Z';
  assert.deepEqual(auditMigration(input).evaluations,[{tenant:'t',start:'start',run:'run',disposition:'reevaluate',reason:'Legacy start lacks server-owned binding chronology'}]);
});
test('rejects partial export shapes and tenantless records', () => {
  assert.throws(()=>auditMigration({version:1}),/array/);
  const input=fixture();delete input.before.participations[0].tenant;
  assert.throws(()=>auditMigration(input),/tenant/);
  const noRun=fixture();delete noRun.legacyEvaluationStarts[0].run;
  assert.throws(()=>auditMigration(noRun),/run/);
});
test('rejects duplicate and dangling terminal facts even when both exports agree', () => {
  for (const mutate of [x=>{x.before.ends[0].participation='missing';x.after.ends[0].participation='missing';}, x=>{x.before.ends.push({...x.before.ends[0],id:'second'});x.after.ends.push({...x.after.ends[0],id:'second'});}]) {
    const input=fixture();mutate(input);assert.equal(auditMigration(input).status,'blocked');
  }
});

test('rejects shared omissions of historical provenance and nullable interval fields', () => {
  for (const field of ['recordedBy','reason','createdAt','validUntil']) {
    const input=fixture();delete input.before.participations[0][field];delete input.after.participations[0][field];
    assert.throws(()=>auditMigration(input), /requires/);
  }
  for (const field of ['recordedBy','reason','createdAt']) {
    const input=fixture();delete input.before.ends[0][field];delete input.after.ends[0][field];
    assert.throws(()=>auditMigration(input), /requires/);
  }
});
