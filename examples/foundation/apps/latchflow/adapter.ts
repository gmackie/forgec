import { Effect } from "../../../../packages/runtime/src/foundation/app-runtime.js";
import type { Engine, CallContext } from "../../../../packages/runtime/src/engine.js";
import { sha256 } from "../../../../packages/runtime/src/engine.js";
import type { Wire } from "../../../../packages/runtime/src/decode.js";
import { Operations } from "../../../../packages/runtime/src/foundation/operations.js";
export interface LatchFlowRun {
  buildingId: string; roomId: string; runId: string; operatorId: string;
  flowId: string; compiledFlowId: string; compiledJson: string;
  runnerId: string | null; status: "idle" | "running"; startedAt: string;
}
const app = "@foundation-app/latchflow/_/", op = "@forgegraph/foundation/operations/_/", usage = "@forgegraph/foundation/usage/_/";
/** The composition root resolves an exact approved source pin for compiled content.
 * The adapter never interprets a random payload hash as a Git revision. */
export function latchFlowFoundation(engine: Engine, options: {
  context(buildingId: string, operatorId: string): CallContext;
  definition(input: { buildingId: string; flowId: string; compiledFlowId: string; contentDigest: string }): Promise<string>;
}) {
  return {
    async recordRun(event: LatchFlowRun): Promise<{ run: string; phase: "Planned" | "Running" }> {
      const ctx = options.context(event.buildingId, event.operatorId);
      if (ctx.tenant !== event.buildingId) throw new Error("Foundation tenant must equal the authorized building");
      if (!event.runId || !event.roomId || !event.compiledFlowId || !["idle", "running"].includes(event.status)) throw new Error("Invalid native Run identity");
      const contentDigest = await sha256(event.compiledJson);
      const definition = await options.definition({ buildingId: event.buildingId, flowId: event.flowId, compiledFlowId: event.compiledFlowId, contentDigest });
      const call = (operation: string, input: Wire, key: string) => Effect.runPromise(engine.call(operation, input, { ...ctx, idempotencyKey: JSON.stringify(["latchflow", key]) }));
      const flow = await call(app + "CompiledFlow.create", { nativeId: event.compiledFlowId, flowId: event.flowId, contentDigest, definition }, "flow:" + event.compiledFlowId);
      const room = await call(app + "Room.create", { nativeId: event.roomId }, "room:" + event.roomId);
      const dimension = await call(usage + "UsageDimension.create", { key: "latchflow-duration", unit: "second" }, "duration");
      const source = await call(usage + "UsageSource.create", { key: "latchflow-runtime" }, "source");
      const stream = await call(usage + "UsageStream.create", { label: "Run " + event.runId, dimension: dimension.id }, "stream:" + event.runId);
      const operation = await call(op + "Operation.create", { key: "latchflow:" + event.runId, definition }, "operation:" + event.runId);
      const execution = await call(op + "OperationRun.create", { operation: operation.id, ordinal: 1, plans: null, usageStream: stream.id, usageSource: source.id }, "execution:" + event.runId);
      const run = await call(app + "Run.create", { nativeId: event.runId, room: room.id, compiledFlow: flow.id, runnerId: event.runnerId, operatorId: event.operatorId, initialStatus: event.status, startedAt: event.startedAt, operation: operation.id, execution: execution.id }, "run:" + event.runId);
      // A runner-assigned idle row is intent only: no fabricated acknowledgment.
      if (event.status === "running") await Effect.runPromise(new Operations(engine).start(String(execution.id), null, { ...ctx, idempotencyKey: JSON.stringify(["latchflow-start", event.runId]) }));
      return { run: String(run.id), phase: event.status === "running" ? "Running" : "Planned" };
    },
  };
}
