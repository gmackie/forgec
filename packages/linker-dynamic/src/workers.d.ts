// The slice of `cloudflare:workers` and the Worker Loader binding this package uses. Kept local so the
// package type-checks without pulling @cloudflare/workers-types' globals over the DOM lib.
declare module "cloudflare:workers" {
  export abstract class WorkerEntrypoint<Env = unknown, Props = unknown> {
    protected ctx: ExecutionContextLike<Props>;
    protected env: Env;
    constructor(ctx: ExecutionContextLike<Props>, env: Env);
  }
  export abstract class WorkflowEntrypoint<Env = unknown, Params = unknown> {
    protected ctx: ExecutionContextLike;
    protected env: Env;
    constructor(ctx: ExecutionContextLike, env: Env);
    abstract run(event: { payload: Params; instanceId?: string }, step: WorkflowStepLike): Promise<unknown>;
  }
  export interface WorkflowStepLike {
    do<T>(name: string, fn: () => Promise<T>): Promise<T>;
    sleep(name: string, ms: number): Promise<void>;
    waitForEvent(name: string, opts: { type: string; timeout?: string | number }): Promise<unknown>;
  }
  export interface ExecutionContextLike<Props = unknown> {
    waitUntil(p: Promise<unknown>): void;
    readonly props: Props;
    readonly exports: Record<string, (options: { props: unknown }) => unknown>;
  }
}

interface WorkerLoaderCode {
  compatibilityDate: string;
  compatibilityFlags?: string[];
  mainModule: string;
  modules: Record<string, string | { js: string } | { json: unknown } | { text: string } | { data: ArrayBuffer } | { wasm: ArrayBuffer }>;
  env?: Record<string, unknown>;
  globalOutbound?: unknown | null;
}

interface WorkerStubLike {
  getEntrypoint(name?: string): { fetch(input: Request | string, init?: RequestInit): Promise<Response> } & Record<string, (...args: any[]) => Promise<any>>;
}

interface WorkerLoaderLike {
  get(id: string, getCode: () => WorkerLoaderCode | Promise<WorkerLoaderCode>): WorkerStubLike;
}
