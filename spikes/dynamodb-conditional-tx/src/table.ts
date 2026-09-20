import {
  CreateTableCommand,
  DescribeTableCommand,
  DynamoDBClient,
  ResourceNotFoundException,
  waitUntilTableExists,
} from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, ScanCommand } from "@aws-sdk/lib-dynamodb";

export const TABLE = process.env["SPIKE_TABLE"] ?? "forge-spike-tx";
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
