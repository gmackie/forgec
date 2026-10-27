/**
 * Revision-bound change assessment (read model, not execution authority).
 * Every fact comes from a trusted authoritative system; there is no GitHub URL
 * parsing, external writes, auto-merge or policy override in this projection.
 */
const str = (v, field) => {
  if (typeof v !== 'string' || !v.trim()) throw new TypeError(`invalid ${field}`);
};

function latest(records, predicate, stream) {
  const items = records.filter(predicate);
  if (!items.length) return null;
  if (items.length === 1) return items[0];
  // Multiple revisions of one fact require monotonic upstream sequencing.
  // Do not pick whichever event a transport happened to return last.
  if (items.some(x => !Number.isSafeInteger(x.sequence) || x.sequence < 1)) {
    throw new TypeError(`${stream}: multiple results require trusted positive sequence`);
  }
  items.sort((a, b) => b.sequence - a.sequence);
  if (items[0].sequence === items[1].sequence) throw new TypeError(`${stream}: conflicting latest sequence`);
  return items[0];
}

export function assessChange(input) {
  for (const field of ['changeId', 'sourceRevision', 'currentRevision', 'planDigest']) str(input?.[field], field);
  if (!Array.isArray(input.requiredChecks) || !Array.isArray(input.checks) || !Array.isArray(input.approvals) || !Array.isArray(input.impacts) || !Array.isArray(input.deployments) || !Array.isArray(input.requiredEnvironments)) throw new TypeError('change arrays required');
  if (new Set(input.requiredChecks).size !== input.requiredChecks.length || new Set(input.requiredEnvironments).size !== input.requiredEnvironments.length) throw new TypeError('duplicate gate');
  for (const field of ['approvalRequired', 'verificationRequired']) if (typeof input[field] !== 'boolean') throw new TypeError(`${field} must be boolean`);
  const blockers = [], waiting = [], evidence = [];
  const add = (bucket, reason) => { if (!bucket.includes(reason)) bucket.push(reason); };

  if (input.sourceRevision !== input.currentRevision) add(blockers, 'source-revision-changed');
  if (input.impacts.length === 0) add(waiting, 'impact-analysis-missing');
  for (const impact of input.impacts) {
    str(impact.subject, 'impact subject');
    if (impact.status === 'ambiguous' || impact.status === 'denied' || impact.status === 'unsafe') add(blockers, `impact:${impact.subject}:${impact.status}`);
    else if (impact.status !== 'resolved') add(waiting, `impact:${impact.subject}:unresolved`);
  }
  if (input.approvalRequired) {
    const decision = latest(input.approvals, a => a.sourceRevision === input.sourceRevision && a.planDigest === input.planDigest, 'approval');
    if (decision?.outcome === 'rejected') add(blockers, 'approval-rejected');
    else if (!(decision?.outcome === 'approved' && decision.verified === true)) add(waiting, 'approved-decision-missing-or-stale');
    else evidence.push('revision-bound-approval');
  }
  for (const check of input.requiredChecks) {
    str(check, 'required check');
    const selected = latest(input.checks, c => c.name === check && c.sourceRevision === input.sourceRevision && c.planDigest === input.planDigest, `check:${check}`);
    if (selected?.status === 'fail' || selected?.status === 'error') add(blockers, `check:${check}:failed`);
    else if (!(selected?.status === 'pass' && selected.verified === true)) add(waiting, `check:${check}:missing-current-proof`);
    else evidence.push(`check:${check}`);
  }
  let deployed = true;
  for (const env of input.requiredEnvironments) {
    str(env, 'required environment');
    const selected = latest(input.deployments, d => d.environment === env && d.sourceRevision === input.sourceRevision && d.planDigest === input.planDigest, `deployment:${env}`);
    if (selected?.status === 'failed' || selected?.status === 'rolled_back') { add(blockers, `deployment:${env}:failed`); deployed = false; }
    else if (selected?.status === 'active') {
      if (input.verificationRequired && !(selected.observation?.status === 'converged' && selected.observation.verified === true && selected.observation.sourceRevision === input.sourceRevision)) {
        add(waiting, `deployment:${env}:observation-missing`); deployed = false;
      } else evidence.push(`deployment:${env}`);
    } else deployed = false;
  }
  // Missing deployment is normal prior to promotion and not a readiness failure.
  const predeploymentWaiting = waiting.filter(x => !x.startsWith('deployment:'));
  const verdict = blockers.length ? 'blocked' : predeploymentWaiting.length ? 'incomplete' :
    input.requiredEnvironments.length && deployed ? 'verified' :
    waiting.some(x => x.startsWith('deployment:')) ? 'deployed-unverified' : 'ready-for-gate';
  return {
    changeId: input.changeId,
    sourceRevision: input.sourceRevision,
    verdict,
    blockers,
    waiting,
    evidence,
    // Never treat a recommendation as authorization, approval, merge policy,
    // provider-certified deployment, or proof of external side effects.
    authority: 'advisory-projection',
  };
}
