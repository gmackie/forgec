/**
 * Callable transport bindings (FORGE-053, PAR-119). One unary envelope —
 * `invoke(operationId, input, options)` — bound either to an in-process
 * engine or to an authenticated HTTP deployment. Outcomes are typed and keep
 * two failure classes apart: a *business* outcome is a Problem the contract
 * declares (validation, precondition, domain error, not found); an
 * *invocation failure* is the binding failing to perform the call at all
 * (transport, malformed reply, contract/audience mismatch). A remote binding
 * that expects a particular contract checks discovery before its first
 * operation, so a mismatch fails before anything is disclosed or written.
 *
 * Nothing here needs Effect: the local binding runs the engine's Effects and
 * the HTTP binding is plain fetch.
 */
import { Cause, Effect } from "effect";
import type { CallContext, Engine, Principal } from "@forge/runtime";
import { ForgeError } from "@forge/runtime";

export interface Problem {
  type?: string;
  title?: string;
  status: number;
  code: string;
  detail?: string;
  requestId?: string;
  retryable?: boolean;
  fields?: { path: string; code: string; message: string }[];
}

export type Outcome<T = unknown> =
  | { kind: "ok"; value: T; version?: number }
  | { kind: "error"; problem: Problem }
  | { kind: "invocationFailed"; reason: "transport" | "malformed" | "contract-mismatch" | "unauthenticated"; detail: string; retryable: boolean };

export interface InvokeOptions {
  purpose?: string;
  idempotencyKey?: string;
}

export interface Callable {
  invoke(operationId: string, input: unknown, options?: InvokeOptions): Promise<Outcome>;
}

// ------------------------------------------------------------------- local
/** Bind a callable to an in-process engine under a fixed principal. */
export function localCallable(engine: Engine, principal: Principal): Callable {
  return {
    async invoke(operationId, input, options = {}) {
      if (options.purpose && principal.purposes && !principal.purposes.includes(options.purpose)) {
        return { kind: "error", problem: { code: "NotPermitted", status: 403, detail: "the credential does not allow the requested purpose" } };
      }
      const ctx: CallContext = { tenant: principal.tenant, actor: principal.actor, requestId: crypto.randomUUID(), ...(options.purpose ? { purpose: options.purpose } : {}), ...(options.idempotencyKey ? { idempotencyKey: options.idempotencyKey } : {}) };
      const exit = await Effect.runPromiseExit(engine.call(operationId, input, ctx));
      if (exit._tag === "Success") {
        const value = exit.value as Record<string, unknown>;
        return { kind: "ok", value, ...(value && typeof value["version"] === "number" ? { version: value["version"] } : {}) };
      }
      const e = Cause.squash(exit.cause);
      if (e instanceof ForgeError) return { kind: "error", problem: e.problem(ctx.requestId) as unknown as Problem };
      return { kind: "invocationFailed", reason: "malformed", detail: String((e as Error)?.message ?? e), retryable: false };
    },
  };
}

// -------------------------------------------------------------------- http
export type Credential =
  | { kind: "bearer"; token: string }
  | { kind: "dev-header"; tenant: string; actor: string };

export interface HttpCallableOptions {
  baseUrl: string;
  credential: Credential;
  fetch?: typeof fetch;
  /** Contract expectation, checked against discovery before the first operation. */
  expect?: { contracts?: string; wire?: string; buildHash?: string };
  /** Default purpose header for every call. */
  purpose?: string;
}

interface RouteInfo { method: string; path: string; kind: string; pathParams: string[] }

function credentialHeaders(c: Credential): Record<string, string> {
  return c.kind === "bearer" ? { authorization: `Bearer ${c.token}` } : { "x-forge-tenant": c.tenant, "x-forge-actor": c.actor };
}

/** Map the unary input envelope onto the HTTP binding of an operation kind (mirror of http.ts). */
export function toHttpRequest(route: RouteInfo, input: Record<string, unknown>): { path: string; body?: unknown; headers: Record<string, string> } {
  const headers: Record<string, string> = {};
  let path = route.path;
  const query = new URLSearchParams();
  const fill = (params: Record<string, unknown>) => {
    for (const p of route.pathParams) path = path.replace(`{${p}}`, encodeURIComponent(String(params[p] ?? "")));
  };
  let body: unknown;
  const ifMatch = () => { if (input["expectedVersion"] !== undefined) headers["if-match"] = `"${String(input["expectedVersion"])}"`; };
  switch (route.kind) {
    case "create":
    case "changeset.propose":
    case "workflow.start":
    case "schedule.tick":
      body = input;
      fill(input);
      break;
    case "update":
      fill(input);
      ifMatch();
      body = input["patch"] ?? {};
      break;
    case "transition":
      fill(input);
      ifMatch();
      body = input["input"] ?? {};
      break;
    case "delete":
    case "restore":
    case "finalizeUpload":
      fill(input);
      ifMatch();
      break;
    case "move":
    case "beginUpload": {
      fill(input);
      ifMatch();
      const { id: _id, expectedVersion: _v, ...rest } = input;
      void _id; void _v;
      body = rest;
      break;
    }
    case "find":
    case "list":
    case "view.query":
    case "effective": {
      const params = (input["params"] ?? {}) as Record<string, unknown>;
      for (const [k, v] of Object.entries(params)) query.set(k, String(v));
      if (input["cursor"]) query.set("cursor", String(input["cursor"]));
      if (input["limit"]) query.set("limit", String(input["limit"]));
      break;
    }
    case "cache.read":
      for (const [k, v] of Object.entries((input["key"] ?? {}) as Record<string, unknown>)) query.set(k, String(v));
      break;
    case "function": {
      fill(input);
      ifMatch();
      const rest: Record<string, unknown> = { ...input };
      for (const p of route.pathParams) delete rest[p];
      body = rest;
      break;
    }
    default:
      fill(input);
      if (route.method !== "GET") {
        const rest: Record<string, unknown> = { ...input };
        for (const p of route.pathParams) delete rest[p];
        delete rest["id"];
        body = rest;
      }
  }
  const qs = query.toString();
  return { path: qs ? `${path}?${qs}` : path, ...(body !== undefined ? { body } : {}), headers };
}

