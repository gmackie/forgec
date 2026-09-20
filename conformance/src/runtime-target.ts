/** Conformance target backed by the runtime engine and the in-memory adapter: the semantic reference. */
import { Cause, Effect } from "effect";
import { Engine, ForgeError, MemoryStorage, Model, testLayer, type AppBundle } from "@forge/runtime";
import type { CallContext, CallResult, Target } from "./target.js";

export class RuntimeTarget implements Target {
  readonly name = "runtime-memory";
  private engine!: Engine;
  private readonly model: Model;

  constructor(bundle: AppBundle) {
    this.model = new Model(bundle);
    this.build();
  }

  private build(): void {
    this.engine = new Engine(this.model, testLayer(new MemoryStorage()));
  }

  async reset(): Promise<void> {
    this.build();
  }

  async call(op: string, input: unknown, ctx: CallContext): Promise<CallResult> {
    const exit = await Effect.runPromiseExit(this.engine.call(op, input, { tenant: ctx.tenant, actor: ctx.actor, requestId: "conformance", ...(ctx.idempotencyKey ? { idempotencyKey: ctx.idempotencyKey } : {}) }));
    if (exit._tag === "Success") return { ok: true, value: exit.value };
    const e = Cause.squash(exit.cause);
    if (e instanceof ForgeError) return { ok: false, code: e.code, detail: e.problem("conformance") };
    throw e;
  }
}
