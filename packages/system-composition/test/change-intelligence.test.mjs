import test from 'node:test';
import assert from 'node:assert/strict';
import { assessChange } from '../src/change-intelligence.mjs';
const fixture = (patch = {}) => ({
  changeId: 'chg-1', sourceRevision:'head-1',currentRevision:'head-1',planDigest:'plan-1',
  requiredChecks:['unit'],requiredEnvironments:['production'],approvalRequired:true,verificationRequired:true,
  impacts:[{subject:'api-service', status:'resolved'}],
  approvals:[{sourceRevision:'head-1',planDigest:'plan-1',outcome:'approved',verified:true}],
  checks:[{name:'unit',sourceRevision:'head-1',planDigest:'plan-1',status:'pass',verified:true}],
  deployments:[],...patch
});
test('ready for gate is advisory, not permission to deploy', () => {
  const result = assessChange(fixture());
  assert.equal(result.verdict,'ready-for-gate');
  assert.equal(result.authority,'advisory-projection');
});
test('amended revision invalidates source pin', () => {
  const result = assessChange(fixture({currentRevision:'head-2'}));
  assert.equal(result.verdict,'blocked'); assert.ok(result.blockers.includes('source-revision-changed'));
});
test('new plan digest invalidates existing approval and check', () => {
  const result = assessChange(fixture({planDigest:'plan-2'}));
  assert.equal(result.verdict,'incomplete'); assert.ok(result.waiting.includes('approved-decision-missing-or-stale'));
  assert.ok(result.waiting.includes('check:unit:missing-current-proof'));
});
test('ambiguous anchor and rejected approval block rather than guessing', () => {
  const result = assessChange(fixture({impacts:[{subject:'function',status:'ambiguous'}],approvals:[{sourceRevision:'head-1',planDigest:'plan-1',outcome:'rejected'}]}));
  assert.equal(result.verdict,'blocked'); assert.ok(result.blockers.some(x => x.includes('ambiguous'))); assert.ok(result.blockers.includes('approval-rejected'));
});
test('deployment requires exact version and observed convergence', () => {
  const base = fixture({deployments:[{environment:'production',sourceRevision:'head-1',planDigest:'plan-1',status:'active'}]});
  assert.equal(assessChange(base).verdict,'deployed-unverified');
  base.deployments[0].observation = {status:'converged',verified:true,sourceRevision:'head-1'};
  assert.equal(assessChange(base).verdict,'verified');
});
test('a rollback is not successful deployment', () => {
  const result = assessChange(fixture({deployments:[{environment:'production',sourceRevision:'head-1',planDigest:'plan-1',status:'rolled_back'}]}));
  assert.equal(result.verdict,'blocked');
});
test('missing impact data cannot be construed as approved', () => {
  assert.equal(assessChange(fixture({impacts:[]})).verdict,'incomplete');
});
test('latest verified check wins over historical failed rerun, never insertion order', () => {
  const checks = [
    {name:'unit',sourceRevision:'head-1',planDigest:'plan-1',sequence:5,status:'pass',verified:true},
    {name:'unit',sourceRevision:'head-1',planDigest:'plan-1',sequence:4,status:'fail',verified:true},
  ];
  assert.equal(assessChange(fixture({checks})).verdict,'ready-for-gate');
  assert.equal(assessChange(fixture({checks:checks.reverse()})).verdict,'ready-for-gate');
});
test('multiple provider facts without authoritative sequencing fail closed', () => {
  const checks = [
    {name:'unit',sourceRevision:'head-1',planDigest:'plan-1',status:'pass',verified:true},
    {name:'unit',sourceRevision:'head-1',planDigest:'plan-1',status:'fail',verified:true},
  ];
  assert.throws(()=>assessChange(fixture({checks})), /require trusted positive sequence/);
});
