/**
 * DynamoDB storage adapter (plan §11), following the protocol certified by
 * the M0 spike: entity + unique claims + strong access items + audit + outbox
 * + receipt in one TransactWriteItems; bounded retry of TransactionConflict;
 * ClientRequestToken derived from the operation id.
 */
import { CreateTableCommand, DescribeTableCommand, DynamoDBClient, ResourceNotFoundException, UpdateTableCommand, waitUntilTableExists, type AttributeValue } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand, QueryCommand, TransactWriteCommand, type TransactWriteCommandInput } from "@aws-sdk/lib-dynamodb";
import { unmarshall } from "@aws-sdk/util-dynamodb";
import { Effect } from "effect";
import { encodeIdentity, sortKey } from "../codecs.js";
import { err, type ForgeError } from "../errors.js";
import { fieldOf, scaleOf, type List, type Model, type Resource, type Unique } from "../model.js";
import type { CommitPlan, ListQuery, Receipt, StorageAdapter, StoredRecord } from "../services.js";

export const PENDING_INDEX = "pending-index";
const RETRY_ATTEMPTS = 5;

export interface DynamoOptions {
  table: string;
  region?: string;
  client?: DynamoDBClient;
}

type Item = Record<string, unknown>;
type TxItem = NonNullable<TransactWriteCommandInput["TransactItems"]>[number];
type Role = "entity" | "claim" | "access" | "parent" | "audit" | "outbox" | "receipt";

/** Create the single data table + sparse pending index (idempotent). Deployment-time, never request-time. */
export async function ensureDynamoTable(table: string, region: string): Promise<void> {
  const raw = new DynamoDBClient({ region });
  const describe = async () => {
    try {
      return (await raw.send(new DescribeTableCommand({ TableName: table }))).Table;
    } catch (e) {
      if (e instanceof ResourceNotFoundException) return undefined;
      throw e;
    }
  };
  if (!(await describe())) {
    await raw.send(
      new CreateTableCommand({
        TableName: table,
        BillingMode: "PAY_PER_REQUEST",
        AttributeDefinitions: [
          { AttributeName: "PK", AttributeType: "S" },
          { AttributeName: "SK", AttributeType: "S" },
          { AttributeName: "pendingShard", AttributeType: "S" },
          { AttributeName: "pendingAt", AttributeType: "N" },
        ],
        KeySchema: [
          { AttributeName: "PK", KeyType: "HASH" },
          { AttributeName: "SK", KeyType: "RANGE" },
        ],
        GlobalSecondaryIndexes: [
          {
            IndexName: PENDING_INDEX,
            KeySchema: [
              { AttributeName: "pendingShard", KeyType: "HASH" },
              { AttributeName: "pendingAt", KeyType: "RANGE" },
            ],
            Projection: { ProjectionType: "ALL" },
          },
        ],
        Tags: [{ Key: "forge", Value: "data" }],
      }),
    );
    await waitUntilTableExists({ client: raw, maxWaitTime: 300 }, { TableName: table });
  } else if (!(await describe())?.GlobalSecondaryIndexes?.some((g) => g.IndexName === PENDING_INDEX)) {
    await raw.send(
      new UpdateTableCommand({
        TableName: table,
        AttributeDefinitions: [
          { AttributeName: "PK", AttributeType: "S" },
          { AttributeName: "SK", AttributeType: "S" },
          { AttributeName: "pendingShard", AttributeType: "S" },
          { AttributeName: "pendingAt", AttributeType: "N" },
        ],
        GlobalSecondaryIndexUpdates: [{ Create: { IndexName: PENDING_INDEX, KeySchema: [{ AttributeName: "pendingShard", KeyType: "HASH" }, { AttributeName: "pendingAt", KeyType: "RANGE" }], Projection: { ProjectionType: "ALL" } } }],
      }),
    );
  }
  for (let i = 0; i < 240; i++) {
    const t = await describe();
    if (t?.TableStatus === "ACTIVE" && t.GlobalSecondaryIndexes?.every((g) => g.IndexStatus === "ACTIVE")) return;
    await new Promise((r) => setTimeout(r, 2500));
  }
  throw new Error(`${table} did not become ACTIVE`);
}

export class DynamoStorage implements StorageAdapter {
  readonly name = "dynamodb";
  private readonly doc: DynamoDBDocumentClient;
  private readonly table: string;

