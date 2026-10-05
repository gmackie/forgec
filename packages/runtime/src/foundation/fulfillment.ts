import { Effect } from "effect";
import { executionDigest } from "@forgegraph/capability-manifest";
import type { Engine, CallContext } from "../engine.js";
import type { Wire } from "../decode.js";
import { err } from "../errors.js";
import { findTerminalFact } from "./facts.js";
import type { WorkQueue, TaskRequirements } from "../work-queues.js";
const prefix = "@forgegraph/foundation/fulfillment/_/";
export class Fulfillments {
  constructor(private readonly engine: Engine) {}
  private call(op: string, input: Wire, ctx: CallContext) { return this.engine.call(prefix + op, input, ctx); }
  status(fulfillment: string, ctx: CallContext) {
    const self = this;
    return Effect.gen(function* () {
      yield* self.call("Fulfillment.get", { id: fulfillment }, ctx);
      const end = yield* findTerminalFact(self.engine, prefix + "FulfillmentEnd", "fulfillment", fulfillment, ctx);
      if (end) return { phase: String(end.outcome), coverage: String(end.coverage), end };
      const start = yield* findTerminalFact(self.engine, prefix + "FulfillmentStart", "fulfillment", fulfillment, ctx);
      return { phase: start ? "running" : "pending", coverage: "none", end: null };
    });
  }
  start(fulfillment: string, beganAt: string, ctx: CallContext) {
    const self = this;
    return Effect.gen(function* () {
      const state = yield* self.status(fulfillment, ctx);
      if (state.end) return yield* Effect.fail(err("InvalidTransition", "Fulfillment is terminal"));
      return yield* self.call("FulfillmentStart.create", { fulfillment, beganAt, recordedBy: ctx.actor }, ctx);
    });
  }
  finish(fulfillment: string, outcome: "completed" | "failed" | "cancelled", coverage: "complete" | "partial" | "none", endedAt: string, reason: string, ctx: CallContext, evidence: string | null = null) {
    const self = this;
    return Effect.gen(function* () {
      yield* self.call("Fulfillment.get", { id: fulfillment }, ctx);
      const start = yield* findTerminalFact(self.engine, prefix + "FulfillmentStart", "fulfillment", fulfillment, ctx);
      return yield* self.call("FulfillmentEnd.create", { fulfillment, start: start?.id ?? null, outcome, coverage, endedAt, reason, recordedBy: ctx.actor, evidence }, ctx);
    });
  }
  /** Queue calls run only after an authorized durable business link is accepted.
   * This is a resumable two-step bridge; queue success is not business success. */
  enqueueTask<Input extends { fulfillment: string }>(queue: WorkQueue, task: string, input: Input, requirements: TaskRequirements, ctx: CallContext) {
    const self = this;
    return Effect.gen(function* () {
      const state = yield* self.status(input.fulfillment, ctx);
      if (state.end) return yield* Effect.fail(err("InvalidTransition", "Cannot enqueue terminal fulfillment"));
      const link = yield* self.call("FulfillmentTaskLink.create", { fulfillment: input.fulfillment, queue: queue.definition.id, task }, { ...ctx, idempotencyKey: JSON.stringify(["fulfillment-task", queue.definition.id, task]) });
      yield* self.call("FulfillmentTaskLink.get", { id: link.id }, ctx);
      return yield* queue.enqueue(ctx.tenant, task, input, requirements).pipe(Effect.catch(e => {
        if (e.code !== "VersionConflict") return Effect.fail(e);
        return queue.get(ctx.tenant, task).pipe(Effect.flatMap(existing => executionDigest(existing.input) === executionDigest(input) && executionDigest(existing.requirements) === executionDigest(requirements) ? Effect.succeed(existing) : Effect.fail(err("IdempotencyMismatch", "Task identity reused with different execution input"))));
      }));
    });
  }
}
