/**
 * M0 spike: the plan's DynamoDB commit protocol (§11.1, §11.3, §11.4, §11.5)
 * reduced to four operations over one table. Explanatory key format; the real
 * codec is versioned and delimiter-safe.
 *
 *   Entity   T#<tenant>#R#<resource>#I#<id>            / ENTITY
 *   Claim    T#<tenant>#R#<resource>#U#<key>#<value>   / CLAIM
 *   Audit    T#<tenant>#A#<opId>                       / AUDIT
 *   Outbox   T#<tenant>#O#<opId>                       / E#<ordinal>
 */
import { TransactWriteCommand, GetCommand, QueryCommand, type TransactWriteCommandInput } from "@aws-sdk/lib-dynamodb";
import { unmarshall } from "@aws-sdk/util-dynamodb";
import type { AttributeValue } from "@aws-sdk/client-dynamodb";
import { doc, TABLE } from "./table.js";

export const key = {
  entity: (tenant: string, resource: string, id: string) => ({ PK: `T#${tenant}#R#${resource}#I#${id}`, SK: "ENTITY" }),
  claim: (tenant: string, resource: string, name: string, value: string) => ({
    PK: `T#${tenant}#R#${resource}#U#${name}#${value}`,
    SK: "CLAIM",
  }),
  audit: (tenant: string, opId: string) => ({ PK: `T#${tenant}#A#${opId}`, SK: "AUDIT" }),
  outbox: (tenant: string, opId: string, ordinal: number) => ({ PK: `T#${tenant}#O#${opId}`, SK: `E#${ordinal}` }),
  /** §11.2 access item: partition = query + equality values, sort = declared order key + id tie-breaker. */
  accessByTier: (tenant: string, tier: string, name: string, id: string) => ({
    PK: `T#${tenant}#R#customer#Q#byTier#${tier}`,
    SK: `${name}#${id}`,
  }),
};

/** Outbox item attributes at commit time: pending, and present in the sparse pending index. */
function outboxItem(tenant: string, opId: string, ordinal: number, payload: Record<string, unknown>, now: number) {
  return { ...key.outbox(tenant, opId, ordinal), ...payload, status: "pending", attempts: 0, pendingShard: `T#${tenant}`, pendingAt: now };
}

/** Logical role of each item in a transaction, aligned by index with TransactItems. */
export type Role = "entity" | "claim" | "audit" | "outbox" | "parent" | "access";

export type Outcome =
  | "AlreadyExists"
  | "UniqueConflict"
  | "VersionConflict"
  | "ParentUnavailable"
  | "HasDependents"
  | "AlreadyDeleted"
  | "TransactionConflict" // retryable operational conflict, not a semantic failure
  | "IdempotentParameterMismatch"
  | "ProviderError";

export interface CancellationReason {
  role: Role | undefined;
  code: string | undefined;
  message: string | undefined;
  item?: Record<string, unknown> | undefined;
}

export type Result =
  | { ok: true }
  | { ok: false; outcome: Outcome; reasons: CancellationReason[]; error: { name: string; message: string } };

interface TxSpec {
  roles: Role[];
  items: NonNullable<TransactWriteCommandInput["TransactItems"]>;
  clientToken?: string | undefined;
  /** Which outcome a ConditionalCheckFailed on a given role means for this operation. */
  onConditionFailed: Partial<Record<Role, Outcome | ((item: Record<string, unknown> | undefined) => Outcome)>>;
}

/** Bounded retry of retryable operational conflicts (§9). Same items, same generated values, jittered backoff. */
const MAX_ATTEMPTS = 5;

async function run(spec: TxSpec): Promise<Result> {
  let last: Result = { ok: false, outcome: "ProviderError", reasons: [], error: { name: "Unreachable", message: "" } };
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    last = await runOnce(spec);
    if (last.ok || last.outcome !== "TransactionConflict") return last;
    await new Promise((r) => setTimeout(r, Math.floor(Math.random() * 50 * attempt)));
  }
  return last;
}

