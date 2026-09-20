/**
 * Outbox dispatcher primitives (plan §14) on DynamoDB.
 *
 * Sweep reads the sparse `pending-index` GSI (eventually consistent). That is
 * safe only because acquisition is a conditional update on the base item: a
 * stale index read yields a failed claim, never a duplicate lease.
 */
import { QueryCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { doc, PENDING_INDEX, TABLE } from "./table.js";
import { key } from "./protocol.js";

export const pendingShard = (tenant: string) => `T#${tenant}`; // spike: one shard per tenant

export interface PendingRow {
  opId: string;
  ordinal: number;
  attempts: number;
}

export async function outboxSweep(tenant: string, now: number, limit = 100): Promise<PendingRow[]> {
  const r = await doc.send(
    new QueryCommand({
      TableName: TABLE,
      IndexName: PENDING_INDEX,
      KeyConditionExpression: "pendingShard = :s",
      FilterExpression: "attribute_not_exists(leaseUntil) OR leaseUntil < :now",
      ExpressionAttributeValues: { ":s": pendingShard(tenant), ":now": now },
      Limit: limit,
    }),
  );
  return (r.Items ?? []).map((i) => ({
    opId: String(i["PK"]).split("#O#")[1]!,
    ordinal: Number(String(i["SK"]).slice(2)),
    attempts: Number(i["attempts"] ?? 0),
  }));
}

interface Claim { tenant: string; opId: string; ordinal: number; owner: string; now: number; leaseMs: number }
interface Complete { tenant: string; opId: string; ordinal: number; owner: string }

async function conditional(cmd: UpdateCommand): Promise<boolean> {
  try {
    await doc.send(cmd);
    return true;
  } catch (e) {
    if ((e as Error).name === "ConditionalCheckFailedException") return false;
    throw e;
  }
}

/** Exactly one dispatcher wins a lease on a pending, unleased-or-expired row. */
export function outboxClaim(c: Claim): Promise<boolean> {
  return conditional(
    new UpdateCommand({
      TableName: TABLE,
      Key: key.outbox(c.tenant, c.opId, c.ordinal),
      UpdateExpression: "SET leaseOwner = :o, leaseUntil = :u, attempts = if_not_exists(attempts, :zero) + :one",
      ConditionExpression: "#s = :pending AND (attribute_not_exists(leaseUntil) OR leaseUntil < :now)",
      ExpressionAttributeNames: { "#s": "status" },
      ExpressionAttributeValues: { ":o": c.owner, ":u": c.now + c.leaseMs, ":zero": 0, ":one": 1, ":pending": "pending", ":now": c.now },
    }),
  );
}

/** Fenced completion; leaving the sparse index by removing pendingShard/pendingAt. */
export function outboxComplete(c: Complete): Promise<boolean> {
  return conditional(
    new UpdateCommand({
      TableName: TABLE,
      Key: key.outbox(c.tenant, c.opId, c.ordinal),
      UpdateExpression: "SET #s = :delivered REMOVE pendingShard, pendingAt, leaseOwner, leaseUntil",
      ConditionExpression: "#s = :pending AND leaseOwner = :o",
      ExpressionAttributeNames: { "#s": "status" },
      ExpressionAttributeValues: { ":delivered": "delivered", ":pending": "pending", ":o": c.owner },
    }),
  );
}
