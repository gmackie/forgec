/** Cross-system discrepancy / remediation read model. External provider effects
 * are not inferred from dispatch acknowledgements or closed task/case records.
 * All authority lives with Foundation Reconciliation/Case and upstream ERP/CRM. */
const nonempty=(x,label)=>{if(typeof x!=='string'||!x.trim())throw new TypeError(`invalid ${label}`);};
const asserted=(v,tenant,revision,label)=>{
  if(!v||v.providerVerified!==true||v.tenant!==tenant||v.desiredRevision!==revision)throw new Error(`${label}: untrusted or mismatched observation`);
  return v;
};
export class ExceptionInspector {
  #p;
  constructor({authorize,desired,observations,investigation,correction,reobserve}) {
    this.#p={authorize,desired,observations,investigation,correction,reobserve};
    for(const[k,fn]of Object.entries(this.#p))if(typeof fn!=='function')throw new TypeError(`trusted ${k} provider required`);
  }
  async inspect({tenant,actor,scopeId}) {
    nonempty(tenant,'tenant');nonempty(actor,'actor');nonempty(scopeId,'scope ID');
    const p=this.#p;
    if(await p.authorize({tenant,actor,purpose:'exception.observe',scopeId})!==true)throw new Error('not authorized');
    const prior=await p.desired({tenant,actor,scopeId});
    if(!prior||prior.providerVerified!==true||prior.tenant!==tenant)throw new Error('unverified desired state');
    nonempty(prior.revision,'desired revision');
    const context={tenant,actor,scopeId,desiredRevision:prior.revision};
    const [observed,caseFile,attempt,latest]=await Promise.all([
      p.observations(context),p.investigation(context),p.correction(context),p.reobserve(context)
    ]);
    asserted(observed,tenant,prior.revision,'observations');
    if(caseFile)asserted(caseFile,tenant,prior.revision,'case');
    if(attempt)asserted(attempt,tenant,prior.revision,'correction');
    if(latest)asserted(latest,tenant,prior.revision,'re-observation');
    const blockers=[],waiting=[];
    let state='unknown';
    if(observed.converged===true && observed.evidenceSealed===true){state='converged';}
    else if(!caseFile){
      state='investigation-required';waiting.push('investigation-not-open');
    } else if(!attempt){state='remediation-required';waiting.push('correction-not-started');}
    else if(attempt.state==='failed'){state='blocked';blockers.push('correction-failed');}
    else if(attempt.state==='uncertain'){state='uncertain';waiting.push('remote-effect-unknown');}
    else if(attempt.state!=='completed'){state='in-progress';waiting.push('correction-incomplete');}
    else if(latest?.converged===true && latest.evidenceSealed===true && latest.observedAfterCorrection===true && latest.correctionKey===attempt.key){
      state='converged';
    } else {state='awaiting-verification';waiting.push('fresh-observation-not-verified');}
    if(caseFile?.state==='closed' && state!=='converged'){state='blocked';blockers.push('case-closed-before-verified-convergence');}
    const current=await p.desired({tenant,actor,scopeId});
    if(!current||current.providerVerified!==true||current.tenant!==tenant||current.revision!==prior.revision){
      state='blocked';blockers.push('desired-revision-changed');
    }
    return{scopeId,desiredRevision:prior.revision,state,blockers,waiting,authority:'advisory-projection'};
  }
}