  constructor(opts: DynamoOptions, private readonly model: Model) {
    this.table = opts.table;
    const raw = opts.client ?? new DynamoDBClient({ region: opts.region ?? "us-east-1" });
    this.doc = DynamoDBDocumentClient.from(raw, { marshallOptions: { removeUndefinedValues: true } });
  }

  // ------------------------------------------------------------ keys (identity.v1)
  private wire(r: Resource): string {
    return this.model.wireName(r.id);
  }
  private entityKey(tenant: string, r: Resource, id: string) {
    return { PK: encodeIdentity(["T", tenant, "R", this.wire(r), "I", id]), SK: "ENTITY" };
  }
  private claimKey(tenant: string, r: Resource, u: Unique, values: string[]) {
    return { PK: encodeIdentity(["T", tenant, "R", this.wire(r), "U", u.name, ...values]), SK: "CLAIM" };
  }
  private accessPk(tenant: string, r: Resource, l: List, values: unknown[]): string {
    return encodeIdentity(["T", tenant, "R", this.wire(r), "Q", l.name, ...values.map(String)]);
  }
  private accessSk(r: Resource, l: List, rec: StoredRecord): string {
    const keys = l.order.map((o) => {
      const f = fieldOf(r, o.field)!;
      const type = f.type.base.kind === "scalar" ? f.type.base.name : f.type.base.kind;
      return sortKey(rec[o.field], type, { scale: scaleOf(f.type) });
    });
    return encodeIdentity(keys);
  }
  private auditKey(tenant: string, opId: string) {
    return { PK: encodeIdentity(["T", tenant, "A", opId]), SK: "AUDIT" };
  }
  private outboxKey(tenant: string, opId: string, ordinal: number) {
    return { PK: encodeIdentity(["T", tenant, "O", opId]), SK: `E#${String(ordinal).padStart(6, "0")}` };
  }
  private receiptKey(tenant: string, operation: string, key: string) {
    return { PK: encodeIdentity(["T", tenant, "K", operation, key]), SK: "RECEIPT" };
  }

  private wrap<A>(f: () => Promise<A>): Effect.Effect<A, ForgeError> {
    return Effect.tryPromise({ try: f, catch: (e) => err("StorageUnavailable", String((e as Error).message ?? e)) });
  }

  private toStored(r: Resource, item: Item): StoredRecord {
    const rec: StoredRecord = {};
    for (const f of r.fields) if (!f.derived) rec[f.name] = item[f.name] === undefined ? null : item[f.name];
    return rec;
  }

  // ------------------------------------------------------------ reads
  get(tenant: string, r: Resource, id: string): Effect.Effect<StoredRecord | null, ForgeError> {
    return this.wrap(async () => {
      const out = await this.doc.send(new GetCommand({ TableName: this.table, Key: this.entityKey(tenant, r, id), ConsistentRead: true }));
      return out.Item ? this.toStored(r, out.Item as Item) : null;
    });
  }

  findUnique(tenant: string, r: Resource, u: Unique, _claimKey: string, values: Record<string, unknown>): Effect.Effect<StoredRecord | null, ForgeError> {
    const fields = [...u.within, ...u.fields];
    const key = this.claimKey(tenant, r, u, fields.map((f) => String(values[f])));
    return this.wrap(async () => {
      const claim = await this.doc.send(new GetCommand({ TableName: this.table, Key: key, ConsistentRead: true }));
      const id = claim.Item?.["entityId"];
      if (typeof id !== "string") return null;
      const out = await this.doc.send(new GetCommand({ TableName: this.table, Key: this.entityKey(tenant, r, id), ConsistentRead: true }));
      return out.Item ? this.toStored(r, out.Item as Item) : null;
    });
  }

  list(tenant: string, r: Resource, q: ListQuery, _sortKeys: (rec: StoredRecord) => string[]): Effect.Effect<{ records: StoredRecord[]; hasMore: boolean }, ForgeError> {
    const l = q.list;
    const pk = this.accessPk(tenant, r, l, l.fields.map((f) => q.values[f]));
    const forward = (l.order[0]?.direction ?? "asc") !== "desc";
    return this.wrap(async () => {
      const values: Item = { ":pk": pk };
      let cond = "PK = :pk";
      if (q.after) {
        // The access item's SK is the encoded sort keys (the last one is the id tie-breaker).
        values[":after"] = encodeIdentity([...q.after.keys]);
        cond += forward ? " AND SK > :after" : " AND SK < :after";
      }
      const out = await this.doc.send(new QueryCommand({ TableName: this.table, ConsistentRead: true, KeyConditionExpression: cond, ExpressionAttributeValues: values, ScanIndexForward: forward, Limit: q.limit + 1 }));
      const items = (out.Items ?? []) as Item[];
      const page = items.slice(0, q.limit);
      // Access items carry the full public record projection, so no second read is needed.
      return { records: page.map((i) => this.toStored(r, i["record"] as Item)), hasMore: items.length > q.limit };
    });
  }

