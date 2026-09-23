import { Effect } from "../../../../packages/runtime/src/foundation/app-runtime.js";
import type { Engine, CallContext } from "../../../../packages/runtime/src/engine.js";
import { sha256, stableJson } from "../../../../packages/runtime/src/engine.js";
import type { Wire } from "../../../../packages/runtime/src/decode.js";

/** Structural contract implemented by the real app's opt-in projection seam. */
export interface AcknowledgedProductionCommand {
  teamId: string; sessionId: string; broadcastId: string | null;
  commandId: string; operatorId: string; sequence: number;
  type: "set_preview" | "cut" | "auto";
  payload: unknown; issuedAt: string; completedAt: string;
}
const app = "@foundation-app/stream-conductor/_/", f = "@forgegraph/foundation/fulfillment/_/";

/** Project an existing acknowledgment. Never dispatches/retries OBS or grants app access.
 * Receipt keys make each stage restartable; the final typed link is the publication marker. */
export function streamConductorFoundation(engine: Engine, context: (teamId: string, operatorId: string) => CallContext) {
  return {
    async recordAcknowledgedCommand(event: AcknowledgedProductionCommand): Promise<{ command: string }> {
      const ctx = context(event.teamId, event.operatorId);
      if (ctx.tenant !== event.teamId) throw new Error("Foundation tenant must equal the authorized production team");
      if (!Number.isSafeInteger(event.sequence) || event.sequence < 1 || !event.commandId || !event.sessionId) throw new Error("Invalid production command identity");
      const call = (operation: string, input: Wire, key: string) => Effect.runPromise(engine.call(operation, input, { ...ctx, idempotencyKey: JSON.stringify(["stream-conductor", key]) }));
      const broadcast = event.broadcastId ? await call(app + "Broadcast.create", { nativeId: event.broadcastId }, "broadcast:" + event.broadcastId) : null;
      const set = await call(f + "FulfillmentSet.create", { label: "Production commands " + event.sessionId }, "commands:" + event.sessionId);
      const session = await call(app + "ProductionSession.create", { nativeId: event.sessionId, broadcast: broadcast?.id ?? null, commands: set.id }, "session:" + event.sessionId);
      const executor = await call(f + "FulfillmentExecutor.create", { key: "stream-conductor:production" }, "executor");
      const fulfillment = await call(f + "Fulfillment.create", { fulfillmentSet: set.id, ordinal: event.sequence, specificationPin: null, executor: executor.id, requestedAt: event.issuedAt, evidence: null }, "command:" + event.commandId);
      const start = await call(f + "FulfillmentStart.create", { fulfillment: fulfillment.id, beganAt: event.issuedAt, recordedBy: event.operatorId }, "start:" + event.commandId);
      const end = await call(f + "FulfillmentEnd.create", { fulfillment: fulfillment.id, start: start.id, outcome: "completed", coverage: "complete", endedAt: event.completedAt, evidence: null, reason: "Production command acknowledged by the application", recordedBy: event.operatorId }, "ack:" + event.commandId);
      const command = await call(app + "ProductionCommand.create", { nativeId: event.commandId, session: session.id, sequence: event.sequence, kind: event.type, operatorId: event.operatorId, payloadDigest: await sha256(stableJson(event.payload)), fulfillment: fulfillment.id, acknowledged: end.id }, "link:" + event.commandId);
      return { command: String(command.id) };
    },
  };
}
