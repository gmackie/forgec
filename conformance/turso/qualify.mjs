/** Disposable qualification only; credentials arrive on stdin. */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { libsqlExecutor } from "../../packages/runtime/dist/adapters/libsql-executor.js";
import { SqlArtifactPublicationJournal } from "../../packages/runtime/dist/adapters/artifact-publication-sql.js";
import { D1Storage } from "../../packages/runtime/dist/adapters/d1.js";
import { Engine } from "../../packages/runtime/dist/engine.js";
import { Model } from "../../packages/runtime/dist/model.js";
import { testLayer } from "../../packages/runtime/dist/testing.js";
const require = createRequire(
  new URL("../../packages/runtime/package.json", import.meta.url),
);
const { createClient } = await import(require.resolve("@libsql/client"));
const { Effect } = await import(require.resolve("effect"));
const config = JSON.parse(readFileSync(0, "utf8"));
const client = createClient({ url: config.url, authToken: config.token });
const tests = [];
const record = (name) => tests.push({ name, status: "passed" });
try {
  const sql = libsqlExecutor(client);
  await sql.run({
    sql: "CREATE TABLE qualification_values(id INTEGER PRIMARY KEY,value BLOB)",
    params: [],
  });
  await sql.run({
    sql: "INSERT INTO qualification_values VALUES(?,?)",
    params: [1, new Uint8Array([0, 128, 255])],
  });
  const row = await sql.first({
    sql: "SELECT value FROM qualification_values WHERE id=1",
    params: [],
  });
  assert.deepEqual(new Uint8Array(row.value), new Uint8Array([0, 128, 255]));
  await assert.rejects(
    sql.batch([
      {
        sql: "INSERT INTO qualification_values VALUES(?,?)",
        params: [2, null],
      },
      {
        sql: "INSERT INTO qualification_values VALUES(?,?)",
        params: [1, null],
      },
    ]),
  );
  assert.equal(
    await sql.first({
      sql: "SELECT * FROM qualification_values WHERE id=2",
      params: [],
    }),
    null,
  );
  record("Remote binary round trip and atomic rollback of earlier statement");
  const journal = new SqlArtifactPublicationJournal(sql);
  await journal.initialize();
  const intent = {
    key: "operation",
    ref: "refs/heads/main",
    expected: null,
    actor: "operator",
    purpose: null,
    revision: {
      tenant: "qualification",
      artifact: "source",
      generation: "one",
      repositoryId: "fixture",
      objectFormat: "sha1",
      oid: "a".repeat(40),
      tree: "b".repeat(40),
    },
  };
  const claims = await Promise.all(
    Array.from({ length: 8 }, () => journal.claim(intent)),
  );
  assert.equal(claims.filter((c) => c.owned).length, 1);
  await journal.finish(intent, "accepted");
  assert.equal((await journal.finish(intent, "rejected")).outcome, "accepted");
  const reopened = createClient({ url: config.url, authToken: config.token });
  try {
    assert.equal(
      (
        await new SqlArtifactPublicationJournal(libsqlExecutor(reopened)).get(
          intent,
        )
      ).outcome,
      "accepted",
    );
  } finally {
    reopened.close();
  }
  record(
    "Concurrent remote journal claims admit one owner and preserve terminal receipts across clients",
  );
  const fixture = new URL("../fixtures/allocation-consumer/", import.meta.url);
  await client.executeMultiple(
    readFileSync(new URL("d1/0001_init.sql", fixture), "utf8"),
  );
  const model = new Model(
    JSON.parse(readFileSync(new URL("app.json", fixture), "utf8")),
  );
  const engine = new Engine(model, testLayer(new D1Storage(sql, model)));
  const ctx = {
      tenant: "qualification",
      actor: "operator",
      requestId: "qualification",
    },
    p = "@forgegraph/foundation/allocation/_/";
  const mutation = (key) => ({
    operation: p + "AllocationPool.create",
    input: { key, mode: "exclusive", capacity: "1", unit: "slot" },
  });
  const guard = (key) => ({
    absent: [
      { resource: p + "AllocationPool", unique: "key", values: { key } },
    ],
  });
  const results = await Promise.allSettled([
    Effect.runPromise(engine.atomic([mutation("left")], ctx, guard("right"))),
    Effect.runPromise(engine.atomic([mutation("right")], ctx, guard("left"))),
  ]);
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  const rows = await Effect.runPromise(
    engine.call(p + "AllocationPool.list.all", {}, ctx),
  );
  assert.equal(rows.items.length, 1);
  await Effect.runPromise(
    engine.atomic(
      [mutation("left")],
      { ...ctx, tenant: "other" },
      guard("right"),
    ),
  );
  record("Remote atomic absence guards select one winner and isolate tenants");
  await assert.rejects(
    Effect.runPromise(
      engine.call(
        p + "AllocationReservation.create",
        {
          pool: "missing",
          key: "invalid-ref",
          quantity: "1",
          unit: "slot",
          from: "2026-10-03T00:00:00Z",
          until: "2026-10-04T00:00:00Z",
          holdUntil: "2026-10-02T23:00:00Z",
        },
        ctx,
      ),
    ),
  );
  assert.equal(
    (
      await Effect.runPromise(
        engine.call(p + "AllocationReservation.list.all", {}, ctx),
      )
    ).items.length,
    0,
  );
  record("Remote missing reference is rejected without a partial reservation");
  process.stdout.write(
    JSON.stringify({
      status: "passed",
      tests,
      scope:
        "Hosted Turso using libSQL executor, publication journal and Foundation D1 SQL planner; no replica/failover certification",
    }),
  );
} catch (error) {
  process.stdout.write(
    JSON.stringify({
      status: "failed",
      tests,
      errorCode:
        typeof error?.code === "string" && /^[A-Za-z_]+$/.test(error.code)
          ? error.code
          : "QualificationFailed",
    }),
  );
  process.exitCode = 1;
} finally {
  client.close();
}
