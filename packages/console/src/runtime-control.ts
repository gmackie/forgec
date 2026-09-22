import type { UiDescriptor } from "@forgegraph/react";
import { Problem } from "./model.js";
export interface RuntimeTarget {
  id: string;
  name: string;
  endpoint: string;
  token: string;
}
export interface RecordWorkspace {
  buildHash: string;
  deploymentRevision?: string;
  descriptor: UiDescriptor;
  operations: { id: string; method: string; path: string; kind: string }[];
}
export interface Invocation {
  operationId: string;
  input: unknown;
  buildHash: string;
  deploymentRevision?: string | undefined;
  purpose?: string | undefined;
  idempotencyKey?: string | undefined;
}
export interface Operation {
  id: string;
  method: string;
  path: string;
  summary: string;
  kind: string;
  sample: unknown;
  schema: unknown;
  disabledReason?: string;
}
export interface RuntimeCatalog {
  invocationPreconditions?: boolean;
  deploymentRevision?: string;
  buildHash: string;
  observedAt: string;
  operations: Operation[];
}
export function sampleInput(schema: any, doc: any, depth = 0): unknown {
  if (!schema || depth > 8) return null;
  if (schema.example !== undefined) return schema.example;
  if (schema.default !== undefined) return schema.default;
  if (schema.enum?.length) return schema.enum[0];
  if (schema.$ref) {
    if (!schema.$ref.startsWith("#/")) return null;
    const target = schema.$ref
      .slice(2)
      .split("/")
      .reduce(
        (v: any, k: string) => v?.[k.replace(/~1/g, "/").replace(/~0/g, "~")],
        doc,
      );
    return sampleInput(target, doc, depth + 1);
  }
  if (schema.oneOf || schema.anyOf)
    return sampleInput((schema.oneOf || schema.anyOf)[0], doc, depth + 1);
  if (schema.allOf)
    return Object.assign(
      {},
      ...schema.allOf.map((s: any) => sampleInput(s, doc, depth + 1)),
    );
  const type = Array.isArray(schema.type)
    ? schema.type.find((t: string) => t !== "null")
    : schema.type;
  if (type === "object" || schema.properties)
    return Object.fromEntries(
      Object.entries(schema.properties || {})
        .filter(([key]) => !schema.required || schema.required.includes(key))
        .slice(0, 50)
        .map(([key, s]) => [key, sampleInput(s, doc, depth + 1)]),
    );
  if (type === "array")
    return Array.from({ length: Math.min(schema.minItems ?? 1, 3) }, () =>
      sampleInput(schema.items, doc, depth + 1),
    );
  if (type === "boolean") return false;
  if (type === "integer" || type === "number")
    return (
      schema.minimum ??
      (typeof schema.exclusiveMinimum === "number"
        ? schema.exclusiveMinimum + 1
        : 1)
    );
  if (type === "string")
    return (
      (
        {
          email: "person@example.com",
          uuid: "00000000-0000-4000-8000-000000000001",
          "date-time": "2026-01-01T12:00:00Z",
          date: "2026-01-01",
          uri: "https://example.com",
        } as Record<string, string>
      )[schema.format] ?? "sample"
    );
  return null;
}
export class RuntimeConnection {
  readonly public: Omit<RuntimeTarget, "token">;
  constructor(
    private readonly target: RuntimeTarget,
    private readonly fetcher: typeof fetch = fetch,
  ) {
    const url = new URL(target.endpoint);
    if (
      !["https:", "http:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    )
      throw Error("Invalid runtime endpoint");
    this.public = {
      id: target.id,
      name: target.name,
      endpoint: target.endpoint.replace(/\/$/, ""),
    };
  }
  private async request(path: string, init: RequestInit = {}) {
    if (
      !path.startsWith("/") ||
      path.startsWith("//") ||
      /[\\#]/.test(path) ||
      path.split("/").some((p) => p === ".." || p === ".")
    )
      throw new Problem(502, "Invalid runtime operation path.");
    let decoded: string;
    try {
      decoded = decodeURIComponent(path.split("?")[0]!);
    } catch {
      throw new Problem(502, "Invalid runtime operation path.");
    }
    if (
      /[\\#]/.test(decoded) ||
      decoded.split("/").some((p) => p === "." || p === "..")
    )
      throw new Problem(502, "Invalid runtime operation path.");
    const base = new URL(this.public.endpoint + "/");
    const url = new URL(this.public.endpoint + path);
    if (url.origin !== base.origin || !url.pathname.startsWith(base.pathname))
      throw new Problem(502, "Invalid runtime operation path.");
    let response: Response;
    try {
      response = await this.fetcher(url, {
        ...init,
        redirect: "manual",
        signal: AbortSignal.timeout(15000),
        headers: {
          ...init.headers,
          authorization: `Bearer ${this.target.token}`,
          accept: "application/json",
        },
      });
    } catch {
      throw new Problem(
        502,
        "Runtime did not respond within the request deadline.",
      );
    }
    if (response.status >= 300 && response.status < 400)
      throw new Problem(502, "Runtime redirects are not allowed.");
    const reader = response.body?.getReader();
    let size = 0;
    const chunks: Uint8Array[] = [];
    if (reader)
      while (true) {
        const part = await reader.read();
        if (part.done) break;
        size += part.value.length;
        if (size > 2_000_000) {
          await reader.cancel();
          throw new Problem(502, "Runtime response exceeds 2 MB.");
        }
        chunks.push(part.value);
      }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const c of chunks) {
      bytes.set(c, offset);
      offset += c.length;
    }
    let value: any;
    try {
      value = size ? JSON.parse(new TextDecoder().decode(bytes)) : null;
    } catch {
      throw new Problem(502, `Runtime returned non-JSON (${response.status}).`);
    }
    return {
      status: response.status,
      ok: response.ok,
      value,
      build: response.headers.get("x-forge-build"),
      deploymentRevision: response.headers.get("x-forge-deployment"),
    };
  }
  async catalog(): Promise<RuntimeCatalog> {
    const [discovery, spec] = await Promise.all([
      this.request("/forge/discovery"),
      this.request("/forge/openapi.json"),
    ]);
    if (!discovery.ok || !spec.ok)
      throw new Problem(
        502,
        `Runtime discovery failed (${!discovery.ok ? discovery.status : spec.status}).`,
      );
    if (typeof discovery.value?.buildHash !== "string" || !spec.value?.paths)
      throw new Problem(502, "Runtime discovery is incomplete.");
    if (
      discovery.deploymentRevision !== spec.deploymentRevision ||
      discovery.build !== spec.build ||
      (discovery.build && discovery.build !== discovery.value.buildHash)
    )
      throw new Problem(
        409,
        "Runtime changed during discovery; reload the catalog.",
      );
    const operations: Operation[] = [];
    for (const [path, methods] of Object.entries(spec.value.paths))
      for (const [method, op] of Object.entries(methods as object) as [
        string,
        any,
      ][]) {
        if (
          !["get", "post", "put", "patch", "delete"].includes(method) ||
          !op.operationId
        )
          continue;
        // Playground invokes only declared functions. Resource mutations stay in their own management flows.
        if (op["x-forge-kind"] && op["x-forge-kind"] !== "function") continue;
        const schema = op.requestBody?.content?.["application/json"]
          ?.schema || { type: "object", properties: {} };
        operations.push({
          ...(method === "get"
            ? {
                disabledReason:
                  "GET function input binding is not supported by this playground.",
              }
            : {}),
          id: op.operationId,
          method: method.toUpperCase(),
          path,
          kind: op["x-forge-kind"] || "function",
          summary:
            op.summary ||
            op.operationId
              .split("/")
              .at(-1)
              .replace(/([a-z0-9])([A-Z])/g, "$1 $2"),
          sample: sampleInput(schema, spec.value),
          schema,
        });
      }
    return {
      invocationPreconditions:
        discovery.value.features?.includes("invocation-preconditions") === true,
      ...(discovery.deploymentRevision
        ? { deploymentRevision: discovery.deploymentRevision }
        : {}),
      buildHash: discovery.value.buildHash,
      observedAt: new Date().toISOString(),
      operations,
    };
  }
  async workspace(): Promise<RecordWorkspace> {
    const response = await this.request("/forge/workspace.json");
    const value = response.value;
    if (!response.ok)
      throw new Problem(
        response.status === 404 ? 409 : 502,
        "This environment cannot provide a record workspace. Deploy a build with workspace support.",
      );
    if (
      typeof value?.buildHash !== "string" ||
      value?.descriptor?.version !== "ui/1" ||
      !Array.isArray(value.descriptor.resources) ||
      !Array.isArray(value.operations) ||
      response.build !== value.buildHash
    )
      throw new Problem(
        502,
        "The record workspace contract is incomplete or changed. Reload it.",
      );
    return {
      ...value,
      ...(response.deploymentRevision
        ? { deploymentRevision: response.deploymentRevision }
        : {}),
    };
  }
  async record(input: Invocation) {
    const workspace = await this.workspace();
    if (
      workspace.buildHash !== input.buildHash ||
      workspace.deploymentRevision !== input.deploymentRevision
    )
      throw new Problem(
        409,
        "The running application changed. Reopen the record workspace before saving.",
      );
    const op = workspace.operations.find((o) => o.id === input.operationId);
    if (!op)
      throw new Problem(
        404,
        "This operation is not available in the record workspace.",
      );
    const value = input.input as Record<string, any>;
    let path = op.path.replace(/\{([^}]+)\}/g, (_, key: string) => {
      if (value[key] === undefined) throw new Problem(400, `Missing ${key}.`);
      return encodeURIComponent(String(value[key]));
    });
    if (op.method === "GET") {
      const query = new URLSearchParams();
      for (const [key, v] of Object.entries({
        ...value.params,
        ...(value.limit !== undefined ? { limit: value.limit } : {}),
        ...(value.cursor ? { cursor: value.cursor } : {}),
      }))
        if (v !== undefined && v !== null) query.set(key, String(v));
      if (query.size) path += "?" + query;
    }
    const payload =
      op.kind === "update"
        ? value.patch
        : op.kind === "transition"
          ? value.input
          : value;
    const response = await this.request(path, {
      method: op.method,
      headers: {
        "content-type": "application/json",
        "x-forge-if-build": workspace.buildHash,
        ...(workspace.deploymentRevision
          ? { "x-forge-if-deployment": workspace.deploymentRevision }
          : {}),
        ...(value.expectedVersion !== undefined
          ? { "if-match": `"${value.expectedVersion}"` }
          : {}),
        ...(input.purpose ? { "x-forge-purpose": input.purpose } : {}),
        ...(input.idempotencyKey
          ? { "idempotency-key": input.idempotencyKey }
          : {}),
      },
      ...(["GET", "DELETE"].includes(op.method)
        ? {}
        : { body: JSON.stringify(payload ?? {}) }),
    });
    return response.ok
      ? { ok: true, value: response.value }
      : {
          ok: false,
          status: response.status,
          code: response.value?.code || "RequestFailed",
          problem: response.value ?? {
            code: "RequestFailed",
            detail: "The record operation failed.",
          },
        };
  }
  async invoke(input: Invocation) {
    const catalog = await this.catalog();
    if (
      catalog.buildHash !== input.buildHash ||
      catalog.deploymentRevision !== input.deploymentRevision
    )
      throw new Problem(
        409,
        "The running build changed. Reload the function catalog before invoking.",
      );
    const operation = catalog.operations.find(
      (o) => o.id === input.operationId,
    );
    if (!operation)
      throw new Problem(404, "Function is not exposed by this runtime.");
    if (operation.disabledReason)
      throw new Problem(400, operation.disabledReason);
    let path = operation.path;
    const value = input.input as Record<string, unknown>;
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw new Problem(400, "Function input must be a JSON object.");
    path = path.replace(/\{([^}]+)\}/g, (_, key: string) => {
      if (!(key in value))
        throw new Problem(400, `Missing path parameter ${key}.`);
      return encodeURIComponent(String(value[key]));
    });
    if (operation.method === "GET") {
      const query = new URLSearchParams();
      for (const [k, v] of Object.entries(value)) {
        if (!operation.path.includes(`{${k}}`))
          query.set(k, typeof v === "string" ? v : JSON.stringify(v));
      }
      if (query.size) path += "?" + query;
    }
    if (!catalog.deploymentRevision && !catalog.invocationPreconditions)
      throw new Problem(
        409,
        "This runtime does not support invocation preconditions. Upgrade the runtime before invoking.",
      );
    const started = Date.now();
    const response = await this.request(path, {
      method: operation.method,
      headers: {
        "content-type": "application/json",
        "x-forge-if-build": input.buildHash,
        ...(input.deploymentRevision
          ? { "x-forge-if-deployment": input.deploymentRevision }
          : {}),
        ...(input.purpose ? { "x-forge-purpose": input.purpose } : {}),
        ...(input.idempotencyKey
          ? { "idempotency-key": input.idempotencyKey }
          : {}),
      },
      ...(operation.method !== "GET" ? { body: JSON.stringify(value) } : {}),
    });
    return {
      at: new Date().toISOString(),
      durationMs: Date.now() - started,
      status: response.status,
      buildHash: catalog.buildHash,
      outcome: response.ok
        ? { kind: "ok", value: response.value }
        : { kind: "error", problem: response.value },
    };
  }
}
export function runtimeConnections(
  config: { RUNTIME_TARGETS_JSON?: string },
  fetcher: typeof fetch = fetch,
) {
  const values = JSON.parse(config.RUNTIME_TARGETS_JSON || "[]");
  if (!Array.isArray(values))
    throw Error("RUNTIME_TARGETS_JSON must be an array");
  const seen = new Set();
  return values.map((v: any) => {
    if (
      !/^[a-z0-9-]+$/.test(v.id) ||
      typeof v.name !== "string" ||
      typeof v.token !== "string" ||
      !v.token ||
      seen.has(v.id)
    )
      throw Error("Invalid runtime target");
    seen.add(v.id);
    return new RuntimeConnection(v, fetcher);
  });
}
