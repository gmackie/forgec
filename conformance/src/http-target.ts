/** Conformance target over a deployed endpoint, through the generated client (the same client for every provider). */
import type { CallContext, CallResult, Target } from "./target.js";

export interface ClientModule {
  createClient(options: { baseUrl: string; tenant?: string; actor?: string; headers?: Record<string, string> }): {
    call(op: string, input: unknown, opts?: { idempotencyKey?: string }): Promise<{ ok: true; value: unknown } | { ok: false; code: string; status: number; problem: unknown }>;
  };
}

export class HttpTarget implements Target {
  readonly name: string;
  constructor(private readonly client: ClientModule, private readonly baseUrl: string, name = "http") {
    this.name = name;
  }
  async reset(): Promise<void> {
    /* remote targets are not reset; scenarios run in fresh tenants */
  }
  async transfer(signed: { url: string; method: string; headers?: Record<string, string> }, body?: Uint8Array): Promise<{ status: number; bytes: Uint8Array }> {
    // The client always sends its real content-length (a mismatched header cannot even be transmitted);
    // whether the store accepts bytes that differ from the upload intent is the server's decision.
    const headers = { ...(signed.headers ?? {}) };
    delete headers["content-length"];
    const res = await fetch(signed.url, { method: signed.method, headers, body: body ? new Blob([body as BlobPart]) : null });
    return { status: res.status, bytes: new Uint8Array(await res.arrayBuffer()) };
  }

  async call(op: string, input: unknown, ctx: CallContext): Promise<CallResult> {
    const c = this.client.createClient({ baseUrl: this.baseUrl, tenant: ctx.tenant, actor: ctx.actor });
    const r = await c.call(op, input, ctx.idempotencyKey ? { idempotencyKey: ctx.idempotencyKey } : undefined);
    return r.ok ? { ok: true, value: r.value } : { ok: false, code: r.code, detail: r.problem };
  }
}
