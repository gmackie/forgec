/** GraphQL is an interface projection; resolvers never access storage directly. */
import {
  GraphQLSchema,
  GraphQLObjectType,
  GraphQLInputObjectType,
  GraphQLEnumType,
  GraphQLScalarType,
  GraphQLString,
  GraphQLBoolean,
  GraphQLFloat,
  GraphQLInt,
  GraphQLID,
  GraphQLList,
  GraphQLNonNull,
  GraphQLError,
  Kind,
  parse,
  validate,
  execute,
  specifiedRules,
  printSchema,
  lexicographicSortSchema,
  findBreakingChanges,
  findDangerousChanges,
  assertValidSchema,
  type GraphQLInputType,
  type GraphQLOutputType,
  type GraphQLFieldConfigMap,
  type GraphQLNamedType,
  type ExecutionResult,
  type ValidationRule,
} from "graphql";
import type { AppBundle, Engine, Principal } from "@forgegraph/runtime";
import { localCallable, type Callable, type InvokeOptions } from "./rpc.js";

type Schema = {
  $ref?: string;
  type?: string | string[];
  properties?: Record<string, Schema>;
  required?: string[];
  items?: Schema;
  enum?: string[];
  [key: string]: unknown;
};
interface Operation {
  operationId: string;
  "x-forge-kind"?: string;
  parameters?: {
    name: string;
    in: string;
    required?: boolean;
    schema: Schema;
  }[];
  requestBody?: {
    required?: boolean;
    content?: Record<string, { schema: Schema }>;
  };
  responses: Record<string, { content?: Record<string, { schema: Schema }> }>;
}
export interface GraphQLMapping {
  /** Canonical operation ID -> GraphQL root field. */
  operations?: Record<string, string>;
  /** OpenAPI component name -> stable GraphQL type name (input types add Input). */
  types?: Record<string, string>;
  /** Component name -> canonical field -> legacy GraphQL field. Applied to inputs and outputs. */
  fields?: Record<string, Record<string, string>>;
}
export interface GraphQLProjection {
  schema: GraphQLSchema;
  sdl: string;
  operations: Record<string, string>;
  fieldBindings: Record<string, string>;
  diagnostics: { operationId: string; reason: string }[];
}
interface Context {
  callable: Callable;
  options: InvokeOptions;
}
const name = (value: string) => {
  if (!/^[_A-Za-z][_0-9A-Za-z]*$/.test(value) || value.startsWith("__"))
    throw Error(`Invalid GraphQL name: ${value}`);
  return value;
};
// Encode punctuation rather than dropping it: identities never depend on declaration order.
const identity = (value: string) =>
  "Forge_" +
  [...value]
    .map((c) =>
      /[A-Za-z0-9]/.test(c) ? c : `_u${c.codePointAt(0)!.toString(16)}_`,
    )
    .join("");
const integer = (value: unknown) => {
  if (typeof value !== "number" || !Number.isSafeInteger(value))
    throw new GraphQLError("Expected a safe integer");
  return value;
};
const ForgeInteger = new GraphQLScalarType({
  name: "ForgeInteger",
  description:
    "Forge safe integer, including values outside GraphQL Int's 32-bit range.",
  serialize: integer,
  parseValue: integer,
  parseLiteral: (node) => {
    if (node.kind !== Kind.INT)
      throw new GraphQLError("Expected an integer literal");
    return integer(Number(node.value));
  },
});

