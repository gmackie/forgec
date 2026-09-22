/**
 * DynamoDB storage adapter (plan §11), following the protocol certified by
 * the M0 spike: entity + unique claims + strong access items + audit + outbox
 * + receipt in one TransactWriteItems; bounded retry of TransactionConflict;
 * ClientRequestToken derived from the operation id.
 */
import { CreateTableCommand, DescribeTableCommand, DynamoDBClient, ResourceNotFoundException, UpdateTableCommand, waitUntilTableExists, type AttributeValue } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand, PutCommand, QueryCommand, ScanCommand, TransactWriteCommand, UpdateCommand, type TransactWriteCommandInput } from "@aws-sdk/lib-dynamodb";
import { unmarshall } from "@aws-sdk/util-dynamodb";
import { Effect } from "effect";
import { encodeIdentity, sortKey } from "../codecs.js";
import { err, type ForgeError } from "../errors.js";
import { fieldOf, scaleOf, type List, type Model, type Resource, type Unique } from "../model.js";
import type { DocumentWrite, CommitPlan, IntervalGuard, ListQuery, OutboxRow, Receipt, StorageAdapter, StoredRecord } from "../services.js";

export const PENDING_INDEX = "pending-index";

/** Attribute on a parent entity counting live children of (child, field). */
function depAttr(child: Resource, field: string, model: Model): string {
  return `dep#${model.wireName(child.id)}#${field}`;
}
const RETRY_ATTEMPTS = 5;
/** TransactWriteItems ceiling: 100 actions / 4 MB. */
const DYNAMO_TX_LIMIT = 100;

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
    // dep#… counters and keys are physical metadata, never part of the record
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

  /**
   * Restrict-delete on DynamoDB uses a per-(child, field) live-dependent counter on the parent
   * entity (`dep#<child>#<field>`), maintained in the child's transaction (plan §11.4). The
   * pre-check reads it; the delete transaction conditions on it being zero or absent.
   */
  countDependents(tenant: string, child: Resource, field: string, id: string): Effect.Effect<number, ForgeError> {
    const parent = this.model.resource(fieldOf(child, field)!.type.base.kind === "reference" ? (fieldOf(child, field)!.type.base as { resource: string }).resource : "");
    return this.wrap(async () => {
      const out = await this.doc.send(new GetCommand({ TableName: this.table, Key: this.entityKey(tenant, parent, id), ConsistentRead: true, ProjectionExpression: "#c", ExpressionAttributeNames: { "#c": depAttr(child, field, this.model) } }));
      return Number(out.Item?.[depAttr(child, field, this.model)] ?? 0);
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

  // ------------------------------------------------------------ effective dating and hierarchy (§18)
  /** Interval rows of a group live under one partition (ordered by effectiveFrom) so neighbours are one bounded query. */
  private intervalPk(tenant: string, r: Resource, groupValues: unknown[]): string {
    return encodeIdentity(["T", tenant, "R", this.wire(r), "E", ...groupValues.map(String)]);
  }
  private groupGuardKey(tenant: string, r: Resource, groupValues: unknown[]) {
    return { PK: this.intervalPk(tenant, r, groupValues), SK: "GUARD" };
  }
  private async groupRows(tenant: string, r: Resource, groupValues: unknown[]): Promise<StoredRecord[]> {
    const out = await this.doc.send(new QueryCommand({ TableName: this.table, ConsistentRead: true, KeyConditionExpression: "PK = :pk AND begins_with(SK, :i)", ExpressionAttributeValues: { ":pk": this.intervalPk(tenant, r, groupValues), ":i": "I#" }, Limit: 500 }));
    return ((out.Items ?? []) as Item[]).map((i) => this.toStored(r, i["record"] as Item)).filter((x) => !x["deletedAt"]);
  }
  private overlaps(rec: StoredRecord, g: IntervalGuard): boolean {
    if (rec["id"] === g.excludeId) return false;
    const from = String(rec["effectiveFrom"]);
    const until = (rec["effectiveUntil"] as string | null) ?? null;
    return (until === null || g.from < until) && (g.until === null || from < g.until);
  }
  overlapping(tenant: string, r: Resource, g: IntervalGuard): Effect.Effect<StoredRecord[], ForgeError> {
    return this.wrap(async () => {
      const guard = await this.doc.send(new GetCommand({ TableName: this.table, Key: this.groupGuardKey(tenant, r, g.groupValues), ConsistentRead: true }));
      g.revision = Number(guard.Item?.["rev"] ?? 0);
      return (await this.groupRows(tenant, r, g.groupValues)).filter((x) => this.overlaps(x, g));
    });
  }
  effectiveAt(tenant: string, r: Resource, _groupFields: string[], groupValues: unknown[], at: string): Effect.Effect<StoredRecord | null, ForgeError> {
    return this.wrap(async () => (await this.groupRows(tenant, r, groupValues)).find((x) => String(x["effectiveFrom"]) <= at && (x["effectiveUntil"] == null || at < String(x["effectiveUntil"]))) ?? null);
  }
  /** Children of a node live under a per-parent partition (an access family maintained in the entity transaction). */
  private childPk(tenant: string, r: Resource, parentId: string): string {
    return encodeIdentity(["T", tenant, "R", this.wire(r), "C", parentId]);
  }
  children(tenant: string, r: Resource, _parentField: string, id: string, limit: number): Effect.Effect<StoredRecord[], ForgeError> {
    return this.wrap(async () => {
      const out = await this.doc.send(new QueryCommand({ TableName: this.table, ConsistentRead: true, KeyConditionExpression: "PK = :pk", ExpressionAttributeValues: { ":pk": this.childPk(tenant, r, id) }, Limit: limit }));
      return ((out.Items ?? []) as Item[]).map((i) => this.toStored(r, i["record"] as Item)).filter((x) => !x["deletedAt"]);
    });
  }

  // ------------------------------------------------------------ outbox dispatch (sparse pending GSI + fenced lease, M0-certified)
  private outboxRowOf(i: Item): OutboxRow {
    return {
      tenant: String(i["tenant"]), opId: String(i["opId"]), ordinal: Number(i["ordinal"]), channel: String(i["channel"]), message: String(i["message"]),
      payload: i["payload"], createdAt: String(i["createdAt"]), status: i["status"] as OutboxRow["status"], attempts: Number(i["attempts"] ?? 0),
      ...(i["trace"] ? { trace: i["trace"] as NonNullable<OutboxRow["trace"]> } : {}),
      leaseOwner: (i["leaseOwner"] as string | null) ?? null, leaseUntil: i["leaseUntil"] === undefined ? null : Number(i["leaseUntil"]), delivered: (i["delivered"] as string[] | undefined) ?? [],
    };
  }
  /** A marker item per tenant in the "ALL" shard lets the sweep enumerate tenants with recent outbox activity. */
  private tenantMarker(tenant: string, createdAt: string): TxItem {
    return { Put: { TableName: this.table, Item: { PK: encodeIdentity(["OUTBOX-TENANT", tenant]), SK: "MARKER", tenant, pendingShard: "ALL", pendingAt: Date.parse(createdAt) } } };
  }
  /** Tenants with outbox activity (markers in the ALL shard; harmless if a tenant has nothing pending). */
  outboxTenants(): Effect.Effect<string[], ForgeError> {
    return this.wrap(async () => {
      const out = await this.doc.send(new QueryCommand({ TableName: this.table, IndexName: PENDING_INDEX, KeyConditionExpression: "pendingShard = :s", ExpressionAttributeValues: { ":s": "ALL" }, Limit: 1000 }));
      return [...new Set(((out.Items ?? []) as Item[]).map((i) => String(i["tenant"])))];
    });
  }
  outboxSweep(tenant: string, now: number, limit: number): Effect.Effect<OutboxRow[], ForgeError> {
    return this.wrap(async () => {
      const out = await this.doc.send(new QueryCommand({ TableName: this.table, IndexName: PENDING_INDEX, KeyConditionExpression: "pendingShard = :s", FilterExpression: "attribute_not_exists(leaseUntil) OR leaseUntil < :now", ExpressionAttributeValues: { ":s": encodeIdentity(["T", tenant]), ":now": now }, Limit: limit }));
      return ((out.Items ?? []) as Item[]).map((i) => this.outboxRowOf(i));
    });
  }
  private async conditional(cmd: UpdateCommand): Promise<boolean> {
    try {
      await this.doc.send(cmd);
      return true;
    } catch (e) {
      if ((e as Error).name === "ConditionalCheckFailedException") return false;
      throw e;
    }
  }
  outboxClaim(r: { tenant: string; opId: string; ordinal: number }, owner: string, now: number, leaseMs: number): Effect.Effect<boolean, ForgeError> {
    return this.wrap(() => this.conditional(new UpdateCommand({ TableName: this.table, Key: this.outboxKey(r.tenant, r.opId, r.ordinal), UpdateExpression: "SET leaseOwner = :o, leaseUntil = :u, attempts = if_not_exists(attempts, :zero) + :one", ConditionExpression: "#s = :pending AND (attribute_not_exists(leaseUntil) OR leaseUntil < :now)", ExpressionAttributeNames: { "#s": "status" }, ExpressionAttributeValues: { ":o": owner, ":u": now + leaseMs, ":zero": 0, ":one": 1, ":pending": "pending", ":now": now } })));
  }
  outboxProgress(r: { tenant: string; opId: string; ordinal: number }, owner: string, u: { delivered: string[]; done?: boolean; dead?: boolean; releaseLease?: boolean }): Effect.Effect<boolean, ForgeError> {
    const sets = ["delivered = list_append(if_not_exists(delivered, :empty), :d)"];
    const removes: string[] = [];
    const values: Item = { ":d": u.delivered, ":empty": [], ":pending": "pending", ":o": owner };
    if (u.done) {
      sets.push("#s = :ns");
      values[":ns"] = "delivered";
      removes.push("pendingShard", "pendingAt"); // leave the sparse index
    } else if (u.dead) {
      sets.push("#s = :ns", "pendingShard = :deadShard");
      values[":ns"] = "dead";
      values[":deadShard"] = encodeIdentity(["T", r.tenant, "dead"]); // parked in a listable shard
    }
    if (u.done || u.dead || u.releaseLease) removes.push("leaseOwner", "leaseUntil");
    const expr = `SET ${sets.join(", ")}${removes.length ? ` REMOVE ${removes.join(", ")}` : ""}`;
    return this.wrap(() => this.conditional(new UpdateCommand({ TableName: this.table, Key: this.outboxKey(r.tenant, r.opId, r.ordinal), UpdateExpression: expr, ConditionExpression: "#s = :pending AND leaseOwner = :o", ExpressionAttributeNames: { "#s": "status" }, ExpressionAttributeValues: values })));
  }
  outboxDead(tenant: string): Effect.Effect<OutboxRow[], ForgeError> {
    return this.wrap(async () => {
      const out = await this.doc.send(new QueryCommand({ TableName: this.table, IndexName: PENDING_INDEX, KeyConditionExpression: "pendingShard = :s", ExpressionAttributeValues: { ":s": encodeIdentity(["T", tenant, "dead"]) } }));
      return ((out.Items ?? []) as Item[]).map((i) => this.outboxRowOf(i));
    });
  }
  outboxRedrive(r: { tenant: string; opId: string; ordinal: number }): Effect.Effect<boolean, ForgeError> {
    return this.wrap(() => this.conditional(new UpdateCommand({ TableName: this.table, Key: this.outboxKey(r.tenant, r.opId, r.ordinal), UpdateExpression: "SET #s = :pending, attempts = :zero, pendingShard = :shard, pendingAt = :at REMOVE leaseOwner, leaseUntil", ConditionExpression: "#s = :dead", ExpressionAttributeNames: { "#s": "status" }, ExpressionAttributeValues: { ":pending": "pending", ":dead": "dead", ":zero": 0, ":shard": encodeIdentity(["T", r.tenant]), ":at": Date.now() } })));
  }
  markProcessed(tenant: string, subscription: string, messageId: string): Effect.Effect<boolean, ForgeError> {
    return Effect.tryPromise({
      try: async () => {
        await this.doc.send(new PutCommand({ TableName: this.table, Item: { PK: encodeIdentity(["T", tenant, "P", subscription, messageId]), SK: "PROCESSED", at: new Date().toISOString() }, ConditionExpression: "attribute_not_exists(PK)" }));
        return true;
      },
      catch: (e) => ((e as Error).name === "ConditionalCheckFailedException" ? "dup" : err("StorageUnavailable", String((e as Error).message))),
    }).pipe(Effect.catch((e) => (e === "dup" ? Effect.succeed(false) : Effect.fail(e as ForgeError))));
  }

  // ------------------------------------------------------------ documents
  private documentKey(tenant: string, kind: string, id: string) {
    return { PK: encodeIdentity(["T", tenant, "D", kind, id]), SK: "DOC" };
  }

  /** Entities have per-item partitions, so an export is a filtered Scan: admin-only, run behind the write fence. */
  exportPage(tenant: string, r: Resource, cursor: string | null, limit: number): Effect.Effect<{ records: StoredRecord[]; next: string | null }, ForgeError> {
    return this.wrap(async () => {
      const prefix = encodeIdentity(["T", tenant, "R", this.wire(r), "I", ""]);
      const out = await this.doc.send(new ScanCommand({ TableName: this.table, ConsistentRead: true, FilterExpression: "begins_with(PK, :p) AND SK = :e", ExpressionAttributeValues: { ":p": prefix, ":e": "ENTITY" }, Limit: Math.max(limit * 4, 100), ...(cursor ? { ExclusiveStartKey: JSON.parse(cursor) as Record<string, unknown> } : {}) }));
      const records = (out.Items ?? []).map((i) => this.toStored(r, i as Item));
      return { records, next: out.LastEvaluatedKey ? JSON.stringify(out.LastEvaluatedKey) : null };
    });
  }

  getDocument(tenant: string, kind: string, id: string): Effect.Effect<Record<string, unknown> | null, ForgeError> {
    return this.wrap(async () => {
      const out = await this.doc.send(new GetCommand({ TableName: this.table, Key: this.documentKey(tenant, kind, id), ConsistentRead: true }));
      if (!out.Item) return null;
      const { PK, SK, docVersion, ...rest } = out.Item as Item;
      void PK;
      void SK;
      return { ...rest, _version: Number(docVersion) };
    });
  }

  putDocuments(tenant: string, writes: DocumentWrite[]): Effect.Effect<void, ForgeError> {
    if (writes.length > 24 || new Set(writes.map(w=>JSON.stringify([w.kind,w.id]))).size !== writes.length) return Effect.fail(err("BudgetExceeded", "document batch must contain at most 24 distinct keys"));
    if (!writes.length) return Effect.void;
    const items = writes.map(w=>{
      const { _version,...rest } = w.doc; void _version;
      return {Put:{TableName:this.table,Item:{...rest,...this.documentKey(tenant,w.kind,w.id),docVersion:(w.expectedVersion ?? 0)+1},ConditionExpression:w.expectedVersion === null ? "attribute_not_exists(PK)" : "docVersion = :v",...(w.expectedVersion === null ? {} : {ExpressionAttributeValues:{":v":w.expectedVersion}})}};
    });
    return Effect.tryPromise({try:async()=>{await this.doc.send(new TransactWriteCommand({TransactItems:items}));},catch:(e)=> (e as Error).name === "TransactionCanceledException" ? err("VersionConflict","document batch changed concurrently") : err("StorageUnavailable",String(e))});
  }

  putDocument(tenant: string, kind: string, id: string, doc: Record<string, unknown>, expectedVersion: number | null): Effect.Effect<void, ForgeError> {
    const { _version, ...rest } = doc as Record<string, unknown> & { _version?: unknown };
    void _version;
    const item: Item = { ...this.documentKey(tenant, kind, id), ...rest, docVersion: (expectedVersion ?? 0) + 1 };
    return Effect.tryPromise({
      try: () => this.doc.send(new TransactWriteCommand({ TransactItems: [{ Put: { TableName: this.table, Item: item, ConditionExpression: expectedVersion === null ? "attribute_not_exists(PK)" : "docVersion = :v", ...(expectedVersion !== null ? { ExpressionAttributeValues: { ":v": expectedVersion } } : {}) } }] })),
      catch: (e) => ((e as Error).name === "TransactionCanceledException" ? err("VersionConflict", "document changed concurrently") : err("StorageUnavailable", String((e as Error).message))),
    }).pipe(Effect.asVoid);
  }

  budget(plans: CommitPlan[]): { actions: number; limit: number } {
    return { actions: plans.reduce((n, p) => n + this.buildTransaction(p).items.length, 0), limit: DYNAMO_TX_LIMIT };
  }

  // ------------------------------------------------------------ commit
  commit(plan: CommitPlan): Effect.Effect<void, ForgeError> {
    return this.commitAll([plan]);
  }

  /** Several logical commands in one TransactWriteItems. Actions on the same item are coalesced by the planner
   *  only for parent counters; distinct commands touching the same entity are rejected up front. */
  commitAll(plans: CommitPlan[]): Effect.Effect<void, ForgeError> {
    const self = this;
    return Effect.gen(function* () {
      const items: TxItem[] = [];
      const roles: Role[] = [];
      const owners: CommitPlan[] = [];
      const touched = new Set<string>();
      for (const plan of plans) {
        const key = `${plan.resource.id}|${plan.tenant}|${plan.id}`;
        if (touched.has(key)) return yield* Effect.fail(err("BudgetExceeded", "an atomic changeset cannot contain two operations on the same record on DynamoDB"));
        touched.add(key);
        const built = self.buildTransaction(plan);
        items.push(...built.items);
        roles.push(...built.roles);
        owners.push(...built.items.map(() => plan));
      }
      // One tenant marker per transaction (DynamoDB forbids two actions on one item).
      const withOutbox = plans.filter((p) => p.outbox.length > 0);
      if (withOutbox.length) {
        items.push(self.tenantMarker(withOutbox[0]!.tenant, withOutbox[0]!.outbox[0]!.createdAt));
        roles.push("outbox");
        owners.push(withOutbox[0]!);
      }
      if (items.length > DYNAMO_TX_LIMIT) return yield* Effect.fail(err("BudgetExceeded", `${items.length} physical actions exceed the transaction limit of ${DYNAMO_TX_LIMIT}`));
      for (let attempt = 1; ; attempt++) {
        const outcome = yield* self.send(items, roles, owners, plans[0]!);
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
    if (plan.kind === "publish") {
      const a = plan.audit;
      push("audit", { Put: { TableName: this.table, Item: { ...this.auditKey(tenant, a.opId), resource: a.resource, recordId: a.recordId, kind: a.kind, newVersion: a.newVersion, actor: a.actor, at: a.at } } });
      for (const o of plan.outbox) {
        push("outbox", { Put: { TableName: this.table, Item: { ...this.outboxKey(tenant, o.opId, o.ordinal), tenant, opId: o.opId, ordinal: o.ordinal, channel: o.channel, message: o.message, payload: o.payload, status: "pending", attempts: 0, delivered: [], pendingShard: encodeIdentity(["T", tenant]), pendingAt: Date.parse(o.createdAt), createdAt: o.createdAt, ...(o.trace ? { trace: o.trace } : {}) } } });
      }
      if (plan.receipt) {
        const rc = plan.receipt;
        push("receipt", { Put: { TableName: this.table, Item: { ...this.receiptKey(tenant, rc.operation, rc.key), requestHash: rc.requestHash, status: rc.status, response: rc.response, createdAt: rc.createdAt }, ConditionExpression: "attribute_not_exists(PK)" } });
      }
      return { items, roles };
    }
    const entityKey = this.entityKey(tenant, r, id);
    const depGuards = plan.dependents.map((d) => depAttr(d.resource, d.field, this.model));
    if (plan.kind === "create") {
      push("entity", { Put: { TableName: this.table, Item: { ...entityKey, ...plan.after }, ConditionExpression: "attribute_not_exists(PK)" } });
    } else if (plan.hardDelete) {
      const names: Record<string, string> = {};
      const conds = ["attribute_exists(PK)"];
      if (plan.expectedVersion !== null) conds.push("version = :v");
      depGuards.forEach((a, i) => {
        names[`#d${i}`] = a;
        conds.push(`(attribute_not_exists(#d${i}) OR #d${i} = :zero)`);
      });
      push("entity", { Delete: { TableName: this.table, Key: entityKey, ConditionExpression: conds.join(" AND "), ExpressionAttributeValues: { ...(plan.expectedVersion !== null ? { ":v": plan.expectedVersion } : {}), ...(depGuards.length ? { ":zero": 0 } : {}) }, ...(depGuards.length ? { ExpressionAttributeNames: names } : {}), ReturnValuesOnConditionCheckFailure: "ALL_OLD" } });
    } else {
      // Update (not Put) so dependent counters on this entity survive the write.
      const fields = Object.keys(plan.after).filter((k) => !plan.resource.fields.find((f) => f.name === k)?.derived);
      const names: Record<string, string> = {};
      const values: Item = {};
      const sets: string[] = [];
      fields.forEach((k, i) => {
        names[`#f${i}`] = k;
        values[`:f${i}`] = plan.after[k] === undefined ? null : plan.after[k];
        sets.push(`#f${i} = :f${i}`);
      });
      const conds = ["attribute_exists(PK)"];
      if (plan.expectedVersion !== null) {
        conds.push("version = :v");
        values[":v"] = plan.expectedVersion;
      }
      depGuards.forEach((a, i) => {
        names[`#d${i}`] = a;
        conds.push(`(attribute_not_exists(#d${i}) OR #d${i} = :zero)`);
        values[":zero"] = 0;
      });
      push("entity", { Update: { TableName: this.table, Key: entityKey, UpdateExpression: `SET ${sets.join(", ")}`, ConditionExpression: conds.join(" AND "), ExpressionAttributeNames: names, ExpressionAttributeValues: values, ReturnValuesOnConditionCheckFailure: "ALL_OLD" } });
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
      const live = !plan.hardDelete && !plan.after["deletedAt"];
      const beforeKey = plan.before && !plan.before["deletedAt"] ? { PK: this.accessPk(tenant, r, l, l.fields.map((f) => plan.before![f])), SK: this.accessSk(r, l, plan.before!) } : null;
      const afterKey = live ? { PK: this.accessPk(tenant, r, l, l.fields.map((f) => plan.after[f])), SK: this.accessSk(r, l, plan.after) } : null;
      const same = beforeKey && afterKey && beforeKey.PK === afterKey.PK && beforeKey.SK === afterKey.SK;
      if (beforeKey && !same) push("access", { Delete: { TableName: this.table, Key: beforeKey } });
      if (afterKey) push("access", { Put: { TableName: this.table, Item: { ...afterKey, record: plan.after, id, version: plan.after["version"] ?? null } } });
    }
    // effective dating: an interval item per record in the group partition + a per-group revision guard.
    // Every mutation of the group bumps the guard; planning read the group under the same revision, so a
    // concurrent overlapping write is rejected by the guard condition (§18).
    if (r.decorators.effectiveDated) {
      const ed = r.decorators.effectiveDated;
      const groupOf = (rec: StoredRecord | null) => (rec ? ed.uniqueBy.map((f) => rec[f]) : null);
      const beforeGroup = plan.before && !plan.before["deletedAt"] ? groupOf(plan.before) : null;
      const afterGroup = !plan.hardDelete && !plan.after["deletedAt"] ? groupOf(plan.after) : null;
      const sk = (rec: StoredRecord) => `I#${String(rec["effectiveFrom"])}#${id}`;
      if (beforeGroup && (!afterGroup || beforeGroup.join("\u0001") !== afterGroup.join("\u0001") || sk(plan.before!) !== sk(plan.after))) {
        push("access", { Delete: { TableName: this.table, Key: { PK: this.intervalPk(tenant, r, beforeGroup), SK: sk(plan.before!) } } });
      }
      if (afterGroup) {
        push("access", { Put: { TableName: this.table, Item: { PK: this.intervalPk(tenant, r, afterGroup), SK: sk(plan.after), record: plan.after, id } } });
      }
      if (plan.interval) {
        const expected = plan.interval.revision ?? 0;
        push("parent", { Update: { TableName: this.table, Key: this.groupGuardKey(tenant, r, plan.interval.groupValues), UpdateExpression: "SET rev = :next", ConditionExpression: "attribute_not_exists(rev) OR rev = :expected", ExpressionAttributeValues: { ":next": expected + 1, ":expected": expected } } });
      }
    }
    // hierarchy: a child index item per node under its parent's partition, moved with the node
    if (r.decorators.hierarchical) {
      const bp = plan.before && !plan.before["deletedAt"] ? (plan.before["parent"] as string | null) : null;
      const ap = !plan.hardDelete && !plan.after["deletedAt"] ? (plan.after["parent"] as string | null) : null;
      if (bp && bp !== ap) push("access", { Delete: { TableName: this.table, Key: { PK: this.childPk(tenant, r, bp), SK: `${String(plan.before!["name"] ?? "")}#${id}` } } });
      if (ap) push("access", { Put: { TableName: this.table, Item: { PK: this.childPk(tenant, r, ap), SK: `${String(plan.after["name"] ?? "")}#${id}`, record: plan.after, id } } });
    }
    // Tree pins: every observed ancestor must still have the parent we saw. Pins on items that also receive a
    // counter Update below are folded into that Update (DynamoDB allows one action per item).
    const pins = new Map<string, string | null>();
    if (r.decorators.hierarchical && plan.tree) {
      const chain = [plan.tree.parentId, ...plan.tree.ancestors.slice(1)];
      for (let i = 0; i < chain.length; i++) {
        const node = chain[i]!;
        if (node === id) continue;
        pins.set(node, plan.tree.ancestors[i + 1] ?? null);
      }
    }
    // reference guards: the parent must be live; its live-dependent counter for (this resource, field)
    // is incremented when the reference is created and decremented when it is removed or the child is
    // hard-deleted. One Update per parent item (DynamoDB forbids two actions on one item).
    const counterDeltas = new Map<string, { resource: Resource; id: string; deltas: Record<string, number> }>();
    const bump = (parentRes: Resource, parentId: string, attr: string, delta: number) => {
      const k = `${parentRes.id}|${parentId}`;
      const e = counterDeltas.get(k) ?? { resource: parentRes, id: parentId, deltas: {} };
      e.deltas[attr] = (e.deltas[attr] ?? 0) + delta;
      counterDeltas.set(k, e);
    };
    for (const f of r.fields) {
      if (f.type.base.kind !== "reference" || (f.synthesized && f.name !== "parent")) continue;
      const parentRes = this.model.resource(f.type.base.resource);
      const attr = depAttr(r, f.name, this.model);
      const beforeLive = plan.before && !plan.before["deletedAt"] ? plan.before[f.name] : null;
      const afterLive = !plan.hardDelete && !plan.after["deletedAt"] ? plan.after[f.name] : null;
      if (beforeLive !== afterLive) {
        if (typeof beforeLive === "string") bump(parentRes, beforeLive, attr, -1);
        if (typeof afterLive === "string") bump(parentRes, afterLive, attr, +1);
      }
    }
    const guardIds = new Set(plan.references.map((g) => `${g.resource.id}|${g.id}`));
    for (const [k, e] of counterDeltas) {
      const names: Record<string, string> = {};
      const values: Item = {};
      const adds: string[] = [];
      Object.entries(e.deltas).forEach(([attr, delta], i) => {
        if (delta === 0) return;
        names[`#c${i}`] = attr;
        values[`:c${i}`] = delta;
        adds.push(`#c${i} :c${i}`);
      });
      if (!adds.length) continue;
      const mustBeLive = guardIds.has(k) && e.resource.decorators.softDelete;
      const conds = ["attribute_exists(PK)"];
      if (mustBeLive) {
        conds.push("deletedAt = :null");
        values[":null"] = null;
      }
      // Hierarchy pin on this same item (tree guard) rides in the same Update.
      if (e.resource.id === r.id && pins.has(e.id)) {
        const expectedParent = pins.get(e.id) ?? null;
        pins.delete(e.id);
        if (expectedParent) {
          conds.push("parent = :tp");
          values[":tp"] = expectedParent;
        } else {
          conds.push("(attribute_not_exists(parent) OR parent = :tnull)");
          values[":tnull"] = null;
        }
      }
      push("parent", { Update: { TableName: this.table, Key: this.entityKey(tenant, e.resource, e.id), UpdateExpression: `ADD ${adds.join(", ")}`, ConditionExpression: conds.join(" AND "), ExpressionAttributeNames: names, ExpressionAttributeValues: values } });
    }
    for (const [node, expectedParent] of pins) {
      push("parent", { ConditionCheck: { TableName: this.table, Key: this.entityKey(tenant, r, node), ConditionExpression: expectedParent ? "attribute_exists(PK) AND parent = :p" : "attribute_exists(PK) AND (attribute_not_exists(parent) OR parent = :null)", ExpressionAttributeValues: expectedParent ? { ":p": expectedParent } : { ":null": null } } });
    }
    for (const g of plan.references) {
      if (g.field === "parent" && plan.tree) continue; // pinned by the tree guard's ConditionChecks
      if (counterDeltas.has(`${g.resource.id}|${g.id}`)) continue; // already guarded by the counter update
      const live = g.resource.decorators.softDelete ? "attribute_exists(PK) AND deletedAt = :null" : "attribute_exists(PK)";
      push("parent", { ConditionCheck: { TableName: this.table, Key: this.entityKey(tenant, g.resource, g.id), ConditionExpression: live, ...(g.resource.decorators.softDelete ? { ExpressionAttributeValues: { ":null": null } } : {}) } });
    }
    const a = plan.audit;
    push("audit", { Put: { TableName: this.table, Item: { ...this.auditKey(tenant, a.opId), resource: a.resource, recordId: a.recordId, kind: a.kind, newVersion: a.newVersion, actor: a.actor, at: a.at, ...(a.payload !== undefined ? { payload: a.payload } : {}) } } });
    for (const o of plan.outbox) {
      push("outbox", { Put: { TableName: this.table, Item: { ...this.outboxKey(tenant, o.opId, o.ordinal), tenant, opId: o.opId, ordinal: o.ordinal, channel: o.channel, message: o.message, payload: o.payload, status: "pending", attempts: 0, delivered: [], pendingShard: encodeIdentity(["T", tenant]), pendingAt: Date.parse(o.createdAt), createdAt: o.createdAt, ...(o.trace ? { trace: o.trace } : {}) } } });
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

  private send(items: TxItem[], roles: Role[], owners: CommitPlan[], first: CommitPlan): Effect.Effect<"ok" | ForgeError, never> {
    return Effect.promise(async () => {
      try {
        // Deterministic token per logical command: a retried/replayed identical command is idempotent for 10 minutes.
        await this.doc.send(new TransactWriteCommand({ TransactItems: items, ClientRequestToken: first.opId.slice(0, 36) }));
        return "ok" as const;
      } catch (e) {
        return this.classify(e, roles, owners, first);
      }
    });
  }

  private classify(e: unknown, roles: Role[], owners: CommitPlan[], first: CommitPlan): ForgeError {
    let plan = first;
    const ex = e as Error & { name: string; CancellationReasons?: { Code?: string; Message?: string; Item?: Record<string, AttributeValue> }[] };
    if (ex.name === "IdempotentParameterMismatchException") return err("TransientConflict", "client token collision");
    if (ex.name === "TransactionInProgressException") return err("TransientConflict", "transaction in progress");
    if (ex.name !== "TransactionCanceledException") return err("StorageUnavailable", String(ex.message ?? e));
    const reasons = (ex.CancellationReasons ?? []).map((r, i) => ({ role: roles[i], code: r.Code, message: r.Message, item: r.Item ? unmarshall(r.Item) : undefined }));
    if (reasons.some((r) => r.code === "TransactionConflict")) return err("TransientConflict", "transaction conflict");
    const failed = reasons.find((r) => r.code === "ConditionalCheckFailed");
    if (failed) plan = owners[reasons.indexOf(failed)] ?? first;
    switch (failed?.role) {
      case "entity": {
        if (plan.kind === "create") return err("TransientConflict", "id collision");
        const old = failed.item;
        if (!old) return err("NotFound", `${plan.resource.name} ${plan.id} not found`);
        if (plan.expectedVersion !== null && old["version"] !== plan.expectedVersion) return err("VersionConflict", `expected version ${plan.expectedVersion}, current is ${old["version"]}`);
        if (plan.dependents.some((d) => Number(old[depAttr(d.resource, d.field, this.model)] ?? 0) > 0)) return err("HasDependents", `${plan.resource.name} ${plan.id} has live dependents`);
        return err("TransientConflict", "entity condition failed");
      }
      case "claim": {
        const idx = reasons.findIndex((r) => r === failed);
        const planStart = owners.indexOf(plan);
        const claimIdx = roles.slice(planStart, idx).filter((r) => r === "claim").length;
        const changes = plan.claims.filter((c) => c.after && c.after !== c.before);
        const u = changes[Math.min(claimIdx, changes.length - 1)]?.unique;
        return err("UniqueConflict", "a record with the same unique key exists", u ? { constraint: `${plan.resource.id}.unique.${u.name}` } : {});
      }
      case "parent":
        if (plan.interval) return err("ValidationFailed", "interval group changed concurrently; retry", { fields: [{ path: "effectiveFrom", code: "IntervalOverlap", message: "group revision guard failed" }] });
        if (plan.tree) return err("ValidationFailed", "hierarchy changed concurrently; retry", { fields: [{ path: "parent", code: "Cycle", message: "tree guard failed at commit" }] });
        return err("ReferenceMissing", "referenced record is not live in this tenant");
      case "receipt":
        return err("TransientConflict", "receipt already written");
      default:
        return err("StorageUnavailable", `transaction cancelled: ${reasons.map((r) => `${r.role}=${r.code}${r.message ? `(${r.message})` : ""}`).join(",")}`);
    }
  }
}
