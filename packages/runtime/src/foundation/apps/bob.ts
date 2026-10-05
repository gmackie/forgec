import type { Engine, CallContext } from '../../engine.js';
import { Fulfillments } from '../fulfillment.js';
import { checkLength, decodeDatetime, decodeText } from '../../codecs.js';
export interface RunFact { taskRunId:string;sessionId:string;userId:string;workspaceId:string;planningItemId:string;completedAt:string }
export interface FulfillmentBinding {
  readonly taskRunId:string;
  readonly fulfillmentId:string;
  /** Optional server-owned identities, checked before either durable write. */
  readonly sessionId?:string;
  readonly planningItemId?:string;
  readonly userId?:string;
  readonly workspaceId?:string;
}
/** This certifies recorded execution completion, not reviewed or merged delivery.
 * A trusted binding must identify an already started Foundation Fulfillment.
 * Supply session/planning identities when the composition root knows them; the
 * minimal binding retains compatibility with callers validating native rows.
 */
export function bobCompletion(engine:Engine,ctx:CallContext,binding:FulfillmentBinding,run:(effect:ReturnType<Engine['call']>)=>Promise<Record<string,unknown>>) {
  return { async recordCompletion(input:RunFact) {
    // Snapshot before the first asynchronous write so both steps use the same
    // authorized observation, even if the caller reuses mutable input objects.
    const fact = { ...input }, context = { ...ctx }, trusted = { ...binding };
    for (const key of ['taskRunId','sessionId','userId','workspaceId','planningItemId'] as const) {
      checkLength(decodeText(fact[key]), 1, 128);
      if (trusted[key] !== undefined && fact[key] !== trusted[key]) throw new Error('Run identity does not match authorized binding');
    }
    decodeDatetime(fact.completedAt);
    if(fact.workspaceId!==context.tenant || fact.userId!==context.actor || fact.taskRunId!==trusted.taskRunId) throw new Error('Run identity does not match authorized binding');
    const terminal=await run(new Fulfillments(engine).finish(trusted.fulfillmentId,'completed','complete',fact.completedAt,
      'Bob persisted task run completed', {...context,idempotencyKey:JSON.stringify(['bob-completion',fact.taskRunId])}));
    const link=await run(engine.call('@foundation-app/bob/_/RunCompletion.create',{
      taskRunId:fact.taskRunId,sessionId:fact.sessionId,userId:fact.userId,workspaceId:fact.workspaceId,
      planningItemId:fact.planningItemId,execution:trusted.fulfillmentId,terminal:terminal.id,
    },{...context,idempotencyKey:JSON.stringify(['bob-run',fact.taskRunId])}));
    return {fulfillmentEndId:String(terminal.id),runLinkId:String(link.id)};
  }};
}
