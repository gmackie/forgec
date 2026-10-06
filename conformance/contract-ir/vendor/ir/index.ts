// Vendored verbatim from ForgeGraph packages/contract/src/ir/index.ts
// at commit 0e6be228bf8771d81155bad3b4981c59a9df4620 (git.forgegraf.com/gmackie/forgegraph).
// Do not edit; refresh with conformance/contract-ir/vendor.sh.
/**
 * ForgeGraph operation contract IR, version 1.
 *
 * This module has no Effect dependency on purpose: the ForgeGraph server
 * validates ingested contracts with the Zod schema here, and Effect apps
 * produce it through `@forgegraph/contract/effect`. The IR is plain JSON.
 *
 * Identity is semantic (rule R2): `<serviceId>.<groupId>.<endpointId>`.
 * Routes are transport detail and may change without changing identity.
 */
import { z } from "zod";

import { canonicalJson, fingerprint, type JsonValue } from "../canonical.js";
import { SLA_LEAVES, SLA_LEVELS } from "../sla.js";

export const IR_VERSION = 1 as const;

// ---------------------------------------------------------------------------
// Zod schemas (source of truth for the wire format)
// ---------------------------------------------------------------------------

const jsonValue: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(jsonValue),
    z.record(z.string(), jsonValue),
  ]),
);

/** `serviceId`, `groupId` and `endpointId` share one identifier grammar. */
export const identifierSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(
    /^[a-zA-Z][a-zA-Z0-9_-]*$/,
    "identifiers start with a letter and contain only letters, digits, _ and -",
  );

export const operationIdSchema = z
  .string()
  .regex(
    /^[a-zA-Z][a-zA-Z0-9_-]*\.[a-zA-Z][a-zA-Z0-9_-]*\.[a-zA-Z][a-zA-Z0-9_-]*$/,
    "operation ids are <serviceId>.<groupId>.<endpointId>",
  );

export const slaLatencySchema = z
  .object({
    p50Ms: z.number().positive().optional(),
    p95Ms: z.number().positive().optional(),
    p99Ms: z.number().positive().optional(),
    maxMs: z.number().positive().optional(),
  })
  .strict();

export const slaPatchSchema = z
  .object({
    availability: z.number().gt(0).lte(1).optional(),
    errorRate: z.number().gte(0).lt(1).optional(),
    latency: slaLatencySchema.optional(),
    timeoutMs: z.number().positive().optional(),
    maxRetries: z.number().int().nonnegative().optional(),
    qps: z.number().positive().optional(),
    concurrency: z.number().int().positive().optional(),
  })
  .strict();

export const slaLevelSchema = z.enum(SLA_LEVELS);
export const slaLeafSchema = z.enum(SLA_LEAVES);

export const slaProvenanceSchema = z.partialRecord(slaLeafSchema, slaLevelSchema);

export const resolvedSlaSchema = z
  .object({
    policy: slaPatchSchema,
    provenance: slaProvenanceSchema,
  })
  .strict();

/**
 * A vendor-neutral service-level objective for one operation, as the Forge
 * compiler emits it (`slo { availability 99.9% over 28d; latency 99% <= 1s }`).
 * Optional: an Effect app's contract carries none, and ForgeGraph derives one
 * from the resolved SLA policy instead.
 */
export const sloDescriptorSchema = z
  .object({
    /** 0 < target ≤ 1 of eligible requests that must succeed. */
    availability: z.number().gt(0).lte(1).optional(),
    /** `good` (0 < x ≤ 1) of requests must complete within `withinMs`. */
    latency: z
      .object({ good: z.number().gt(0).lte(1), withinMs: z.number().positive() })
      .strict()
      .optional(),
    /** Rolling window in days; 28 unless the source says otherwise. */
    windowDays: z.number().int().positive().max(365),
  })
  .strict();
export type SloDescriptor = z.infer<typeof sloDescriptorSchema>;

export const authenticationModeSchema = z.enum([
  "anonymous",
  "user",
  "service",
  "agent",
  "mixed",
]);

/**
 * How the operation authenticates callers. `derived` is what the security
 * middleware implies; `mode` is the effective value (an explicit annotation
 * overrides). When they disagree `mismatch` is true so ForgeGraph can flag
 * "declared auth without matching middleware".
 */
export const authenticationSchema = z
  .object({
    mode: authenticationModeSchema,
    derived: authenticationModeSchema,
    declared: authenticationModeSchema.optional(),
    mismatch: z.boolean(),
    /** OpenAPI-style security scheme names the endpoint accepts (any-of). */
    schemes: z.array(z.string()),
  })
  .strict();

export const httpMethodSchema = z.enum([
  "GET",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
  "HEAD",
  "OPTIONS",
  "TRACE",
]);

