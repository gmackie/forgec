// FORG-42: the contract between a packed script and the shared runtime Worker
// (strategy `per-entry-point-shared`). A shared script holds its routing, its unit modules and its
// app.json slice, and no engine. It calls the runtime Worker over a service binding (Workers RPC),
// passing a `ScriptCapabilities` RpcTarget: the only way the runtime reaches a binding, a unit or the
// slice. The runtime Worker itself is linked with no bindings at all, so it can never hand a script
// more than the script handed it.
//
// Types only, apart from the error codec, so the script side imports no runtime code.

/** One env binding a script hands the runtime, by its manifest type (`d1`, `r2`, `queue-producer`, …). */
export interface SharedBinding {
  name: string;
  type: string;
}

/** What the link decided for a shared script: static, embedded in the script, passed on every call. */
export interface SharedMeta {
  script: string;
  /** sha256 (hex) of the script's `app.slice.json` text; the runtime caches the slice by it and re-checks it on a miss. */
  sliceHash: string;
  /** Runtime features linked for the slice (FORG-37), and whether blob storage is. */
  features: string[];
  objects: boolean;
  /** Bindings the script holds and hands over (secrets and vars travel by value, see `values`). */
  bindings: SharedBinding[];
  /** Bindings declared for other scripts: the runtime gives the engine a refusing stub for each (FORG-34). */
  withheld: Array<{ type: string; name: string }>;
  sweeps: { outbox: boolean; schedules: boolean; workflows: boolean };
  /** The script's function units (ids, and whether each is transactional) and externals: they run in the script. */
  functions: Array<{ id: string; transactional?: boolean }>;
  externals: string[];
}

/** What a function unit's `deps` exposes, so the script can build the same object the engine would. */
export interface DepsShape {
  resources: string[];
  transitions: Record<string, string[]>;
}

export interface SerializedError {
  code: string;
  detail?: string;
  fields?: unknown;
  constraint?: string;
  budget?: Record<string, number>;
  denial?: unknown;
}

export type Outcome<T = unknown> = { ok: true; value: T } | { ok: false; error: SerializedError };

/** The engine's view of a function unit's dependencies, reached back from the script (an RpcTarget on the runtime side). */
export interface RemoteDeps {
  call(path: string[], args: unknown[]): Promise<Outcome>;
}

/** The script side of a request (an RpcTarget). Every method is scoped to the script's own bindings. */
export interface ScriptCapabilities {
  slice(): Promise<unknown>;
  d1(binding: string, op: "first" | "all" | "run", sql: string, params: unknown[]): Promise<unknown>;
  d1Batch(binding: string, statements: Array<{ sql: string; params: unknown[] }>): Promise<unknown>;
  r2(binding: string, op: "head" | "get" | "put" | "delete", key: string, value?: unknown, options?: unknown): Promise<unknown>;
  queue(binding: string, body: unknown, options?: unknown): Promise<void>;
  workflow(binding: string, op: "create" | "sendEvent", arg: unknown): Promise<void>;
  durable(binding: string, name: string, request: Request): Promise<Response>;
  invoke(id: string, input: unknown, ctx: unknown, deps: RemoteDeps, shape: DepsShape): Promise<Outcome>;
  external(id: string, input: unknown, ctx: unknown): Promise<unknown>;
}

/** The runtime Worker's RPC surface (its default entrypoint). */
export interface SharedRuntime {
  serve(request: Request, caps: ScriptCapabilities, meta: SharedMeta, values: Record<string, string>): Promise<{ response: Response; dispatch: string[] }>;
  queue(queue: string, bodies: unknown[], caps: ScriptCapabilities, meta: SharedMeta, values: Record<string, string>): Promise<Array<"ack" | "retry">>;
  scheduled(event: { cron?: string; scheduledTime?: number }, caps: ScriptCapabilities, meta: SharedMeta, values: Record<string, string>): Promise<void>;
}

/** The service binding a shared script reaches the runtime Worker through. */
export const RUNTIME_BINDING = "FORGE_RUNTIME";

/** The header that carries a shared request's Workers stage across a fetch hop: router -> script, script -> dispatch owner or Durable Object (FORG-49). */
export const DEPTH_HEADER = "x-forge-depth";

/** A ForgeError's fields as plain data (an RPC hop keeps only an Error's message). */
export function serializeError(e: unknown): SerializedError {
  const x = e as Partial<SerializedError> & { message?: string };
  if (x && typeof x === "object" && typeof x.code === "string") {
    const out: SerializedError = { code: x.code };
    if (x.detail !== undefined) out.detail = x.detail;
    if (x.fields !== undefined) out.fields = x.fields;
    if (x.constraint !== undefined) out.constraint = x.constraint;
    if (x.budget !== undefined) out.budget = x.budget;
    if (x.denial !== undefined) out.denial = x.denial;
    return out;
  }
  return { code: "Internal", detail: String(x?.message ?? e) };
}
