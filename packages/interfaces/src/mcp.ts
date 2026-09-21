/**
 * MCP server over the same operation model (FORGE-054, PAR-120/121).
 *
 * Tools are generated from the deployment's OpenAPI projection (one tool per
 * exposed operation, input schema = the unary envelope the engine accepts).
 * `tools/list` is computed per (identity, purpose, policy epoch): purpose
 * surfaces and operation-level authorizer decisions decide what a principal
 * sees, and the listing cache is keyed by that identity so a warm cache never
 * serves another principal. `tools/call` never trusts the listing: it runs the
 * engine, which re-checks scope and authority per record. Tool annotations
 * come from the contract kind; anything a client sends under `annotations` or
 * `_meta` is ignored when deciding.
 *
 * Transport: JSON-RPC 2.0 messages, one per request (the 2025-06-18 profile
 * has no batching). `mcpHttp` mounts it on the Forge HTTP handler behind the
 * same authentication as every other route.
 */
import { Cause, Effect } from "effect";
import type { CallContext, Engine, Principal, Resource } from "@forgegraph/runtime";
import { ForgeError, discovery } from "@forgegraph/runtime";

/** Protocol revisions this server implements, newest first (pinned matrix). */
export const PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26"] as const;

export interface JsonRpcRequest { jsonrpc: "2.0"; id?: number | string | null; method: string; params?: unknown }
export interface JsonRpcResponse { jsonrpc: "2.0"; id: number | string | null; result?: unknown; error?: { code: number; message: string; data?: unknown } }

export interface McpTool {
  name: string;
  title: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations: { readOnlyHint: boolean; destructiveHint: boolean; idempotentHint: boolean; openWorldHint: boolean };
  /** Operation the tool invokes (never sent to clients). */
  operationId: string;
  kind: string;
  resource: Resource | null;
}

export interface McpServerOptions {
  engine: Engine;
  authScheme?: string;
  /** Listing cache TTL; the policy epoch is part of the key regardless. */
  cacheTtlMs?: number;
}

export interface McpServer {
  catalogue: McpTool[];
  handle(principal: Principal, message: JsonRpcRequest, ctx: { purpose?: string }): Promise<JsonRpcResponse | null>;
  toolsFor(principal: Principal, purpose: string | undefined): Promise<McpTool[]>;
}

const snake = (s: string) => s.replace(/([a-z0-9])([A-Z])/g, "$1_$2").replace(/[^A-Za-z0-9]+/g, "_").toLowerCase().replace(/^_+|_+$/g, "");
const kebab = (name: string) => name.replace(/([a-z0-9])([A-Z])/g, "$1-$2").replace(/([A-Z])([A-Z][a-z])/g, "$1-$2").toLowerCase();

type Schema = Record<string, unknown>;

/** Inline `#/components/schemas/*` references so a tool schema stands alone (bounded depth). */
function inline(schema: unknown, components: Record<string, Schema>, depth = 0): unknown {
  if (depth > 8 || schema === null || typeof schema !== "object") return schema;
  if (Array.isArray(schema)) return schema.map((s) => inline(s, components, depth + 1));
  const obj = schema as Schema;
  const ref = obj["$ref"];
  if (typeof ref === "string" && ref.startsWith("#/components/schemas/")) {
    const target = components[ref.slice("#/components/schemas/".length)];
    return target ? inline(target, components, depth + 1) : { type: "object" };
  }
  const out: Schema = {};
  for (const [k, v] of Object.entries(obj)) out[k] = inline(v, components, depth + 1);
  return out;
}

interface OpenApiOp { operationId: string; "x-forge-kind"?: string; parameters?: { name: string; in: string; required?: boolean; schema?: Schema }[]; requestBody?: { content?: Record<string, { schema?: Schema }> }; tags?: string[] }