export const httpTransportSchema = z
  .object({
    type: z.literal("http"),
    method: httpMethodSchema,
    /** Effect route syntax, e.g. `/users/:id`. */
    path: z.string().min(1),
    /** The same path in OpenAPI syntax, e.g. `/users/{id}`. */
    openApiPath: z.string().min(1),
  })
  .strict();

export const rpcTransportSchema = z
  .object({
    type: z.literal("rpc"),
    procedure: z.string().min(1),
  })
  .strict();

export const transportSchema = z.discriminatedUnion("type", [
  httpTransportSchema,
  rpcTransportSchema,
]);

/** A serialized schema: public JSON Schema plus a stable fingerprint. */
export const schemaRefSchema = z
  .object({
    /** The `identifier` annotation when the schema had one. */
    id: z.string().optional(),
    title: z.string().optional(),
    /** JSON Schema (draft 2020-12 / OpenAPI 3.1 dialect). `$ref`s point into `components`. */
    jsonSchema: jsonValue,
    /** sha256 over the canonical JSON Schema with its referenced components. */
    fingerprint: z.string().regex(/^sha256:[0-9a-f]{64}$/),
  })
  .strict();

export const bodyRefSchema = z
  .object({
    contentType: z.string().min(1),
    schema: schemaRefSchema,
  })
  .strict();

export const responseRefSchema = z
  .object({
    status: z.number().int().min(100).max(599),
    /** Empty for no-content responses. */
    bodies: z.array(bodyRefSchema),
  })
  .strict();

export const middlewareRefSchema = z
  .object({
    /** The middleware tag key, e.g. `@gmacko/domain/Session`. */
    key: z.string().min(1),
    security: z.boolean(),
    /** Security scheme names this middleware declares (empty when not security). */
    schemes: z.array(z.string()),
  })
  .strict();

export const operationContractSchema = z
  .object({
    id: operationIdSchema,
    serviceId: identifierSchema,
    groupId: identifierSchema,
    endpointId: identifierSchema,
    transport: transportSchema,
    policy: z
      .object({
        isPublic: z.boolean(),
        authentication: authenticationSchema,
        sla: resolvedSlaSchema,
        slo: sloDescriptorSchema.optional(),
      })
      .strict(),
    request: z
      .object({
        params: schemaRefSchema.optional(),
        query: schemaRefSchema.optional(),
        headers: schemaRefSchema.optional(),
        bodies: z.array(bodyRefSchema),
      })
      .strict(),
    successes: z.array(responseRefSchema),
    errors: z.array(responseRefSchema),
    middleware: z.array(middlewareRefSchema),
    /** sha256 over this operation minus `fingerprint` itself. */
    fingerprint: z.string().regex(/^sha256:[0-9a-f]{64}$/),
  })
  .strict();

export const contractSchema = z
  .object({
    irVersion: z.literal(IR_VERSION),
    serviceId: identifierSchema,
    /** The Effect `HttpApi` identifier. */
    apiId: z.string().min(1),
    operations: z.array(operationContractSchema),
    /** Shared JSON Schema components referenced by `$ref` from operations. */
    components: z.record(z.string(), jsonValue),
    /** Security schemes as OpenAPI objects, keyed by scheme name. */
    securitySchemes: z.record(z.string(), jsonValue),
    /** sha256 over everything above, operations sorted by id. */
    fingerprint: z.string().regex(/^sha256:[0-9a-f]{64}$/),
    generator: z
      .object({
        name: z.string(),
        version: z.string(),
      })
      .strict(),
  })
  .strict();

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type AuthenticationMode = z.infer<typeof authenticationModeSchema>;
export type Authentication = z.infer<typeof authenticationSchema>;
export type HttpMethod = z.infer<typeof httpMethodSchema>;
export type Transport = z.infer<typeof transportSchema>;
export type SchemaRef = z.infer<typeof schemaRefSchema>;
export type BodyRef = z.infer<typeof bodyRefSchema>;
export type ResponseRef = z.infer<typeof responseRefSchema>;
export type MiddlewareRef = z.infer<typeof middlewareRefSchema>;
export type OperationContract = z.infer<typeof operationContractSchema>;
export type Contract = z.infer<typeof contractSchema>;

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

export interface ContractIssue {
  readonly code:
    | "invalid_shape"
    | "duplicate_operation_id"
    | "operation_id_mismatch"
    | "operation_fingerprint_mismatch"
    | "contract_fingerprint_mismatch"
    | "dangling_component_ref";
  readonly path: string;
  readonly message: string;
}

export type ValidationResult =
  | { readonly ok: true; readonly contract: Contract }
  | { readonly ok: false; readonly issues: ReadonlyArray<ContractIssue> };

export function operationId(
  serviceId: string,
  groupId: string,
  endpointId: string,
): string {
  return `${serviceId}.${groupId}.${endpointId}`;
}

