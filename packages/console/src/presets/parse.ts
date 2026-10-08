/**
 * OpenAPI 3.x JSON or YAML → the flat operation list the integration proxy already calls.
 * YAML and JSON of the same document produce the same operations. Nothing is inferred:
 * an operation without a usable HTTP method is left out.
 */
import { load } from "js-yaml";
import { Problem } from "../model.js";
import type { OpenApiOperation } from "../contract-openapi.js";

const METHODS = new Set(["get", "post", "put", "patch", "delete", "head", "options", "trace"]);

export interface ParsedSpec {
  operations: OpenApiOperation[];
  /** JSON Schemas, keyed like contract IR `components` (the `#/components/schemas` map). */
  components: Record<string, unknown>;
  securitySchemes: Record<string, unknown>;
  /** What `sampleInput` resolves `#/components/schemas/...` against. */
  sampleDoc: { components: { schemas: Record<string, unknown> } };
  document: Record<string, unknown>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function pointer(doc: Record<string, unknown>, ref: string): unknown {
  if (!ref.startsWith("#/")) return undefined;
  return ref
    .slice(2)
    .split("/")
    .reduce<unknown>((value, part) => {
      if (!isRecord(value)) return undefined;
      const key = decodeURIComponent(part).replace(/~1/g, "/").replace(/~0/g, "~");
      return value[key];
    }, doc);
}

function operationIdOf(method: string, path: string, op: Record<string, unknown>): string {
  return typeof op.operationId === "string" && op.operationId ? op.operationId : `${method} ${path}`;
}

function parameters(value: unknown, doc: Record<string, unknown>): OpenApiOperation["parameters"] {
  if (!Array.isArray(value)) return [];
  const out: OpenApiOperation["parameters"] = [];
  for (const entry of value) {
    const resolved = isRecord(entry) && typeof entry.$ref === "string" ? pointer(doc, entry.$ref) : entry;
    if (!isRecord(resolved)) continue;
    const location = resolved.in;
    if (location !== "path" && location !== "query" && location !== "header") continue;
    if (typeof resolved.name !== "string" || !resolved.name) continue;
    out.push({
      name: resolved.name,
      in: location,
      required: location === "path" || resolved.required === true,
      schema: resolved.schema ?? {},
    });
  }
  return out;
}

function requestBody(
  op: Record<string, unknown>,
  doc: Record<string, unknown>,
): OpenApiOperation["requestBody"] | undefined {
  const raw = isRecord(op.requestBody) && typeof op.requestBody.$ref === "string" ? pointer(doc, op.requestBody.$ref) : op.requestBody;
  if (!isRecord(raw) || !isRecord(raw.content)) return undefined;
  const content: Record<string, { schema: unknown }> = {};
  for (const [type, body] of Object.entries(raw.content)) {
    if (!isRecord(body)) continue;
    content[type] = { schema: body.schema ?? {} };
  }
  if (!Object.keys(content).length) return undefined;
  return { required: raw.required === true, content };
}

function schemesOf(op: Record<string, unknown>, doc: Record<string, unknown>): string[] {
  const security = op.security ?? doc.security;
  if (!Array.isArray(security)) return [];
  const names: string[] = [];
  for (const requirement of security) {
    if (!isRecord(requirement)) continue;
    for (const name of Object.keys(requirement)) if (!names.includes(name)) names.push(name);
  }
  return names;
}

/** Parse an OpenAPI 3.x document. JSON when the text starts with `{`, otherwise YAML. */
export function parseOpenApiText(raw: string): ParsedSpec {
  const text = raw.replace(/^\uFEFF/, "").trim();
  if (!text) throw new Problem(502, "The preset spec is empty.");
  let value: unknown;
  try {
    value = text.startsWith("{") ? JSON.parse(text) : load(text);
  } catch {
    throw new Problem(502, "The preset spec is not OpenAPI JSON or YAML.");
  }
  if (!isRecord(value)) throw new Problem(502, "The preset spec is not an OpenAPI document.");
  const version = value.openapi;
  if (typeof version !== "string" || !version.startsWith("3."))
    throw new Problem(502, "The preset spec is not OpenAPI 3.");
  const paths = value.paths;
  if (!isRecord(paths)) throw new Problem(502, "The preset spec has no OpenAPI paths.");

  const operations: OpenApiOperation[] = [];
  const seen = new Set<string>();
  for (const [path, item] of Object.entries(paths)) {
    if (!isRecord(item)) continue;
    const shared = parameters(item.parameters, value);
    for (const method of Object.keys(item)) {
      if (!METHODS.has(method)) continue;
      const op = item[method];
      if (!isRecord(op)) continue;
      const operationId = operationIdOf(method, path, op);
      if (seen.has(operationId)) throw new Problem(502, `The preset spec repeats operation ${operationId}.`);
      seen.add(operationId);
      const schemes = schemesOf(op, value);
      const body = requestBody(op, value);
      const tags = Array.isArray(op.tags) ? op.tags.filter((tag): tag is string => typeof tag === "string") : [];
      operations.push({
        operationId,
        method,
        path,
        summary: typeof op.summary === "string" && op.summary ? op.summary : operationId,
        tags: tags.length ? tags : ["preset"],
        parameters: [...shared, ...parameters(op.parameters, value)],
        ...(body ? { requestBody: body } : {}),
        public: schemes.length === 0,
        authentication: schemes.length ? "required" : "none",
        schemes,
      });
    }
  }
  operations.sort((a, b) => a.operationId.localeCompare(b.operationId));
  const components = isRecord(value.components) ? value.components : {};
  const schemas = isRecord(components.schemas) ? components.schemas : {};
  const securitySchemes = isRecord(components.securitySchemes) ? components.securitySchemes : {};
  return {
    operations,
    components: schemas,
    securitySchemes,
    sampleDoc: { components: { schemas } },
    document: value,
  };
}

/** The parsed document, optionally limited to some operation ids, with the integration's server. */
export function openApiView(
  spec: ParsedSpec,
  info: { title: string; serverUrl?: string },
  only: string[] = [],
): Record<string, unknown> {
  const wanted = new Set(only);
  if (only.length && spec.operations.filter((op) => wanted.has(op.operationId)).length !== wanted.size)
    throw new Problem(404, "The contract has no such operation.");
  const doc = structuredClone(spec.document);
  const paths = doc.paths;
  if (only.length && isRecord(paths)) {
    for (const [path, item] of Object.entries(paths)) {
      if (!isRecord(item)) continue;
      for (const method of Object.keys(item)) {
        if (!METHODS.has(method) || !isRecord(item[method])) continue;
        const id = operationIdOf(method, path, item[method] as Record<string, unknown>);
        if (!wanted.has(id)) delete item[method];
      }
      if (!Object.keys(item).some((key) => METHODS.has(key))) delete paths[path];
    }
  }
  const previous = isRecord(doc.info) ? doc.info : {};
  doc.info = { ...previous, title: info.title };
  if (info.serverUrl) doc.servers = [{ url: info.serverUrl }];
  return doc;
}