function catalogueFrom(engine: Engine): McpTool[] {
  const doc = engine.model.bundle.openapi as { paths?: Record<string, Record<string, OpenApiOp>>; components?: { schemas?: Record<string, Schema> } } | undefined;
  if (!doc?.paths) return [];
  const components = doc.components?.schemas ?? {};
  const tools: McpTool[] = [];
  const body = (op: OpenApiOp): Schema => inline(op.requestBody?.content?.["application/json"]?.schema ?? { type: "object" }, components) as Schema;
  const id = { type: "string", description: "Record id" };
  const version = { type: "integer", minimum: 1, description: "Expected current version (optimistic concurrency); mismatch is VersionConflict" };
  for (const [path, ops] of Object.entries(doc.paths)) {
    for (const [method, op] of Object.entries(ops)) {
      const kind = op["x-forge-kind"] ?? "function";
      const ref = engine.model.operation(op.operationId);
      const resource = ref?.resource ?? null;
      const fn = engine.model.function(op.operationId);
      const pathParams = [...path.matchAll(/\{([^}]+)\}/g)].map((m) => m[1]!);
      let input: Schema;
      let name: string;
      const short = op.operationId.slice(op.operationId.lastIndexOf("/_/") + 3);
      switch (kind) {
        case "create":
          input = body(op);
          break;
        case "get":
        case "download":
        case "children":
        case "ancestors":
          input = { type: "object", properties: { id }, required: ["id"], additionalProperties: false };
          break;
        case "update":
          input = { type: "object", properties: { id, expectedVersion: version, patch: body(op) }, required: ["id", "expectedVersion", "patch"], additionalProperties: false };
          break;
        case "transition":
          input = { type: "object", properties: { id, expectedVersion: version, input: body(op) }, required: ["id", "expectedVersion"], additionalProperties: false };
          break;
        case "delete":
        case "restore":
        case "finalizeUpload":
          input = { type: "object", properties: { id, expectedVersion: version }, required: ["id", "expectedVersion"], additionalProperties: false };
          break;
        case "move":
        case "beginUpload":
          input = { type: "object", properties: { id, expectedVersion: version, ...((body(op)["properties"] as Schema | undefined) ?? {}) }, required: ["id", "expectedVersion"], additionalProperties: false };
          break;
        case "find":
        case "list":
        case "effective": {
          const params: Schema = {};
          const required: string[] = [];
          for (const p of op.parameters ?? []) {
            if (p.in !== "query" || p.name === "cursor" || p.name === "limit") continue;
            params[p.name] = inline(p.schema ?? { type: "string" }, components);
            if (p.required) required.push(p.name);
          }
          input = { type: "object", properties: { params: { type: "object", properties: params, required, additionalProperties: false }, ...(kind === "list" ? { cursor: { type: "string" }, limit: { type: "integer", minimum: 1, maximum: 100 } } : {}) }, required: ["params"], additionalProperties: false };
          break;
        }
        case "function":
        case "workflow.start": {
          const b = body(op);
          const props: Schema = { ...((b["properties"] as Schema | undefined) ?? {}) };
          const required = [...((b["required"] as string[] | undefined) ?? [])];
          for (const p of pathParams) { props[p] = { type: "string" }; required.push(p); }
          input = { type: "object", properties: props, required, additionalProperties: false };
          break;
        }
        default:
          continue; // workflow get/cancel/signal are not exposed as tools in this profile
      }
      if (kind === "function") name = snake(fn?.name ?? short);
      else if (kind === "workflow.start") name = `${snake(short.replace(/\.start$/, ""))}_start`;
      else name = snake(short);
      const readOnly = ["get", "find", "list", "effective", "children", "ancestors", "download"].includes(kind);
      tools.push({
        name,
        title: `${op.tags?.[0] ?? ""} ${short}`.trim(),
        description: `${method.toUpperCase()} ${path} (${op.operationId})`,
        inputSchema: input,
        annotations: { readOnlyHint: readOnly, destructiveHint: kind === "delete", idempotentHint: ["get", "find", "list", "update", "delete", "restore", "effective"].includes(kind), openWorldHint: false },
        operationId: op.operationId,
        kind,
        resource,
      });
    }
  }
  tools.sort((a, b) => a.name.localeCompare(b.name));
  return tools;
}