  getReceipt(tenant: string, operation: string, key: string): Effect.Effect<Receipt | null, ForgeError> {
    return this.wrap(async () => {
      const out = await this.doc.send(new GetCommand({ TableName: this.table, Key: this.receiptKey(tenant, operation, key), ConsistentRead: true }));
      if (!out.Item) return null;
      const i = out.Item as Item;
      return { tenant, operation, key, requestHash: String(i["requestHash"]), status: Number(i["status"]), response: i["response"], createdAt: String(i["createdAt"]) };
    });
  }

  // ------------------------------------------------------------ commit
  commit(plan: CommitPlan): Effect.Effect<void, ForgeError> {
    const self = this;
    return Effect.gen(function* () {
      const { items, roles } = self.buildTransaction(plan);
      for (let attempt = 1; ; attempt++) {
        const outcome = yield* self.send(items, roles, plan);
        if (outcome === "ok") return;
        if (outcome.code !== "TransientConflict" || attempt >= RETRY_ATTEMPTS) return yield* Effect.fail(outcome);
        yield* Effect.sleep(Math.floor(Math.random() * 40 * attempt));
      }
    });
  }

  private buildTransaction(plan: CommitPlan): { items: TxItem[]; roles: Role[] } {
    const { resource: r, tenant, id } = plan;
    const items: TxItem[] = [];
    const roles: Role[] = [];
    const push = (role: Role, item: TxItem) => {
      roles.push(role);
      items.push(item);
    };
    const entity: Item = { ...this.entityKey(tenant, r, id), ...plan.after };
    if (plan.kind === "create") {
      push("entity", { Put: { TableName: this.table, Item: entity, ConditionExpression: "attribute_not_exists(PK)" } });
    } else {
      const cond = plan.expectedVersion !== null ? "attribute_exists(PK) AND version = :v" : "attribute_exists(PK)";
      push("entity", { Put: { TableName: this.table, Item: entity, ConditionExpression: cond, ...(plan.expectedVersion !== null ? { ExpressionAttributeValues: { ":v": plan.expectedVersion } } : {}), ReturnValuesOnConditionCheckFailure: "ALL_OLD" } });
    }
    // unique claims
    for (const c of plan.claims) {
      if (c.before && c.before !== c.after) {
        push("claim", { Delete: { TableName: this.table, Key: this.claimKeyFromEncoded(tenant, r, c.unique, c.before, plan.before!) } });
      }
      if (c.after && c.after !== c.before) {
        push("claim", { Put: { TableName: this.table, Item: { ...this.claimKeyFromEncoded(tenant, r, c.unique, c.after, plan.after), entityId: id }, ConditionExpression: "attribute_not_exists(PK) OR entityId = :me", ExpressionAttributeValues: { ":me": id } } });
      }
    }
    // strong access items: one per list query; moved when partition or sort keys change
    for (const l of r.lists) {
      const live = !plan.after["deletedAt"];
      const beforeKey = plan.before && !plan.before["deletedAt"] ? { PK: this.accessPk(tenant, r, l, l.fields.map((f) => plan.before![f])), SK: this.accessSk(r, l, plan.before!) } : null;
      const afterKey = live ? { PK: this.accessPk(tenant, r, l, l.fields.map((f) => plan.after[f])), SK: this.accessSk(r, l, plan.after) } : null;
      const same = beforeKey && afterKey && beforeKey.PK === afterKey.PK && beforeKey.SK === afterKey.SK;
      if (beforeKey && !same) push("access", { Delete: { TableName: this.table, Key: beforeKey } });
      if (afterKey) push("access", { Put: { TableName: this.table, Item: { ...afterKey, record: plan.after, id, version: plan.after["version"] ?? null } } });
    }
    // reference guards: ConditionCheck that the parent is live (no counter yet: restrict-delete arrives in M3)
    for (const g of plan.references) {
      const live = g.resource.decorators.softDelete ? "attribute_exists(PK) AND attribute_not_exists(deletedAt) OR (attribute_exists(PK) AND deletedAt = :null)" : "attribute_exists(PK)";
      push("parent", { ConditionCheck: { TableName: this.table, Key: this.entityKey(tenant, g.resource, g.id), ConditionExpression: live, ...(g.resource.decorators.softDelete ? { ExpressionAttributeValues: { ":null": null } } : {}) } });
    }
    const a = plan.audit;
    push("audit", { Put: { TableName: this.table, Item: { ...this.auditKey(tenant, a.opId), resource: a.resource, recordId: a.recordId, kind: a.kind, newVersion: a.newVersion, actor: a.actor, at: a.at, ...(a.payload !== undefined ? { payload: a.payload } : {}) } } });
    for (const o of plan.outbox) {
      push("outbox", { Put: { TableName: this.table, Item: { ...this.outboxKey(tenant, o.opId, o.ordinal), channel: o.channel, message: o.message, payload: o.payload, status: "pending", attempts: 0, pendingShard: encodeIdentity(["T", tenant]), pendingAt: Date.parse(o.createdAt), createdAt: o.createdAt } } });
    }
    if (plan.receipt) {
      const rc = plan.receipt;
      push("receipt", { Put: { TableName: this.table, Item: { ...this.receiptKey(tenant, rc.operation, rc.key), requestHash: rc.requestHash, status: rc.status, response: rc.response, createdAt: rc.createdAt }, ConditionExpression: "attribute_not_exists(PK)" } });
    }
    return { items, roles };
  }

