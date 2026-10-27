/**
 * Executable integration *fixture*: none of these objects is a real GitHub,
 * Gatekeeper, KanBanger, Approvals or ForgeGraph provider response. Replace
 * synthetic ports with authenticated adapters before deployment.
 */
import assert from 'node:assert/strict';
import { ActionCenter } from '../src/action-center.mjs';
import { assessChange } from '../src/change-intelligence.mjs';

const change = {
  changeId: 'policy-change-42', sourceRevision: 'sha-review-42', currentRevision: 'sha-review-42',
  planDigest: 'plan-sha-42', requiredChecks: ['policy-simulation', 'unit'],
  approvalRequired: true, verificationRequired: true,
  requiredEnvironments: ['production'],
  impacts: [{subject:'gatekeeper:policy:db-access',status:'resolved'}],
  approvals: [],
  checks: [
    {name:'policy-simulation',sourceRevision:'sha-review-42',planDigest:'plan-sha-42',status:'pass',verified:true},
    {name:'unit',sourceRevision:'sha-review-42',planDigest:'plan-sha-42',status:'pass',verified:true},
  ],
  deployments:[],
};
assert.equal(assessChange(change).verdict, 'incomplete');
const forwarded=[];
const inbox=new ActionCenter({
  producers: {approvals:{kinds:['approval'],purposes:{decide:'approvals.decide'}}},
  authorize: async ({tenant,actor,purpose}) => tenant==='acme' && actor==='reviewer' && ['work.read','approvals.decide'].includes(purpose),
  dispatch: async operation => {forwarded.push(operation);return {providerReceipt:'pending-approval'};},
});
inbox.ingest('approvals', {
  tenant:'acme',subject:'decision-42',kind:'approval',label:'Review exact production policy plan',
  revision:1,status:'pending',assignees:['reviewer'],actions:['decide']
});
assert.equal((await inbox.list({tenant:'acme',actor:'reviewer'})).length,1);
assert.equal((await inbox.list({tenant:'other-tenant',actor:'reviewer'})).length,0);
const submission=await inbox.invoke({tenant:'acme',actor:'reviewer',source:'approvals',subject:'decision-42',revision:1,action:'decide',purpose:'approvals.decide',idempotencyKey:'review-42-1'});
assert.equal(submission.state,'submitted');
assert.equal(forwarded.length,1);
assert.equal(assessChange(change).verdict,'incomplete'); // Submission is NOT acceptance.

// Later: a source-authenticated response from the real approvals service.
inbox.ingest('approvals',{tenant:'acme',subject:'decision-42',kind:'approval',label:'Review exact production policy plan',revision:2,status:'resolved',assignees:['reviewer'],actions:[]});
change.approvals=[{sourceRevision:'sha-review-42',planDigest:'plan-sha-42',outcome:'approved',verified:true}];
assert.equal(assessChange(change).verdict,'ready-for-gate');

// The deployment acknowledgement alone cannot establish convergence.
change.deployments=[{environment:'production',sourceRevision:'sha-review-42',planDigest:'plan-sha-42',status:'active'}];
assert.equal(assessChange(change).verdict,'deployed-unverified');

// Only a fresh authoritative observation resolves the final state.
change.deployments[0].observation={status:'converged',verified:true,sourceRevision:'sha-review-42'};
assert.equal(assessChange(change).verdict,'verified');

// Amending the PR must invalidate every old approval and observation.
change.currentRevision='sha-amended-43';
assert.equal(assessChange(change).verdict,'blocked');
console.log('Six-stage synthetic cross-system scenario passed; no real approvals, deployments or mutations occurred.');
