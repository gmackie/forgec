/**
 * Read-through change-control evidence assembly. All five injected readers are
 * server-configured, authenticated integrations. User input selects only the
 * change ID; it never supplies approvals, CI results, policy or plans.
 */
import { assessChange } from './change-intelligence.mjs';

const requireText = (value,label) => {
  if (typeof value !== 'string' || !value.trim()) throw new TypeError(`invalid ${label}`);
};
const requireReader = (v,name) => {
  if (typeof v !== 'function') throw new TypeError(`trusted ${name} reader required`);
};
function trustedHead(head) {
  if (!head || head.verified !== true) throw new Error('unverified source head');
  for (const x of ['tenant','changeId','sourceRevision','planDigest']) requireText(head[x],`source ${x}`);
  if (!Array.isArray(head.requiredChecks) || !Array.isArray(head.requiredEnvironments)) throw new TypeError('missing trusted policy gates');
  return head;
}

export class ChangeControlCollector {
  #ports;
  constructor({ authorize, source, impacts, approvals, checks, deployments }) {
    for (const [name,port] of Object.entries({authorize,source,impacts,approvals,checks,deployments})) requireReader(port,name);
    this.#ports={ authorize,source,impacts,approvals,checks,deployments };
  }
  async assess({ tenant, actor, changeId }) {
    requireText(tenant,'tenant'); requireText(actor,'actor'); requireText(changeId,'change ID');
    const { authorize,source,impacts,approvals,checks,deployments }=this.#ports;
    if (await authorize({tenant,actor,purpose:'change.review',operation:'read',changeId}) !== true) throw new Error('not authorized');
    // Gate the entire observation on a trusted source-controlled revision.
    const initial=trustedHead(await source({tenant,actor,changeId}));
    if (initial.tenant!==tenant || initial.changeId!==changeId) throw new Error('source tenant/change mismatch');
    const query={tenant,actor,changeId,sourceRevision:initial.sourceRevision,planDigest:initial.planDigest};
    const [impactRecords, approvalRecords, checkRecords, deploymentRecords]=await Promise.all([
      impacts(query), approvals(query), checks(query), deployments(query)
    ]);
    const facts={impacts:impactRecords,approvals:approvalRecords,checks:checkRecords,deployments:deploymentRecords};
    for(const [kind,records] of Object.entries(facts)) {
      if (!Array.isArray(records) || records.length>1000) throw new Error(`invalid ${kind} evidence`);
      for(const record of records) {
        if (!record || record.tenant!==tenant || record.changeId!==changeId) throw new Error(`${kind}: mismatched tenant/change evidence`);
        // No derived evidence is silently transplanted across revisions/plans.
        if ((record.sourceRevision!==initial.sourceRevision || record.planDigest!==initial.planDigest)) throw new Error(`${kind}: mismatched source revision or plan`);
        if(record.providerVerified!==true) throw new Error(`${kind}: unverified provider record`);
      }
    }
    const current=trustedHead(await source({tenant,actor,changeId}));
    if (current.tenant!==tenant || current.changeId!==changeId) throw new Error('changed source identity');
    const result=assessChange({
      changeId, sourceRevision:initial.sourceRevision, currentRevision:current.sourceRevision,
      planDigest:initial.planDigest, requiredChecks:initial.requiredChecks,
      requiredEnvironments:initial.requiredEnvironments,
      approvalRequired:initial.approvalRequired, verificationRequired:initial.verificationRequired,
      ...facts,
    });
    // A changed plan can invalidate approvals/checks without changing the VCS revision.
    if (current.planDigest!==initial.planDigest) {
      const blockers=[...new Set([...result.blockers,'plan-changed-during-assessment'])];
      return {...result,verdict:'blocked',blockers};
    }
    return result;
  }
}
