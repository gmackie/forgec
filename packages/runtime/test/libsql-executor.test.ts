import { createClient } from "@libsql/client";
import { expect, it } from "vitest";
import { libsqlExecutor } from "../src/adapters/libsql-executor.js";
import { SqlArtifactPublicationJournal } from "../src/adapters/artifact-publication-sql.js";
it("uses real libSQL for null/blob reads, affected rows and atomic rollback", async () => {
  const client = createClient({ url: "file::memory:" });
  try {
    const sql = libsqlExecutor(client);
    await sql.run({
      sql: "CREATE TABLE facts(id INTEGER PRIMARY KEY, value BLOB)",
      params: [],
    });
    expect(
      await sql.run({
        sql: "INSERT INTO facts VALUES (?,?)",
        params: [1, new Uint8Array([0, 128, 255])],
      }),
    ).toEqual({ changes: 1 });
    const row = await sql.first<{ id: number; value: ArrayBuffer }>({
      sql: "SELECT * FROM facts WHERE id=?",
      params: [1],
    });
    expect(row?.id).toBe(1);
    expect(new Uint8Array(row!.value)).toEqual(new Uint8Array([0, 128, 255]));
    await expect(
      sql.batch([
        { sql: "INSERT INTO facts VALUES (?,?)", params: [2, null] },
        { sql: "INSERT INTO facts VALUES (?,?)", params: [1, null] },
      ]),
    ).rejects.toThrow();
    expect(
      await sql.first({ sql: "SELECT * FROM facts WHERE id=2", params: [] }),
    ).toBeNull();
    expect(
      await sql.batch([
        { sql: "INSERT INTO facts VALUES (?,?)", params: [2, null] },
        { sql: "UPDATE facts SET value=? WHERE id=?", params: [null, 1] },
      ]),
    ).toEqual([{ changes: 1 }, { changes: 1 }]);
    expect(
      await sql.all({
        sql: "SELECT id,value FROM facts ORDER BY id",
        params: [],
      }),
    ).toEqual([
      { id: 1, value: null },
      { id: 2, value: null },
    ]);
    await expect(
      sql.run({ sql: "SELECT ?", params: [{ untrusted: "object" }] }),
    ).rejects.toMatchObject({ code: "ValidationFailed" });
  } finally {
    client.close();
  }
});
it("persists an immutable journal terminal outcome through the libSQL executor", async () => {
  const client = createClient({ url: "file::memory:" });
  try {
    const journal = new SqlArtifactPublicationJournal(libsqlExecutor(client));
    await journal.initialize();
    const intent = {
      key: "k",
      ref: "refs/heads/main",
      expected: null,
      actor: "user",
      purpose: null,
      revision: {
        tenant: "tenant",
        artifact: "a",
        generation: "one",
        repositoryId: "repo",
        objectFormat: "sha1" as const,
        oid: "a".repeat(40),
        tree: "b".repeat(40),
      },
    };
    const claims = await Promise.all([
      journal.claim(intent),
      journal.claim(intent),
    ]);
    expect(claims.filter((x) => x.owned)).toHaveLength(1);
    await journal.finish(intent, "accepted");
    expect((await journal.finish(intent, "rejected")).outcome).toBe("accepted");
  } finally {
    client.close();
  }
});

it('Foundation fixture actually uses libSQL rather than the SQLite fallback', async () => {
 const {foundation}=await import('./helpers/foundation.js');
 const {Storage}=await import('../src/services.js');
 const {Effect}=await import('effect');
 const f=await foundation('allocation','libsql',true);
 try {
  const storage=await Effect.runPromise(Storage.pipe(Effect.provide(f.engine.layer)));
  expect(storage.name).toBe('d1/libsql');
 } finally {await f.close();}
});
