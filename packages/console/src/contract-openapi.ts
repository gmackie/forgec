/**
 * ForgeGraph contract IR v1 → OpenAPI 3.1.
 *
 * ForgeGraph's registry stores each app's API as its own "operation contract IR" (the format
 * `fg contract publish` sends and forgec will emit). Each operation already carries an OpenAPI
 * path and JSON Schema 2020-12 schemas, so this is a re-shaping, not a translation: nothing is
 * inferred. Operations that are not plain HTTP (RPC transport) are left out and listed in
 * `x-forge-skipped`, never approximated.
 */
import { z } from "zod";

const schemaRef = z
  .object({
    id: z.string().optional(),
    title: z.string().optional(),
    jsonSchema: z.unknown(),
    fingerprint: z.string(),
  })
  .passthrough();
const body = z.object({ contentType: z.string(), schema: schemaRef }).passthrough();
const response = z.object({ status: z.number().int(), bodies: z.array(body) }).passthrough();
const operation = z
  .object({
    id: z.string(),
    serviceId: z.string(),
    groupId: z.string(),
    endpointId: z.string(),
    transport: z.union([
      z.object({ type: z.literal("http"), method: z.string(), path: z.string(), openApiPath: z.string() }).passthrough(),
      z.object({ type: z.literal("rpc"), procedure: z.string() }).passthrough(),
    ]),
    policy: z
      .object({
        isPublic: z.boolean(),
        authentication: z.object({ mode: z.string(), schemes: z.array(z.string()) }).passthrough(),
      })
      .passthrough(),
    request: z
      .object({
        params: schemaRef.optional(),
        query: schemaRef.optional(),
        headers: schemaRef.optional(),
        bodies: z.array(body),
      })
      .passthrough(),
    successes: z.array(response),
    errors: z.array(response),
  })
  .passthrough();
/** The parts of contract IR v1 the conversion reads. ForgeGraph validated the rest on publish. */
export const contractIrSchema = z
  .object({
    irVersion: z.literal(1),
    serviceId: z.string(),
    apiId: z.string(),
    operations: z.array(operation),
    components: z.record(z.string(), z.unknown()),
    securitySchemes: z.record(z.string(), z.unknown()),
    fingerprint: z.string(),
  })
  .passthrough();
export type ContractIr = z.infer<typeof contractIrSchema>;
export type ContractOperation = z.infer<typeof operation>;

export interface OpenApiOperation {
  operationId: string;
  method: string;
  path: string;
  summary: string;
  tags: string[];
  parameters: { name: string; in: "path" | "query" | "header"; required: boolean; schema: unknown }[];
  requestBody?: { required: boolean; content: Record<string, { schema: unknown }> };
  public: boolean;
  authentication: string;
  /** Security scheme names the operation accepts (any-of); empty means anonymous. */
  schemes: string[];
}

const METHODS = new Set(["get", "post", "put", "patch", "delete", "head", "options", "trace"]);

/** Turn an object JSON Schema into one parameter per property. */
function parameters(
  ref: z.infer<typeof schemaRef> | undefined,
  location: "path" | "query" | "header",
): OpenApiOperation["parameters"] {
  const schema = ref?.jsonSchema as { properties?: Record<string, unknown>; required?: string[] } | undefined;
  if (!schema?.properties) return [];
  const required = new Set(schema.required ?? []);
  return Object.entries(schema.properties).map(([name, property]) => ({
    name,
    in: location,
    // OpenAPI requires path parameters to be required.
    required: location === "path" || required.has(name),
    schema: property,
  }));
}

function content(bodies: z.infer<typeof body>[]) {
  return Object.fromEntries(bodies.map((b) => [b.contentType, { schema: b.schema.jsonSchema }]));
}

/** The flat view of one operation the playground and the proxy work from. */
export function describeOperation(op: ContractOperation): OpenApiOperation | null {
  if (op.transport.type !== "http") return null;
  const method = op.transport.method.toLowerCase();
  if (!METHODS.has(method)) return null;
  return {
    operationId: op.id,
    method,
    path: op.transport.openApiPath,
    summary: `${op.groupId}.${op.endpointId}`,
    tags: [op.groupId],
    parameters: [
      ...parameters(op.request.params, "path"),
      ...parameters(op.request.query, "query"),
      ...parameters(op.request.headers, "header"),
    ],
    ...(op.request.bodies.length
      ? { requestBody: { required: true, content: content(op.request.bodies) } }
      : {}),
    public: op.policy.isPublic,
    authentication: op.policy.authentication.mode,
    schemes: op.policy.authentication.schemes,
  };
}

/** A complete OpenAPI 3.1 document for the contract, for display and for the graph importer. */
export function contractToOpenApi(
  contract: ContractIr,
  info: { title: string; serverUrl?: string },
): Record<string, unknown> {
  const paths: Record<string, Record<string, unknown>> = {};
  const skipped: { operationId: string; reason: string }[] = [];
  for (const op of contract.operations) {
    const described = describeOperation(op);
    if (!described) {
      skipped.push({
        operationId: op.id,
        reason: op.transport.type === "http" ? `unsupported method ${op.transport.method}` : `${op.transport.type} transport`,
      });
      continue;
    }
    const responses: Record<string, unknown> = {};
    for (const r of [...op.successes, ...op.errors])
      responses[String(r.status)] = {
        description: r.status < 400 ? "Success" : "Error",
        ...(r.bodies.length ? { content: content(r.bodies) } : {}),
      };
    (paths[described.path] ??= {})[described.method] = {
      operationId: described.operationId,
      summary: described.summary,
      tags: described.tags,
      ...(described.parameters.length ? { parameters: described.parameters } : {}),
      ...(described.requestBody ? { requestBody: described.requestBody } : {}),
      responses: Object.keys(responses).length ? responses : { default: { description: "Response" } },
      security: described.schemes.map((s) => ({ [s]: [] })),
      "x-forge-public": described.public,
      "x-forge-authentication": described.authentication,
    };
  }
  return {
    openapi: "3.1.0",
    info: { title: info.title, version: contract.fingerprint.slice(7, 19) },
    ...(info.serverUrl ? { servers: [{ url: info.serverUrl }] } : {}),
    paths,
    components: {
      // IR `$ref`s point into `components`; OpenAPI resolves them under components.schemas.
      schemas: contract.components,
      securitySchemes: contract.securitySchemes,
    },
    "x-forge-contract": { serviceId: contract.serviceId, apiId: contract.apiId, fingerprint: contract.fingerprint },
    ...(skipped.length ? { "x-forge-skipped": skipped } : {}),
  };
}