/** Uses the bundle's generated wire contracts, retaining canonical operation IDs. */
export function projectGraphQL(
  bundle: AppBundle,
  mapping: GraphQLMapping = {},
): GraphQLProjection {
  const doc = bundle.openapi as
    | {
        paths?: Record<string, Record<string, Operation>>;
        components?: { schemas?: Record<string, Schema> };
      }
    | undefined;
  if (!doc?.paths)
    throw Error("GraphQL requires a bundle with generated OpenAPI contracts");
  const components = doc.components?.schemas ?? {};
  const ids = new Set(
    Object.values(doc.paths).flatMap((methods) =>
      Object.values(methods).map((op) => op.operationId),
    ),
  );
  for (const id of Object.keys(mapping.operations ?? {}))
    if (!ids.has(id)) throw Error(`Unknown mapped operation: ${id}`);
  for (const key of [
    ...Object.keys(mapping.types ?? {}),
    ...Object.keys(mapping.fields ?? {}),
  ])
    if (!components[key]) throw Error(`Unknown mapped component: ${key}`);
  for (const [key, fields] of Object.entries(mapping.fields ?? {}))
    for (const field of Object.keys(fields))
      if (!components[key]?.properties?.[field])
        throw Error(`Unknown mapped field: ${key}.${field}`);
  const cache = new Map<string, GraphQLNamedType>();
  const fieldBindings: Record<string, string> = {};
  const owners = new Map<string, string>([
    ["Query", "root"],
    ["Mutation", "root"],
    ["ForgeInteger", "scalar"],
  ]);
  const claim = (n: string, key: string) => {
    name(n);
    const previous = owners.get(n);
    if (previous && previous !== key)
      throw Error(`GraphQL name collision: ${n}`);
    owners.set(n, key);
  };
  const resolve = (s: Schema): Schema =>
    s.$ref
      ? (components[s.$ref.replace("#/components/schemas/", "")] ??
        (() => {
          throw Error(`Unknown schema ${s.$ref}`);
        })())
      : s;
  const component = (s: Schema) => s.$ref?.replace("#/components/schemas/", "");
  function type(
    s: Schema,
    key: string,
    input: boolean,
  ): GraphQLInputType | GraphQLOutputType {
    if (s.$ref) {
      const c = component(s)!;
      return type(resolve(s), c, input);
    }
    if (s.enum) {
      const enumKey = String(s["x-forge-enum"] ?? s["x-forge-status"] ?? key);
      const n = identity(enumKey) + "Enum";
      if (!cache.has(n)) {
        claim(n, enumKey);
        cache.set(
          n,
          new GraphQLEnumType({
            name: n,
            values: Object.fromEntries(
              s.enum.map((v) => [identity(v), { value: v }]),
            ),
          }),
        );
      }
      return cache.get(n) as GraphQLEnumType;
    }
    const t = Array.isArray(s.type) ? s.type.find((t) => t !== "null") : s.type;
    if (t === "array")
      return new GraphQLList(
        type(s.items ?? {}, key + "Item", input) as GraphQLOutputType,
      );
    if (t === "object" || s.properties) {
      if (!s.properties || !Object.keys(s.properties).length)
        throw Error(`Unsupported empty or open object: ${key}`);
      const n =
        (mapping.types?.[key] ?? identity(key)) + (input ? "Input" : "");
      const cacheKey = key + (input ? ":input" : ":output");
      claim(n, cacheKey);
      if (!cache.has(n)) {
        const fields = () => {
          const result: Record<string, any> = {};
          for (const [field, sub] of Object.entries(s.properties!)) {
            if ((input && sub["readOnly"]) || (!input && sub["writeOnly"]))
              continue;
            const wire = name(mapping.fields?.[key]?.[field] ?? field);
            if (result[wire])
              throw Error(`GraphQL field collision: ${n}.${wire}`);
            let fieldType = type(sub, key + "_" + field, input);
            // Purpose surfaces may remove record fields. Output fields stay nullable.
            if (
              input &&
              s.required?.includes(field) &&
              !(Array.isArray(sub.type) && sub.type.includes("null"))
            )
              fieldType = new GraphQLNonNull(fieldType as GraphQLInputType);
            fieldBindings[`${n}.${wire}`] = `${key}.${field}`;
            result[wire] = {
              type: fieldType,
              ...(!input
                ? {
                    resolve: (source: Record<string, unknown>) => source[field],
                  }
                : {}),
            };
          }
          return result;
        };
        cache.set(
          n,
          input
            ? new GraphQLInputObjectType({ name: n, fields })
            : new GraphQLObjectType({ name: n, fields }),
        );
      }
      return cache.get(n) as GraphQLInputObjectType | GraphQLObjectType;
    }
    if (t === "string")
      return s["x-forge-type"] === "id" || s["x-forge-reference"]
        ? GraphQLID
        : GraphQLString;
    if (t === "integer") return ForgeInteger;
    if (t === "number") return GraphQLFloat;
    if (t === "boolean") return GraphQLBoolean;
    throw Error(`Unsupported GraphQL contract shape: ${key}`);
  }
  function canonical(value: any, s: Schema, key: string): any {
    if (value == null) return value;
    if (s.$ref) return canonical(value, resolve(s), component(s)!);
    if (Array.isArray(value))
      return value.map((v) => canonical(v, s.items ?? {}, key + "Item"));
    if (s.properties) {
      const out: Record<string, unknown> = {};
      for (const [f, sub] of Object.entries(s.properties)) {
        const wire = mapping.fields?.[key]?.[f] ?? f;
        if (Object.hasOwn(value, wire))
          out[f] = canonical(value[wire], sub, key + "_" + f);
      }
      return out;
    }
    return value;
  }
  const query: GraphQLFieldConfigMap<unknown, Context> = {},
    mutation: GraphQLFieldConfigMap<unknown, Context> = {};
  const operations: Record<string, string> = {};
  const diagnostics: { operationId: string; reason: string }[] = [];
  for (const methods of Object.values(doc.paths))
    for (const [method, op] of Object.entries(methods)) {
      if (!op.operationId) continue;
      const id = op.operationId,
        kind = op["x-forge-kind"] ?? "function";
      if (
        ![
          "create",
          "get",
          "find",
          "list",
          "update",
          "delete",
          "restore",
          "transition",
          "function",
        ].includes(kind)
      ) {
        diagnostics.push({
          operationId: id,
          reason: `Operation kind ${kind} is outside the GraphQL resource/function profile`,
        });
        continue;
      }
      const n = name(mapping.operations?.[id] ?? identity(id));
      if (Object.hasOwn(operations, n))
        throw Error(`GraphQL operation collision: ${n}`);
      const fields =
        method.toLowerCase() === "get" && kind !== "function"
          ? query
          : mutation;
      const response = Object.entries(op.responses).find(([code]) =>
        /^2\d\d$/.test(code),
      )?.[1].content?.["application/json"]?.schema;
      if (!response)
        throw Error(`Unsupported non-JSON GraphQL response: ${id}`);
      const args: Record<string, any> = {};
      const body = op.requestBody?.content?.["application/json"]?.schema;
      if (body) {
        const b = resolve(body);
        if (b.type !== "object" || Object.keys(b.properties ?? {}).length)
          args["input"] = {
            type: op.requestBody?.required
              ? new GraphQLNonNull(
                  type(body, id + "Body", true) as GraphQLInputType,
                )
              : type(body, id + "Body", true),
          };
      }
      for (const p of op.parameters ?? []) {
        if (p.in === "header") continue;
        name(p.name);
        if (args[p.name])
          throw Error(`GraphQL argument collision: ${id}.${p.name}`);
        const pt =
          p.name === "limit"
            ? GraphQLInt
            : (type(p.schema, id + "_" + p.name, true) as GraphQLInputType);
        args[p.name] = { type: p.required ? new GraphQLNonNull(pt) : pt };
      }
      if (
        !(body && resolve(body).properties?.["expectedVersion"]) &&
        op.parameters?.some(
          (p) => p.in === "header" && p.name.toLowerCase() === "if-match",
        )
      )
        args["expectedVersion"] = { type: new GraphQLNonNull(ForgeInteger) };
      operations[n] = id;
      fields[n] = {
        type: type(response, id + "Result", false) as GraphQLOutputType,
        args,
        resolve: async (_source, a, ctx) => {
          if (
            a["limit"] !== undefined &&
            (!Number.isInteger(a["limit"]) ||
              a["limit"] < 1 ||
              a["limit"] > 100)
          )
            throw new GraphQLError("limit must be between 1 and 100", {
              extensions: { code: "ValidationFailed" },
            });
          const b = body ? canonical(a["input"] ?? {}, body, id + "Body") : {};
          let input: Record<string, unknown>;
          if (["list", "find", "effective", "view.query"].includes(kind)) {
            const params: Record<string, unknown> = {};
            for (const p of op.parameters ?? [])
              if (
                p.in === "query" &&
                !["cursor", "limit"].includes(p.name) &&
                a[p.name] !== undefined
              )
                params[p.name] = a[p.name];
            input = {
              params,
              ...(a["cursor"] !== undefined ? { cursor: a["cursor"] } : {}),
              ...(a["limit"] !== undefined ? { limit: a["limit"] } : {}),
            };
          } else if (kind === "update")
            input = {
              id: a["id"],
              expectedVersion: a["expectedVersion"],
              patch: b,
            };
          else if (kind === "transition")
            input = {
              id: a["id"],
              expectedVersion: a["expectedVersion"],
              input: b,
            };
          else {
            const { input: _ignored, ...params } = a;
            input = { ...b, ...params };
          }
          let outcome;
          try {
            outcome = await ctx.callable.invoke(id, input, ctx.options);
          } catch {
            throw new GraphQLError("Invocation failed", {
              extensions: { code: "InternalError" },
            });
          }
          if (outcome.kind === "error")
            throw new GraphQLError(outcome.problem.code, {
              extensions: {
                code: outcome.problem.code,
                status: outcome.problem.status,
              },
            });
          if (outcome.kind === "invocationFailed")
            throw new GraphQLError("Invocation failed", {
              extensions: { code: "InvocationFailed", reason: outcome.reason },
            });
          return outcome.value;
        },
      };
    }
  if (!Object.keys(query).length)
    query["forgeInterface"] = {
      type: GraphQLString,
      resolve: () => "graphql/1",
    };
  const schema = new GraphQLSchema({
    query: new GraphQLObjectType({ name: "Query", fields: query }),
    ...(Object.keys(mutation).length
      ? {
          mutation: new GraphQLObjectType({
            name: "Mutation",
            fields: mutation,
          }),
        }
      : {}),
  });
  assertValidSchema(schema);
  return {
    schema,
    sdl: printSchema(lexicographicSortSchema(schema)),
    operations,
    fieldBindings,
    diagnostics,
  };
}

