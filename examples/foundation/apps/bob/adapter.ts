import type { Engine, CallContext } from '../../../../packages/runtime/src/engine.js';
import { Fulfillments } from '../../../../packages/runtime/src/foundation/fulfillment.js';
export interface RunFact { taskRunId:string;sessionId:string;userId:string;workspaceId:string;planningItemId:string;completedAt:string }
export interface FulfillmentBinding { readonly taskRunId:string;readonly fulfillmentId:string }
/** This certifies recorded execution completion, not reviewed or merged delivery.
 * A trusted binding must identify an already started Foundation Fulfillment.
 */
export function bobCompletion(engine:Engine,ctx:CallContext,binding:FulfillmentBinding,run:(effect:ReturnType<Engine['call']>)=>Promise<Record<string,unknown>>) {
  return { async recordCompletion(fact:RunFact) {
    if(fact.workspaceId!==ctx.tenant || fact.userId!==ctx.actor || fact.taskRunId!==binding.taskRunId) throw new Error('Run identity does not match authorized binding');
    const terminal=await run(new Fulfillments(engine).finish(binding.fulfillmentId,'completed','complete',fact.completedAt,
      'Bob persisted task run completed', {...ctx,idempotencyKey:JSON.stringify(['bob-completion',fact.taskRunId])}));
    const link=await run(engine.call('@foundation-app/bob/_/RunCompletion.create',{
      taskRunId:fact.taskRunId,sessionId:fact.sessionId,userId:fact.userId,workspaceId:fact.workspaceId,
      planningItemId:fact.planningItemId,execution:binding.fulfillmentId,terminal:terminal.id,
    },{...ctx,idempotencyKey:JSON.stringify(['bob-run',fact.taskRunId])}));
    return {fulfillmentEndId:String(terminal.id),runLinkId:String(link.id)};
  }};
}