async function runOnce(spec: TxSpec): Promise<Result> {
  try {
    await doc.send(
      new TransactWriteCommand({
        TransactItems: spec.items,
        ...(spec.clientToken ? { ClientRequestToken: spec.clientToken } : {}),
      }),
    );
    return { ok: true };
  } catch (e) {
    const err = e as Error & { CancellationReasons?: { Code?: string; Message?: string; Item?: Record<string, AttributeValue> }[] };
    const error = { name: err.name, message: err.message };
    if (err.name === "IdempotentParameterMismatchException") {
      return { ok: false, outcome: "IdempotentParameterMismatch", reasons: [], error };
    }
    if (err.name !== "TransactionCanceledException") {
      return { ok: false, outcome: "ProviderError", reasons: [], error };
    }
    const reasons: CancellationReason[] = (err.CancellationReasons ?? []).map((r, i) => ({
      role: spec.roles[i],
      code: r.Code,
      message: r.Message,
      // Finding: CancellationReasons[].Item arrives as raw AttributeValues even via the Document client.
      item: r.Item ? unmarshall(r.Item) : undefined,
    }));
    if (reasons.some((r) => r.code === "TransactionConflict")) {
      return { ok: false, outcome: "TransactionConflict", reasons, error };
    }
    const failed = reasons.find((r) => r.code === "ConditionalCheckFailed");
    const rule = failed?.role ? spec.onConditionFailed[failed.role] : undefined;
    const outcome: Outcome = rule === undefined ? "ProviderError" : typeof rule === "function" ? rule(failed?.item) : rule;
    return { ok: false, outcome, reasons, error };
  }
}

const RES = { customer: "customer", site: "site" } as const;

export interface CreateCustomer {
  tenant: string;
  id: string;
  code: string;
  name: string;
  opId: string;
  clientToken?: string;
  tier?: string;
  /** Command clock: generated once per logical command so replays are byte-identical. */
  now?: number;
}

/** Entity + unique claim + access item + audit + outbox in one transaction (§11.2, §11.3, §11.5). */
export function createCustomer(c: CreateCustomer): Promise<Result> {
  const tier = c.tier ?? "standard";
  const now = c.now ?? Date.now();
  return run({
    roles: ["entity", "claim", "access", "audit", "outbox"],
    clientToken: c.clientToken,
    onConditionFailed: { entity: "AlreadyExists", claim: "UniqueConflict" },
    items: [
      {
        Put: {
          TableName: TABLE,
          Item: { ...key.entity(c.tenant, RES.customer, c.id), id: c.id, code: c.code, name: c.name, tier, version: 1, active: true, dependents: 0 },
          ConditionExpression: "attribute_not_exists(PK)",
        },
      },
      {
        Put: {
          TableName: TABLE,
          Item: { ...key.claim(c.tenant, RES.customer, "code", c.code), entityId: c.id },
          ConditionExpression: "attribute_not_exists(PK)",
        },
      },
      { Put: { TableName: TABLE, Item: { ...key.accessByTier(c.tenant, tier, c.name, c.id), id: c.id, name: c.name, version: 1 } } },
      { Put: { TableName: TABLE, Item: { ...key.audit(c.tenant, c.opId), resource: RES.customer, recordId: c.id, newVersion: 1 } } },
      { Put: { TableName: TABLE, Item: outboxItem(c.tenant, c.opId, 0, { type: "CustomerCreated", id: c.id }, now) } },
    ],
  });
}

export interface UpdateCustomer {
  tenant: string;
  id: string;
  expectedVersion: number;
  name: string;
  opId: string;
  now?: number;
}

/**
 * Guarded update: condition on the expected version; access item move, audit
 * and outbox ride in the same transaction. The current record is loaded with a
 * consistent read to find the old access key; the version condition on the
 * entity guarantees that load is still current when the transaction commits.
 */
export async function updateCustomer(u: UpdateCustomer): Promise<Result> {
  const now = u.now ?? Date.now();
  const current = await getEntity(u.tenant, RES.customer, u.id);
  if (!current || current["version"] !== u.expectedVersion) {
    return { ok: false, outcome: "VersionConflict", reasons: [], error: { name: "Preflight", message: "expected version does not match current record" } };
  }
  const tier = String(current["tier"]);
  const oldAccess = key.accessByTier(u.tenant, tier, String(current["name"]), u.id);
  const newAccess = key.accessByTier(u.tenant, tier, u.name, u.id);
  const moveAccess: TxSpec["items"] =
    oldAccess.SK === newAccess.SK
      ? [{ Put: { TableName: TABLE, Item: { ...newAccess, id: u.id, name: u.name, version: u.expectedVersion + 1 } } }]
      : [
          { Delete: { TableName: TABLE, Key: oldAccess, ConditionExpression: "version = :v", ExpressionAttributeValues: { ":v": u.expectedVersion } } },
          { Put: { TableName: TABLE, Item: { ...newAccess, id: u.id, name: u.name, version: u.expectedVersion + 1 } } },
        ];
  return run({
    roles: ["entity", ...moveAccess.map((): Role => "access"), "audit", "outbox"],
    onConditionFailed: { entity: "VersionConflict", access: "VersionConflict" },
    items: [
      {
        Update: {
          TableName: TABLE,
          Key: key.entity(u.tenant, RES.customer, u.id),
          UpdateExpression: "SET #n = :name, version = version + :one",
          ConditionExpression: "version = :v AND active = :t",
          ExpressionAttributeNames: { "#n": "name" },
          ExpressionAttributeValues: { ":name": u.name, ":one": 1, ":v": u.expectedVersion, ":t": true },
        },
      },
      ...moveAccess,
      { Put: { TableName: TABLE, Item: { ...key.audit(u.tenant, u.opId), resource: RES.customer, recordId: u.id, newVersion: u.expectedVersion + 1 } } },
      { Put: { TableName: TABLE, Item: outboxItem(u.tenant, u.opId, 0, { type: "CustomerUpdated", id: u.id }, now) } },
    ],
  });
}