  /** The engine encodes claim keys as identity(resourceId, unique, ...values); map to the physical key. */
  private claimKeyFromEncoded(tenant: string, r: Resource, u: Unique, _encoded: string, rec: StoredRecord) {
    const fields = [...u.within, ...u.fields];
    return this.claimKey(tenant, r, u, fields.map((f) => String(rec[f])));
  }

  private send(items: TxItem[], roles: Role[], plan: CommitPlan): Effect.Effect<"ok" | ForgeError, never> {
    return Effect.promise(async () => {
      try {
        // Deterministic token per logical command: a retried/replayed identical command is idempotent for 10 minutes.
        await this.doc.send(new TransactWriteCommand({ TransactItems: items, ClientRequestToken: plan.opId.slice(0, 36) }));
        return "ok" as const;
      } catch (e) {
        return this.classify(e, roles, plan);
      }
    });
  }

  private classify(e: unknown, roles: Role[], plan: CommitPlan): ForgeError {
    const ex = e as Error & { name: string; CancellationReasons?: { Code?: string; Message?: string; Item?: Record<string, AttributeValue> }[] };
    if (ex.name === "IdempotentParameterMismatchException") return err("TransientConflict", "client token collision");
    if (ex.name === "TransactionInProgressException") return err("TransientConflict", "transaction in progress");
    if (ex.name !== "TransactionCanceledException") return err("StorageUnavailable", String(ex.message ?? e));
    const reasons = (ex.CancellationReasons ?? []).map((r, i) => ({ role: roles[i], code: r.Code, item: r.Item ? unmarshall(r.Item) : undefined }));
    if (reasons.some((r) => r.code === "TransactionConflict")) return err("TransientConflict", "transaction conflict");
    const failed = reasons.find((r) => r.code === "ConditionalCheckFailed");
    switch (failed?.role) {
      case "entity": {
        if (plan.kind === "create") return err("TransientConflict", "id collision");
        const old = failed.item;
        if (!old) return err("NotFound", `${plan.resource.name} ${plan.id} not found`);
        return err("VersionConflict", `expected version ${plan.expectedVersion}, current is ${old["version"]}`);
      }
      case "claim": {
        const idx = reasons.findIndex((r) => r === failed);
        const claimIdx = roles.slice(0, idx).filter((r) => r === "claim").length;
        const changes = plan.claims.filter((c) => c.after && c.after !== c.before);
        const u = changes[Math.min(claimIdx, changes.length - 1)]?.unique;
        return err("UniqueConflict", "a record with the same unique key exists", u ? { constraint: `${plan.resource.id}.unique.${u.name}` } : {});
      }
      case "parent":
        return err("ReferenceMissing", "referenced record is not live in this tenant");
      case "receipt":
        return err("TransientConflict", "receipt already written");
      default:
        return err("StorageUnavailable", `transaction cancelled: ${reasons.map((r) => r.code).join(",")}`);
    }
  }
}
