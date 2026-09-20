/**
 * A conformance target: anything that executes Forge operations by stable
 * operation id with canonical JSON in and out. Implementations: the
 * in-memory semantic model, a local D1/SQLite adapter, DynamoDB Local, and
 * HTTP clients for deployed Cloudflare/AWS stacks.
 */
export interface CallContext {
  tenant: string;
  actor: string;
  idempotencyKey?: string;
}

export type CallResult = { ok: true; value: unknown } | { ok: false; code: string; detail?: unknown };

export interface Target {
  readonly name: string;
  reset(): Promise<void>;
  call(op: string, input: unknown, ctx: CallContext): Promise<CallResult>;
  /** Transfer bytes to/from a signed URL returned by the target (blob scenarios). */
  transfer?(signed: { url: string; method: string; headers?: Record<string, string> }, body?: Uint8Array): Promise<{ status: number; bytes: Uint8Array }>;
}
