import { ensureTable, TABLE, REGION } from "../src/table.js";

export default async function setup(): Promise<void> {
  await ensureTable();
  console.log(`[spike] DynamoDB table ${TABLE} ready in ${REGION}`);
}