export function createMcpServer(o: McpServerOptions): McpServer {
  const engine = o.engine;
  const catalogue = catalogueFrom(engine);
  const ttl = o.cacheTtlMs ?? 60_000;
  const listings = new Map<string, { tools: McpTool[]; until: number }>();

  /** Visibility = purpose surface permits the operation kind AND the authorizer allows the operation. */
  const visible = async (t: McpTool, ctx: CallContext): Promise<boolean> => {
    if (t.resource) {
      const surface = await Effect.runPromiseExit(engine.scope.resolve(t.resource, ctx));
      if (surface._tag === "Failure") return false;
      const s = surface.value;
      if (s) {
        const has = (verb: string) => s.allowAtoms.some((a) => a.verb === verb);
        const ok = t.kind === "create" ? has("create") : t.kind === "update" ? has("update") : t.kind === "transition" || t.kind === "delete" || t.kind === "restore" ? has("actions") : has("read");
        if (!ok) return false;
      }
    }
    const d = await Effect.runPromiseExit(engine.gatekeeper.decide(t.operationId, "operation", t.resource, ctx));
    return d._tag === "Success" && d.value.effect === "allow";
  };

  const toolsFor = async (principal: Principal, purpose: string | undefined): Promise<McpTool[]> => {
    const epoch = engine.gatekeeper.authorizer?.epoch ?? 0;
    const key = `${epoch}|${principal.tenant}|${principal.actor}|${principal.issuer ?? ""}|${purpose ?? ""}`;
    const hit = listings.get(key);
    if (hit && hit.until > Date.now()) return hit.tools;
    const ctx: CallContext = { tenant: principal.tenant, actor: principal.actor, requestId: `mcp-list-${crypto.randomUUID()}`, ...(purpose ? { purpose } : {}) };
    const out: McpTool[] = [];
    for (const t of catalogue) if (await visible(t, ctx)) out.push(t);
    listings.set(key, { tools: out, until: Date.now() + ttl });
    return out;
  };

  const publicTool = (t: McpTool) => ({ name: t.name, title: t.title, description: t.description, inputSchema: t.inputSchema, annotations: t.annotations });
  const resourceTemplates = engine.model.resources.filter((r) => r.operations.some((op) => op.kind === "get" && op.http)).map((r) => ({ uriTemplate: `forge://${kebab(r.name)}/{id}`, name: r.name, mimeType: "application/json", resource: r }));

  const reply = (id: JsonRpcRequest["id"], result: unknown): JsonRpcResponse => ({ jsonrpc: "2.0", id: id ?? null, result });
  const fail = (id: JsonRpcRequest["id"], code: number, message: string, data?: unknown): JsonRpcResponse => ({ jsonrpc: "2.0", id: id ?? null, error: { code, message, ...(data !== undefined ? { data } : {}) } });

  const call = async (operationId: string, input: unknown, principal: Principal, purpose: string | undefined, id: JsonRpcRequest["id"]) => {
    const ctx: CallContext = { tenant: principal.tenant, actor: principal.actor, requestId: `mcp-${crypto.randomUUID()}`, ...(purpose ? { purpose } : {}) };
    const exit = await Effect.runPromiseExit(engine.call(operationId, input, ctx));
    if (exit._tag === "Success") {
      const value = exit.value as Record<string, unknown>;
      return reply(id, { content: [{ type: "text", text: JSON.stringify(value) }], structuredContent: value });
    }
    const e = Cause.squash(exit.cause);
    if (e instanceof ForgeError) return reply(id, { isError: true, content: [{ type: "text", text: JSON.stringify(e.problem(ctx.requestId)) }] });
    return fail(id, -32603, "internal error");
  };

  return {
    catalogue,
    toolsFor,
    async handle(principal, message, ctx) {
      const { id, method } = message;
      const params = (message.params ?? {}) as Record<string, unknown>;
      const notification = id === undefined;
      if (message.jsonrpc !== "2.0" || typeof method !== "string") return notification ? null : fail(id, -32600, "invalid request");
      const purpose = ctx.purpose;
      if (purpose && principal.purposes && !principal.purposes.includes(purpose)) return notification ? null : fail(id, -32001, "the credential does not allow the requested purpose");
      if (notification) return null; // notifications/initialized, notifications/cancelled: nothing to do
      switch (method) {
        case "initialize": {
          const asked = String(params["protocolVersion"] ?? "");
          const version = (PROTOCOL_VERSIONS as readonly string[]).includes(asked) ? asked : PROTOCOL_VERSIONS[0];
          return reply(id, { protocolVersion: version, capabilities: { tools: { listChanged: false }, resources: { subscribe: false, listChanged: false } }, serverInfo: { name: engine.model.bundle.ir.package.name, version: engine.model.bundle.ir.package.version }, instructions: "Tools mirror the deployment's contract; every call is authorized by the server, purpose is selected per session." });
        }
        case "ping":
          return reply(id, {});
        case "tools/list":
          return reply(id, { tools: (await toolsFor(principal, purpose)).map(publicTool) });
        case "tools/call": {
          // `annotations`, `_meta` and any other client-side hints are not inputs to the decision.
          const name = String(params["name"] ?? "");
          const tool = catalogue.find((t) => t.name === name);
          if (!tool) return fail(id, -32602, `unknown tool ${name}`);
          return call(tool.operationId, params["arguments"] ?? {}, principal, purpose, id);
        }
        case "resources/list":
          return reply(id, { resources: [
            { uri: "forge://discovery", name: "discovery", title: "Deployment discovery", mimeType: "application/json" },
            { uri: "forge://openapi", name: "openapi", title: "OpenAPI projection", mimeType: "application/json" },
          ] });
        case "resources/templates/list":
          return reply(id, { resourceTemplates: resourceTemplates.map((t) => ({ uriTemplate: t.uriTemplate, name: t.name, mimeType: t.mimeType })) });
        case "resources/read": {
          const uri = String(params["uri"] ?? "");
          if (uri === "forge://discovery") return reply(id, { contents: [{ uri, mimeType: "application/json", text: JSON.stringify(discovery(engine.model, { scheme: o.authScheme ?? "bearer", authenticate: async () => principal })) }] });
          if (uri === "forge://openapi") return reply(id, { contents: [{ uri, mimeType: "application/json", text: JSON.stringify(engine.model.bundle.openapi ?? {}) }] });
          const m = /^forge:\/\/([^/]+)\/([^/]+)$/.exec(uri);
          const tpl = m && resourceTemplates.find((t) => t.uriTemplate === `forge://${m[1]}/{id}`);
          if (!tpl) return fail(id, -32002, "resource not found", { uri });
          const get = tpl.resource.operations.find((op) => op.kind === "get")!;
          const r = await call(get.id, { id: decodeURIComponent(m![2]!) }, principal, purpose, id);
          const res = r.result as { isError?: boolean; content: { text: string }[] } | undefined;
          if (!res) return r;
          if (res.isError) return fail(id, -32002, "resource not found", { uri });
          return reply(id, { contents: [{ uri, mimeType: "application/json", text: res.content[0]!.text }] });
        }
        default:
          return fail(id, -32601, `method not found: ${method}`);
      }
    },
  };
}

/** Mount handler for `createHttpHandler({ mounts: { "/forge/mcp": mcpHttp(server) } })`: Streamable HTTP, POST only. */
export function mcpHttp(server: McpServer): (req: Request, principal: Principal, requestId: string) => Promise<Response> {
  return async (req, principal, requestId) => {
    const headers = { "content-type": "application/json", "x-request-id": requestId };
    if (req.method !== "POST") return new Response(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "POST a single JSON-RPC message; this server streams nothing" } }), { status: 405, headers: { ...headers, allow: "POST" } });
    let message: JsonRpcRequest;
    try {
      message = (await req.json()) as JsonRpcRequest;
    } catch {
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } }), { status: 400, headers });
    }
    if (Array.isArray(message)) return new Response(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "batching is not supported" } }), { status: 400, headers });
    const purpose = req.headers.get("x-forge-purpose") ?? undefined;
    const res = await server.handle(principal, message, purpose ? { purpose } : {});
    if (res === null) return new Response(null, { status: 202, headers: { "x-request-id": requestId } });
    return new Response(JSON.stringify(res), { status: 200, headers });
  };
}