/** Bind a callable to a deployment over HTTP. Routes come from the deployment's own OpenAPI projection. */
export function httpCallable(o: HttpCallableOptions): Callable {
  const f = o.fetch ?? fetch;
  const base = o.baseUrl.replace(/\/$/, "");
  const auth = credentialHeaders(o.credential);
  let routes: Promise<Map<string, RouteInfo> | Outcome> | null = null;

  const load = async (): Promise<Map<string, RouteInfo> | Outcome> => {
    let disc: Response;
    try {
      disc = await f(`${base}/forge/discovery`, { headers: auth });
    } catch (e) {
      return { kind: "invocationFailed", reason: "transport", detail: String((e as Error).message ?? e), retryable: true };
    }
    if (disc.status === 401 || disc.status === 403) return { kind: "invocationFailed", reason: "unauthenticated", detail: "the credential is not accepted by this deployment", retryable: false };
    if (!disc.ok) return { kind: "invocationFailed", reason: "malformed", detail: `discovery answered ${disc.status}`, retryable: disc.status >= 500 };
    const d = (await disc.json()) as { contracts?: { version?: string }; digests?: Record<string, string>; buildHash?: string };
    if (o.expect) {
      const mismatches: string[] = [];
      if (o.expect.contracts && d.contracts?.version !== o.expect.contracts) mismatches.push(`contracts ${String(d.contracts?.version)} != ${o.expect.contracts}`);
      if (o.expect.wire && d.digests?.["wire"] !== o.expect.wire) mismatches.push(`wire digest ${String(d.digests?.["wire"])} != ${o.expect.wire}`);
      if (o.expect.buildHash && d.buildHash !== o.expect.buildHash) mismatches.push(`buildHash ${String(d.buildHash)} != ${o.expect.buildHash}`);
      // A mismatch is a compatibility question (`forge compat`), never assumed equivalence.
      if (mismatches.length) return { kind: "invocationFailed", reason: "contract-mismatch", detail: mismatches.join("; "), retryable: false };
    }
    const spec = await f(`${base}/forge/openapi.json`, { headers: auth });
    if (!spec.ok) return { kind: "invocationFailed", reason: "malformed", detail: `openapi answered ${spec.status}`, retryable: false };
    const doc = (await spec.json()) as { paths: Record<string, Record<string, { operationId: string; "x-forge-kind"?: string }>> };
    const map = new Map<string, RouteInfo>();
    for (const [path, ops] of Object.entries(doc.paths)) {
      for (const [method, op] of Object.entries(ops)) {
        map.set(op.operationId, { method: method.toUpperCase(), path, kind: op["x-forge-kind"] ?? "function", pathParams: [...path.matchAll(/\{([^}]+)\}/g)].map((m) => m[1]!) });
      }
    }
    return map;
  };

  return {
    async invoke(operationId, input, options = {}) {
      routes ??= load();
      const table = await routes;
      if (!(table instanceof Map)) { routes = null; return table; }
      const route = table.get(operationId);
      if (!route) return { kind: "error", problem: { code: "MethodNotAllowed", status: 405, detail: `unknown operation ${operationId}` } };
      const r = toHttpRequest(route, (input ?? {}) as Record<string, unknown>);
      const headers: Record<string, string> = { ...auth, ...r.headers, accept: "application/json" };
      const purpose = options.purpose ?? o.purpose;
      if (purpose) headers["x-forge-purpose"] = purpose;
      if (options.idempotencyKey) headers["idempotency-key"] = options.idempotencyKey;
      if (r.body !== undefined) headers["content-type"] = "application/json";
      let res: Response;
      try {
        res = await f(`${base}${r.path}`, { method: route.method, headers, ...(r.body !== undefined ? { body: JSON.stringify(r.body) } : {}) });
      } catch (e) {
        return { kind: "invocationFailed", reason: "transport", detail: String((e as Error).message ?? e), retryable: true };
      }
      const text = await res.text();
      let json: unknown;
      try {
        json = text ? JSON.parse(text) : null;
      } catch {
        return { kind: "invocationFailed", reason: "malformed", detail: `non-JSON reply (${res.status})`, retryable: res.status >= 500 };
      }
      if (res.ok) {
        const etag = res.headers.get("etag");
        return { kind: "ok", value: json, ...(etag ? { version: Number(etag.replace(/"/g, "")) } : {}) };
      }
      if (res.status === 401) return { kind: "invocationFailed", reason: "unauthenticated", detail: "the credential is not accepted by this deployment", retryable: false };
      const p = json as Problem | null;
      if (p && typeof p === "object" && typeof p.code === "string") return { kind: "error", problem: p };
      return { kind: "invocationFailed", reason: "malformed", detail: `reply ${res.status} is not a Problem`, retryable: res.status >= 500 };
    },
  };
}