export function diffGraphQL(
  before: GraphQLProjection,
  after: GraphQLProjection,
) {
  const remapped = Object.entries({
    ...before.operations,
    ...before.fieldBindings,
  }).flatMap(([key, target]) => {
    const next = { ...after.operations, ...after.fieldBindings }[key];
    return next && next !== target
      ? [
          {
            type: "BINDING_CHANGED",
            description: `${key} changed canonical binding from ${target} to ${next}`,
          },
        ]
      : [];
  });
  return {
    breaking: [
      ...findBreakingChanges(before.schema, after.schema),
      ...remapped,
    ],
    dangerous: findDangerousChanges(before.schema, after.schema),
    changed: before.sdl !== after.sdl || remapped.length > 0,
  };
}
export interface GraphQLRequest {
  query: string;
  variables?: Record<string, unknown>;
  operationName?: string;
}
/** Fragment expansion and aliases are counted before execution, bounding operation fanout. */
const bounded: ValidationRule = (context) => ({
  Document(node) {
    const fragments = new Map(
      node.definitions
        .filter((d) => d.kind === Kind.FRAGMENT_DEFINITION)
        .map((d) => [d.name.value, d]),
    );
    let count = 0,
      roots = 0;
    const walk = (set: any, depth: number, seen: Set<string>) => {
      if (depth > 20 || ++count > 1000)
        throw new GraphQLError("GraphQL selection budget exceeded");
      for (const s of set.selections) {
        if (s.kind === Kind.FRAGMENT_SPREAD) {
          if (seen.has(s.name.value)) continue;
          const f = fragments.get(s.name.value);
          if (f) walk(f.selectionSet, depth, new Set([...seen, s.name.value]));
        } else {
          if (s.kind === Kind.FIELD && depth === 0 && ++roots > 50)
            throw new GraphQLError("GraphQL root field budget exceeded");
          if (++count > 1000)
            throw new GraphQLError("GraphQL selection budget exceeded");
          if (s.selectionSet) walk(s.selectionSet, depth + 1, seen);
        }
      }
    };
    try {
      for (const d of node.definitions)
        if (d.kind === Kind.OPERATION_DEFINITION)
          walk(d.selectionSet, 0, new Set());
    } catch (e) {
      context.reportError(e as GraphQLError);
    }
  },
});
export async function executeGraphQL(
  projection: GraphQLProjection,
  callable: Callable,
  request: GraphQLRequest,
  options: InvokeOptions = {},
): Promise<ExecutionResult> {
  try {
    if (typeof request?.query !== "string" || request.query.length > 100_000)
      throw new GraphQLError("Expected a query of at most 100000 characters");
    const document = parse(request.query, { maxTokens: 10000 });
    const errors = validate(projection.schema, document, [
      ...specifiedRules,
      bounded,
    ]);
    if (errors.length) return { errors };
    return await execute({
      schema: projection.schema,
      document,
      contextValue: { callable, options },
      ...(request.variables ? { variableValues: request.variables } : {}),
      ...(request.operationName
        ? { operationName: request.operationName }
        : {}),
    });
  } catch (e) {
    return {
      errors: [
        e instanceof GraphQLError
          ? e
          : new GraphQLError("Invalid GraphQL request"),
      ],
    };
  }
}
/** Mount behind createHttpHandler authentication; credentials never come from GraphQL input. */
export function graphqlHttp(engine: Engine, mapping: GraphQLMapping = {}) {
  const projection = projectGraphQL(engine.model.bundle, mapping);
  return async (req: Request, principal: Principal, requestId: string) => {
    const headers = {
      "content-type": "application/json",
      "x-request-id": requestId,
    };
    if (req.method !== "POST")
      return Response.json(
        { errors: [{ message: "Use POST" }] },
        { status: 405, headers: { ...headers, allow: "POST" } },
      );
    let request: GraphQLRequest;
    try {
      const reader = req.body?.getReader();
      let bytes = 0;
      const parts: Uint8Array[] = [];
      if (reader)
        while (true) {
          const chunk = await reader.read();
          if (chunk.done) break;
          bytes += chunk.value.byteLength;
          if (bytes > 1_048_576) {
            await reader.cancel();
            return Response.json(
              { errors: [{ message: "Request exceeds 1 MiB" }] },
              { status: 413, headers },
            );
          }
          parts.push(chunk.value);
        }
      const all = new Uint8Array(bytes);
      let offset = 0;
      for (const part of parts) {
        all.set(part, offset);
        offset += part.length;
      }
      request = JSON.parse(new TextDecoder().decode(all)) as GraphQLRequest;
      if (
        !request ||
        Array.isArray(request) ||
        typeof request.query !== "string"
      )
        throw Error();
    } catch {
      return Response.json(
        { errors: [{ message: "Invalid GraphQL request" }] },
        { status: 400, headers },
      );
    }
    const purpose = req.headers.get("x-forge-purpose"),
      idempotencyKey = req.headers.get("idempotency-key");
    return Response.json(
      await executeGraphQL(
        projection,
        localCallable(engine, principal),
        request,
        {
          ...(purpose ? { purpose } : {}),
          ...(idempotencyKey ? { idempotencyKey } : {}),
        },
      ),
      { headers },
    );
  };
}
