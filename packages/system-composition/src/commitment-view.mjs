/** Cross-domain commitments projection over authoritative Agreement, Duty,
 * Fulfillment, Decision/Evidence and Settlement services. It owns no records,
 * settlement decisions, approvals, or general-purpose Obligation entity. */
const txt=(v,k)=>{if(typeof v!=='string'||!v.trim())throw new TypeError(`invalid ${k}`);};
const trusted=(record,tenant,k)=>{
  if(!record||record.providerVerified!==true||record.tenant!==tenant)throw new Error(`${k}: unavailable or unverified authoritative fact`);
  return record;
};
export class CommitmentInspector {
  #ports;
  constructor({authorize,agreement,duty,fulfillment,acceptance,settlement}) {
    const p={authorize,agreement,duty,fulfillment,acceptance,settlement};
    for(const[k,fn]of Object.entries(p))if(typeof fn!=='function')throw new TypeError(`trusted ${k} provider required`);
    this.#ports=p;
  }
  async inspect({tenant,actor,commitmentId}) {
    txt(tenant,'tenant');txt(actor,'actor');txt(commitmentId,'commitment ID');
    const p=this.#ports;
    if(await p.authorize({tenant,actor,commitmentId,operation:'read',purpose:'commitment.read'})!==true)throw new Error('not authorized');
    const terms=trusted(await p.agreement({tenant,actor,commitmentId}),tenant,'agreement');
    const promise=trusted(await p.duty({tenant,actor,commitmentId,agreementRevision:terms.revision}),tenant,'duty');
    txt(terms.revision,'agreement revision');txt(terms.termsDigest,'terms digest');
    if(terms.accepted!==true||promise.agreementRevision!==terms.revision||promise.termsDigest!==terms.termsDigest)throw new Error('missing accepted exact obligation');
    const context={tenant,actor,commitmentId,agreementRevision:terms.revision,termsDigest:terms.termsDigest};
    const [work,decision,payment]=await Promise.all([p.fulfillment(context),p.acceptance(context),p.settlement(context)]);
    const blockers=[], waiting=[];
    const add=(dest,value)=>{if(!dest.includes(value))dest.push(value);};
    for(const [kind,record] of [['fulfillment',work],['acceptance',decision],['settlement',payment]]) {
      if(!record)continue;
      trusted(record,tenant,kind);
      if(record.agreementRevision!==terms.revision||record.termsDigest!==terms.termsDigest)throw new Error(`${kind}: stale terms`);
    }
    if(work?.status==='failed')add(blockers,'fulfillment-failed');
    else if(work?.status!=='completed')add(waiting,'fulfillment-incomplete');
    else if(typeof work.evidenceDigest!=='string'||!work.evidenceDigest||work.evidenceSealed!==true)add(waiting,'sealed-fulfillment-evidence-missing');
    if(decision?.outcome==='rejected')add(blockers,'acceptance-rejected');
    else if(decision?.outcome!=='accepted' || work?.status!=='completed' || work.evidenceSealed!==true || decision.evidenceDigest!==work.evidenceDigest || decision.verifiedDecision!==true) {
      add(waiting,'exact-acceptance-missing');
    }
    if(payment?.status==='settled') {
      if(!decision||decision.outcome!=='accepted'||decision.verifiedDecision!==true||work?.status!=='completed'||work.evidenceSealed!==true||decision.evidenceDigest!==work.evidenceDigest||payment.acceptanceRevision!==decision.revision||payment.settlementEvidenceSealed!==true) add(blockers,'unbacked-settlement-claim');
    } else if(payment?.status==='partial') add(waiting,'partial-settlement');
    else add(waiting,'settlement-unconfirmed');
    const after=trusted(await p.agreement({tenant,actor,commitmentId}),tenant,'agreement');
    if(after.revision!==terms.revision||after.termsDigest!==terms.termsDigest||after.accepted!==true)add(blockers,'terms-changed-during-review');
    const state=blockers.length?'blocked':waiting.length===0?'settled':
      waiting.some(x=>x==='fulfillment-incomplete'||x==='sealed-fulfillment-evidence-missing')?'awaiting-fulfillment':
      waiting.includes('exact-acceptance-missing')?'awaiting-acceptance':'awaiting-settlement';
    return {commitmentId,agreementRevision:terms.revision,state,blockers,waiting,authority:'advisory-projection'};
  }
}
