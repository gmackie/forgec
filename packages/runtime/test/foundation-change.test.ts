import {Effect} from 'effect';
import {expect,it} from 'vitest';
import {foundation,foundationAdapters} from './helpers/foundation.js';
import {Changes} from '../src/foundation/change.js';
import {Decisions} from '../src/foundation/decision.js';
import {Participations} from '../src/foundation/participation.js';
import {Evaluations} from '../src/foundation/evaluation.js';
import {Evidence} from '../src/foundation/evidence.js';
import {localAuthorizer} from '../src/gatekeeper.js';
const p='@forgegraph/foundation/change/_/',s='@forgegraph/foundation/specification/_/',e='@forgegraph/foundation/evaluation/_/',d='@forgegraph/foundation/decision/_/',fuf='@forgegraph/foundation/fulfillment/_/',pp='@forgegraph/foundation/participation/_/';
const run=Effect.runPromise,at='2026-01-01T00:00:00Z';
for(const adapter of foundationAdapters)it(`${adapter}: pinned gates, validated approval, verification, rollback and supersession`,async()=>{
 const f=await foundation('change',adapter,true),{call,ctx,engine}=f;
 try{
  const changes=new Changes(engine),decisions=new Decisions(engine),evaluations=new Evaluations(engine);
  const members=new Participations(engine,{namespace:'change',roles:['approver']});
  const membership=await call(pp+'ParticipationSet.create',{label:'Approvers'});await run(members.registerRole('approver',ctx));
  const party=await call('@forgegraph/foundation/party/_/Party.create',{label:'Approver'});
  const voter=await run(members.add({participationSet:String(membership.id),participant:String(party.id),role:'approver',validFrom:at,reason:'Appointed'},ctx));
  const repo=await call(s+'Repository.create',{key:'change',provider:'git',locator:'https://example.test/change'});
  const from=await call(s+'SpecificationPin.create',{repository:repo.id,anchor:'target',revision:'a'.repeat(40)}),to=await call(s+'SpecificationPin.create',{repository:repo.id,anchor:'target',revision:'b'.repeat(40)});
  const stream=await call(p+'ChangeStream.create',{key:'change'});
  const bundle=await call('@forgegraph/foundation/evidence/_/EvidenceBundle.create',{key:'verification',label:'Verification'}),seal=await run(new Evidence(engine).seal(String(bundle.id),null,ctx));
  const set=await call(e+'EvaluationSet.create',{label:'Change evaluations'}),executor=await call(e+'EvaluationExecutor.create',{key:'verifier',label:'Verifier'});
  const fulfillmentSet=await call(fuf+'FulfillmentSet.create',{label:'Implementations'}),worker=await call(fuf+'FulfillmentExecutor.create',{key:'worker'});
  let ordinal=0;
  const makeFulfillment=async(pin:unknown)=>{
   const fulfillment=await call(fuf+'Fulfillment.create',{fulfillmentSet:fulfillmentSet.id,ordinal:++ordinal,specificationPin:pin,executor:worker.id,requestedAt:at});
   const start=await call(fuf+'FulfillmentStart.create',{fulfillment:fulfillment.id,beganAt:at,recordedBy:ctx.actor});
   const end=await call(fuf+'FulfillmentEnd.create',{fulfillment:fulfillment.id,start:start.id,outcome:'completed',coverage:'complete',endedAt:at,evidence:seal.id,reason:'Applied',recordedBy:ctx.actor});
   return {fulfillment,end};
  };
  const evaluation=await run(evaluations.create({evaluationSet:String(set.id),definition:String(to.id),executor:String(executor.id)},ctx));await run(evaluations.start(String(evaluation.id),at,ctx));
  const finish=await run(evaluations.finish(String(evaluation.id),'Completed',at,'Verified',ctx,String(seal.id)));
  for(const [index,type]of ['SoftwareDeployment','RecipeChange','PolicyChange'].entries()){
   const decision=await run(decisions.open({participationSet:String(membership.id),electors:[String(voter.id)],eligibilityAt:at,deadline:'2027-01-01T00:00:00Z',options:['Approve','Reject'],rule:'Single'},ctx));
   const options=(await run(decisions.state(String(decision.id),ctx))).options;
   const change=await call(p+'Change.create',{stream:stream.id,sequence:index+1,fromPin:from.id,toPin:to.id,approvalRequired:true,verificationRequired:true,approvalCase:decision.id,approvedOption:options[0]!.id});
   await call('@fixture/change-consumer/_/'+type+'.create',{change:change.id,[['environment','recipe','policy'][index]!]:type});
   await call(p+'ChangeImpactLink.create',{change:change.id,run:evaluation.id,finish:finish.id});
   const {fulfillment,end}=await makeFulfillment(to.id);
   const pendingRace=await Promise.allSettled([run(changes.implement(String(change.id),String(fulfillment.id),at,ctx)),run(decisions.respond(String(decision.id),String(voter.id),[index===2?1:0],ctx))]);
   expect(pendingRace[0]!.status).toBe('rejected');expect(pendingRace[1]!.status).toBe('fulfilled');
   const outcome=await run(decisions.finalize(String(decision.id),ctx));const terminal=(await run(decisions.state(String(decision.id),ctx))).terminal!;
   const approval=await call(p+'ChangeDecisionLink.create',{change:change.id,outcome:outcome.id,terminal:terminal.id,selected:outcome.selected});
   if(index===2){
    await expect(run(changes.implement(String(change.id),String(fulfillment.id),at,ctx,String(approval.id)))).rejects.toThrow();
    await run(changes.end({change:String(change.id),outcome:'Rejected',decision:String(approval.id),reason:'Rejected'},ctx));
    expect((await run(changes.state(String(change.id),ctx))).phase).toBe('Rejected');continue;
   }
   const implementation=await run(changes.implement(String(change.id),String(fulfillment.id),at,{...ctx,idempotencyKey:'implement-'+index},String(approval.id)));
   const complete={change:String(change.id),outcome:'Completed' as const,implementation:String(implementation.id),fulfillment:String(fulfillment.id),fulfillmentEnd:String(end.id),reason:'Complete'};
   await expect(run(changes.end(complete,ctx))).rejects.toThrow();
   const verification=await call(p+'ChangeVerificationLink.create',{change:change.id,implementation:implementation.id,run:evaluation.id,finish:finish.id,support:seal.id});
   const completed=await run(changes.end({...complete,verification:String(verification.id)},{...ctx,idempotencyKey:'complete-'+index}));
   expect(await run(new Changes(engine).end({...complete,verification:String(verification.id)},{...ctx,idempotencyKey:'complete-'+index}))).toEqual(completed);
   expect((await run(changes.state(String(change.id),ctx))).phase).toBe('Completed');
   const rollback=await call(p+'Change.create',{stream:stream.id,sequence:10+index,fromPin:to.id,toPin:from.id,approvalRequired:false,verificationRequired:false,approvalCase:null,approvedOption:null});
   await call(p+'ChangeRollback.create',{change:change.id,ended:completed.id,rollback:rollback.id});
   expect((await run(changes.state(String(change.id),ctx))).phase).toBe('RollbackPlanned');
   await call(p+'ChangeSupersession.create',{prior:change.id,replacement:rollback.id,reason:'Reverse change'});
   const reversing=await makeFulfillment(from.id),implementation2=await run(changes.implement(String(rollback.id),String(reversing.fulfillment.id),at,ctx));
   await run(changes.end({change:String(rollback.id),outcome:'Completed',implementation:String(implementation2.id),fulfillment:String(reversing.fulfillment.id),fulfillmentEnd:String(reversing.end.id),reason:'Reversed without verification by policy'},ctx));
   expect((await run(changes.state(String(change.id),ctx))).phase).toBe('RolledBack');
   expect((await call(p+'Change.get',{id:change.id})).toPin).toBe(to.id);
   await expect(call(p+'Change.update',{id:change.id,approvalRequired:false})).rejects.toThrow();
   await expect(run(changes.state(String(change.id),{...ctx,tenant:'foreign'}))).rejects.toThrow();
   await expect(call(p+'ChangeImpactLink.create',{change:change.id,run:evaluation.id,finish:finish.id},{...ctx,tenant:'foreign'})).rejects.toThrow();
  }
  engine.gatekeeper.authorizer=localAuthorizer({policies:[{id:'read-change',actions:[p+'Change.get'],requires:[],where:[]}],pips:[],epoch:1,knownObligations:[]});
  await expect(call(p+'ChangeStream.create',{key:'denied'})).rejects.toThrow();
 }finally{await f.close();}
});
