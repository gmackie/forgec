import {
  CreateTableCommand,
  DescribeTableCommand,
  DynamoDBClient,
  ResourceNotFoundException,
  UpdateTableCommand,
  waitUntilTableExists,
} from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, ScanCommand } from "@aws-sdk/lib-dynamodb";

export const TABLE = process.env["SPIKE_TABLE"] ?? "forge-spike-tx";
/** Sparse GSI: only outbox items still pending carry pendingShard/pendingAt. */
export const PENDING_INDEX = "pending-index";
export const REGION = process.env["AWS_REGION"] ?? "us-east-1";

export const raw = new DynamoDBClient({ region: REGION });
export const doc = DynamoDBDocumentClient.from(raw, {
  marshallOptions: { removeUndefinedValues: true },
});

/** Single-table, PK/SK strings, on-demand billing. Created once and left in place (cheap). */
export async function ensureTable(): Promise<void> {
  try {
    await raw.send(new DescribeTableCommand({ TableName: TABLE }));
    return;
  } catch (e) {
    if (!(e instanceof ResourceNotFoundException)) throw e;
  }
  await raw.send(
    new CreateTableCommand({
      TableName: TABLE,
      BillingMode: "PAY_PER_REQUEST",
      AttributeDefinitions: [
        { AttributeName: "PK", AttributeType: "S" },
        { AttributeName: "SK", AttributeType: "S" },
      ],
      KeySchema: [
        { AttributeName: "PK", KeyType: "HASH" },
        { AttributeName: "SK", KeyType: "RANGE" },
      ],
      Tags: [{ Key: "forge", Value: "m0-spike" }],
    }),
  );
  await waitUntilTableExists({ client: raw, maxWaitTime: 120 }, { TableName: TABLE });
}

export async function ensurePendingIndex(): Promise<void> {
  const describe = async () => (await raw.send(new DescribeTableCommand({ TableName: TABLE }))).Table;
  const t = await describe();
  const existing = t?.GlobalSecondaryIndexes?.find((g) => g.IndexName === PENDING_INDEX);
  if (!existing) {
    await raw.send(
      new UpdateTableCommand({
        TableName: TABLE,
        AttributeDefinitions: [
          { AttributeName: "PK", AttributeType: "S" },
          { AttributeName: "SK", AttributeType: "S" },
          { AttributeName: "pendingShard", AttributeType: "S" },
          { AttributeName: "pendingAt", AttributeType: "N" },
        ],
        GlobalSecondaryIndexUpdates: [
          {
            Create: {
              IndexName: PENDING_INDEX,
              KeySchema: [
                { AttributeName: "pendingShard", KeyType: "HASH" },
                { AttributeName: "pendingAt", KeyType: "RANGE" },
              ],
              Projection: { ProjectionType: "ALL" },
            },
          },
        ],
      }),
    );
  }
  for (let i = 0; i < 120; i++) {
    const g = (await describe())?.GlobalSecondaryIndexes?.find((x) => x.IndexName === PENDING_INDEX);
    if (g?.IndexStatus === "ACTIVE") return;
    await new Promise((r) => setTimeout(r, 2500));
  }
  throw new Error(`${PENDING_INDEX} did not become ACTIVE`);
}

/** Spike-only: everything for one tenant via a filtered scan. Real adapters never scan. */
export async function dumpTenant(tenant: string): Promise<Record<string, unknown>[]> {
  const items: Record<string, unknown>[] = [];
  let ExclusiveStartKey: Record<string, unknown> | undefined;
  do {
    const page = await doc.send(
      new ScanCommand({
        TableName: TABLE,
        ConsistentRead: true,
        FilterExpression: "begins_with(PK, :p)",
        ExpressionAttributeValues: { ":p": `T#${tenant}#` },
        ...(ExclusiveStartKey ? { ExclusiveStartKey } : {}),
      }),
    );
    items.push(...((page.Items ?? []) as Record<string, unknown>[]));
    ExclusiveStartKey = page.LastEvaluatedKey as Record<string, unknown> | undefined;
  } while (ExclusiveStartKey);
  return items.sort((a, b) => `${a["PK"]}${a["SK"]}`.localeCompare(`${b["PK"]}${b["SK"]}`));
}
