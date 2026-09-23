import { expect, it } from 'vitest';
import { Effect } from 'effect';
import { foundation, foundationAdapters } from './helpers/foundation.js';
import { Fulfillments } from '../src/foundation/fulfillment.js';
import { bobCompletion } from '../../../examples/foundation/apps/bob/adapter.js';
const root = process.env['FORGE_FOUNDATION_BOB_ROOT'];
if(!root) throw new Error('FORGE_FOUNDATION_BOB_ROOT is required');
const { reconcileRunFoundationCompletion }=await import(root+'/packages/bob/src/api/src/services/integrations/foundationFulfillmentService.ts');
const s='@forgegraph/foundation/specification/_/',p='@forgegraph/foundation/fulfillment/_/';
for(const adapter of foundationAdapters) it(`${adapter}: Bob persisted completion uses real Fulfillment without inventing start`,async()=>{
 const f=await foundation('app-bob',adapter);
 try{
  const repository=await f.call(s+'Repository.create',{key:'bob-run',provider:'git',locator:'https://example.test/bob'});
  const pin=await f.call(s+'SpecificationPin.create',{repository:repository.id,anchor:'task',revision:'b'.repeat(40)});
  const set=await f.call(p+'FulfillmentSet.create',{label:'Bob execution'});
  const executor=await f.call(p+'FulfillmentExecutor.create',{key:'bob-agent'});
  const fulfillment=await f.call(p+'Fulfillment.create',{fulfillmentSet:set.id,ordinal:1,specificationPin:pin.id,executor:executor.id,requestedAt:'2026-01-01T00:00:00Z'});
  const api=new Fulfillments(f.engine);
  const source={id:'run-1',userId:f.ctx.actor,planningWorkspaceId:f.ctx.tenant,planningItemId:'issue-1',sessionId:'session-1',status:'completed',completedAt:'2026-01-01T02:00:00Z'};
  let row:any=source;
  const db={query:{taskRuns:{findFirst:async()=>row}}};
  const auth={userId:f.ctx.actor,workspaceId:f.ctx.tenant};
  const port=bobCompletion(f.engine,f.ctx,{taskRunId:source.id,fulfillmentId:String(fulfillment.id)},Effect.runPromise);
  await expect(reconcileRunFoundationCompletion(db,auth,source.id,port)).rejects.toThrow();
  await Effect.runPromise(api.start(String(fulfillment.id),'2026-01-01T01:00:00Z',f.ctx));
  let writes=0;
  const interrupted=bobCompletion(f.engine,f.ctx,{taskRunId:source.id,fulfillmentId:String(fulfillment.id)},async effect=>{
   if(++writes===2)throw new Error('link interrupted');
   return Effect.runPromise(effect);
  });
  await expect(reconcileRunFoundationCompletion(db,auth,source.id,interrupted)).rejects.toThrow('link interrupted');
  const result=await reconcileRunFoundationCompletion(db,auth,source.id,port);
  expect(await reconcileRunFoundationCompletion(db,auth,source.id,port)).toEqual(result);
  expect(await f.call(p+'FulfillmentEnd.get',{id:result.fulfillmentEndId})).toMatchObject({fulfillment:fulfillment.id,outcome:'completed',coverage:'complete',endedAt:'2026-01-01T02:00:00.000Z'});
  expect(await f.call('@foundation-app/bob/_/RunCompletion.get',{id:result.runLinkId})).toMatchObject({taskRunId:source.id,sessionId:source.sessionId,planningItemId:source.planningItemId,terminal:result.fulfillmentEndId});
  row={...source,completedAt:'2026-01-01T03:00:00Z'};
  await expect(reconcileRunFoundationCompletion(db,auth,source.id,port)).rejects.toThrow();
  row={...source,status:'running'};
  await expect(reconcileRunFoundationCompletion(db,auth,source.id,port)).rejects.toThrow('persisted completed');
  row=source;
  await expect(reconcileRunFoundationCompletion(db,{...auth,userId:'other'},source.id,port)).rejects.toThrow('authorized workspace');
  await expect(reconcileRunFoundationCompletion(db,{...auth,workspaceId:'other'},source.id,port)).rejects.toThrow('authorized workspace');
 }finally{await f.close();}
});