/**
 * The IR is JSON by construction (every schema above is JSON-only), so a
 * round trip is a faithful conversion to the `JsonValue` shape the hasher
 * takes, and it drops any `undefined` members the way the wire would.
 */
type OperationDigestInput = Omit<OperationContract, "fingerprint">;
type ContractDigestInput = Omit<Contract, "fingerprint" | "generator" | "operations"> & {
  readonly operations: ReadonlyArray<{ readonly id: string; readonly fingerprint: string }>;
};

function toJson(value: OperationDigestInput | ContractDigestInput | Contract): JsonValue {
  // SAFETY: callers pass IR values whose Zod schemas admit only JSON; the
  // round trip yields the same data as a JsonValue.
  return JSON.parse(JSON.stringify(value)) as JsonValue;
}

/** Everything of an operation that its fingerprint covers. */
function operationFingerprintInput(op: OperationContract): JsonValue {
  const { fingerprint: _omit, ...rest } = op;
  return toJson(rest);
}

export function fingerprintOperation(op: OperationContract): string {
  return fingerprint(operationFingerprintInput(op));
}

/** Everything of a contract that its fingerprint covers, operations sorted by id. */
function contractFingerprintInput(contract: Contract): JsonValue {
  const { fingerprint: _omit, generator: _gen, ...rest } = contract;
  const operations = [...rest.operations]
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map((op) => ({ id: op.id, fingerprint: op.fingerprint }));
  return toJson({ ...rest, operations });
}

export function fingerprintContract(contract: Contract): string {
  return fingerprint(contractFingerprintInput(contract));
}

function collectRefs(value: JsonValue, into: Set<string>): void {
  if (Array.isArray(value)) {
    for (const v of value) collectRefs(v, into);
    return;
  }
  if (value !== null && typeof value === "object") {
    for (const [key, v] of Object.entries(value)) {
      if (key === "$ref" && typeof v === "string") {
        const prefix = "#/components/schemas/";
        if (v.startsWith(prefix)) into.add(v.slice(prefix.length));
      } else if (v !== undefined) {
        collectRefs(v, into);
      }
    }
  }
}

/**
 * Parse and cross-check a contract: shape, unique + well-formed operation
 * ids, per-operation and whole-contract fingerprints, and that every
 * `$ref` resolves to a component. This is what the ForgeGraph server runs on
 * ingest and what CI runs before publishing.
 */
export function validateContract(input: unknown): ValidationResult {
  const parsed = contractSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      issues: parsed.error.issues.map((issue) => ({
        code: "invalid_shape",
        path: issue.path.map(String).join("."),
        message: issue.message,
      })),
    };
  }
  const contract = parsed.data;
  const issues: ContractIssue[] = [];
  const seen = new Set<string>();

  contract.operations.forEach((op, index) => {
    const path = `operations.${index}`;
    if (seen.has(op.id)) {
      issues.push({
        code: "duplicate_operation_id",
        path,
        message: `duplicate operation id ${op.id}`,
      });
    }
    seen.add(op.id);
    const expectedId = operationId(op.serviceId, op.groupId, op.endpointId);
    if (op.id !== expectedId) {
      issues.push({
        code: "operation_id_mismatch",
        path,
        message: `id ${op.id} does not match ${expectedId}`,
      });
    }
    if (op.serviceId !== contract.serviceId) {
      issues.push({
        code: "operation_id_mismatch",
        path,
        message: `operation serviceId ${op.serviceId} differs from contract serviceId ${contract.serviceId}`,
      });
    }
    const expectedFp = fingerprintOperation(op);
    if (op.fingerprint !== expectedFp) {
      issues.push({
        code: "operation_fingerprint_mismatch",
        path,
        message: `fingerprint ${op.fingerprint} does not match content (${expectedFp})`,
      });
    }
    const refs = new Set<string>();
    collectRefs(operationFingerprintInput(op), refs);
    for (const ref of refs) {
      if (!(ref in contract.components)) {
        issues.push({
          code: "dangling_component_ref",
          path,
          message: `$ref to missing component ${ref}`,
        });
      }
    }
  });

  const refs = new Set<string>();
  collectRefs(contract.components, refs);
  for (const ref of refs) {
    if (!(ref in contract.components)) {
      issues.push({
        code: "dangling_component_ref",
        path: "components",
        message: `$ref to missing component ${ref}`,
      });
    }
  }

  const expectedContractFp = fingerprintContract(contract);
  if (contract.fingerprint !== expectedContractFp) {
    issues.push({
      code: "contract_fingerprint_mismatch",
      path: "fingerprint",
      message: `fingerprint ${contract.fingerprint} does not match content (${expectedContractFp})`,
    });
  }

  return issues.length > 0 ? { ok: false, issues } : { ok: true, contract };
}

/** Canonical JSON text of a contract, suitable for snapshot files. */
export function serializeContract(contract: Contract): string {
  return canonicalJson(toJson(contract));
}
