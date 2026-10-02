/** libSQL/Turso facade. The caller owns endpoint, credentials and client lifetime. */
import type { SqlExecutor, SqlStatement } from "./sql-executor.js";
import { err } from "../errors.js";
type Value = null | string | number | bigint | Uint8Array | ArrayBuffer;
export interface LibsqlResult {
  rows: readonly unknown[];
  rowsAffected: number;
}
export interface LibsqlClient {
  execute(statement: { sql: string; args: Value[] }): Promise<LibsqlResult>;
  /** libSQL's write batch is one transaction, rolling back on any failure. */
  batch(
    statements: { sql: string; args: Value[] }[],
    mode: "write",
  ): Promise<LibsqlResult[]>;
}
function statement(s: SqlStatement) {
  const args = s.params.map((value) => {
    if (
      value === null ||
      typeof value === "string" ||
      typeof value === "bigint" ||
      (typeof value === "number" && Number.isFinite(value)) ||
      value instanceof Uint8Array ||
      value instanceof ArrayBuffer
    )
      return value as Value;
    throw err("ValidationFailed", "Unsupported libSQL parameter");
  });
  return { sql: s.sql, args };
}
function changes(result: LibsqlResult) {
  if (!Number.isSafeInteger(result.rowsAffected) || result.rowsAffected < 0)
    throw err("StorageUnavailable", "Invalid libSQL affected-row result");
  return { changes: result.rowsAffected };
}
export function libsqlExecutor(client: LibsqlClient): SqlExecutor {
  return {
    facade: "libsql",
    first: async <T>(s: SqlStatement) => {
      const result = await client.execute(statement(s));
      return (result.rows[0] ?? null) as T | null;
    },
    all: async <T>(s: SqlStatement) =>
      (await client.execute(statement(s))).rows as T[],
    run: async (s) => changes(await client.execute(statement(s))),
    batch: async (statements) => {
      if (!statements.length) return [];
      const result = await client.batch(statements.map(statement), "write");
      if (result.length !== statements.length)
        throw err("StorageUnavailable", "Incomplete libSQL batch result");
      return result.map(changes);
    },
  };
}