export interface CreateSite {
  tenant: string;
  customerId: string;
  id: string;
  opId: string;
}

/**
 * Reference creation under an integrity guard (§11.4): the parent's dependents
 * counter is incremented in the same transaction, conditioned on the parent
 * being live. Update + condition on one item, never Update + ConditionCheck on
 * the same item.
 */
export function createSite(s: CreateSite): Promise<Result> {
  return run({
    roles: ["parent", "entity", "audit"],
    onConditionFailed: { parent: "ParentUnavailable", entity: "AlreadyExists" },
    items: [
      {
        Update: {
          TableName: TABLE,
          Key: key.entity(s.tenant, RES.customer, s.customerId),
          UpdateExpression: "SET dependents = dependents + :one",
          ConditionExpression: "attribute_exists(PK) AND active = :t",
          ExpressionAttributeValues: { ":one": 1, ":t": true },
          ReturnValuesOnConditionCheckFailure: "ALL_OLD",
        },
      },
      {
        Put: {
          TableName: TABLE,
          Item: { ...key.entity(s.tenant, RES.site, s.id), id: s.id, customer: s.customerId, version: 1, active: true },
          ConditionExpression: "attribute_not_exists(PK)",
        },
      },
      { Put: { TableName: TABLE, Item: { ...key.audit(s.tenant, s.opId), resource: RES.site, recordId: s.id, newVersion: 1 } } },
    ],
  });
}

export interface DeleteCustomer {
  tenant: string;
  id: string;
  opId: string;
}

/** Restrict-delete: only while live and with zero live dependents (§11.4). */
export function deleteCustomer(d: DeleteCustomer): Promise<Result> {
  return run({
    roles: ["entity", "audit"],
    onConditionFailed: {
      entity: (old) => (old && old["active"] === false ? "AlreadyDeleted" : "HasDependents"),
    },
    items: [
      {
        Update: {
          TableName: TABLE,
          Key: key.entity(d.tenant, RES.customer, d.id),
          UpdateExpression: "SET active = :f, version = version + :one",
          ConditionExpression: "attribute_exists(PK) AND active = :t AND dependents = :zero",
          ExpressionAttributeValues: { ":f": false, ":t": true, ":one": 1, ":zero": 0 },
          ReturnValuesOnConditionCheckFailure: "ALL_OLD",
        },
      },
      { Put: { TableName: TABLE, Item: { ...key.audit(d.tenant, d.opId), resource: RES.customer, recordId: d.id, action: "delete" } } },
    ],
  });
}

/** Strong read of a named query's access partition (§11.2): consistent, ordered by the sort codec. */
export async function queryByTier(tenant: string, tier: string): Promise<{ id: string; name: string; version: number }[]> {
  const r = await doc.send(
    new QueryCommand({
      TableName: TABLE,
      ConsistentRead: true,
      KeyConditionExpression: "PK = :pk",
      ExpressionAttributeValues: { ":pk": key.accessByTier(tenant, tier, "", "").PK },
    }),
  );
  return (r.Items ?? []).map((i) => ({ id: String(i["id"]), name: String(i["name"]), version: Number(i["version"]) }));
}

export async function getEntity(tenant: string, resource: string, id: string): Promise<Record<string, unknown> | undefined> {
  const r = await doc.send(new GetCommand({ TableName: TABLE, Key: key.entity(tenant, resource, id), ConsistentRead: true }));
  return r.Item as Record<string, unknown> | undefined;
}
