/** Conformance target backed by the runtime engine and the in-memory adapter: the semantic reference. */
import { Cause, Effect } from "effect";
import { Engine, ForgeError, MemoryObjectStore, MemoryStorage, Model, testLayer, type AppBundle } from "@forge/runtime";
import { externals, functions } from "../../examples/acme/impl/index.js";
import type { CallContext, CallResult, Target } from "./target.js";

export class RuntimeTarget implements Target {
  readonly name = "runtime-memory";
  private engine!: Engine;
  private objects!: MemoryObjectStore;
  private readonly model: Model;

  constructor(bundle: AppBundle) {
    this.model = new Model(bundle);
    this.build();
  }

  private build(): void {
    this.objects = new MemoryObjectStore();
    this.engine = new Engine(this.model, testLayer(new MemoryStorage(), { objects: this.objects }), { functions, externals });
  }

  async reset(): Promise<void> {
    this.build();
  }

  async transfer(signed: { url: string; method: string; headers?: Record<string, string> }, body?: Uint8Array): Promise<{ status: number; bytes: Uint8Array }> {
    if (signed.method === "PUT") {
      // Like R2/S3 presigned PUTs, the upload is bound to the intent's byte count; a different size is refused.
      const declared = Number(signed.headers?.["content-length"] ?? NaN);
      const bytes = body ?? new Uint8Array();
      if (Number.isFinite(declared) && declared !== bytes.length) return { status: 413, bytes: new Uint8Array() };
      await this.objects.simulateUpload(signed.url, bytes, signed.headers?.["content-type"] ?? "application/octet-stream");
      return { status: 204, bytes: new Uint8Array() };
    }
    return { status: 200, bytes: await this.objects.simulateDownload(signed.url) };
  }

  async call(op: string, input: unknown, ctx: CallContext): Promise<CallResult> {
    const exit = await Effect.runPromiseExit(this.engine.call(op, input, { tenant: ctx.tenant, actor: ctx.actor, requestId: "conformance", ...(ctx.idempotencyKey ? { idempotencyKey: ctx.idempotencyKey } : {}) }));
    if (exit._tag === "Success") return { ok: true, value: exit.value };
    const e = Cause.squash(exit.cause);
    if (e instanceof ForgeError) return { ok: false, code: e.code, detail: e.problem("conformance") };
    throw e;
  }
}
