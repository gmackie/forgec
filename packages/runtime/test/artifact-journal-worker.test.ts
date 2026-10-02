import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vitest";
import worker from "../../../conformance/artifacts/journal-worker.js";
it("authenticates journal operations and preserves one claim and an immutable terminal receipt", async () => {
  const db = new DatabaseSync(":memory:");
  const env = {
    QUALIFICATION_SECRET: "test-secret",
    DB: {
      prepare(sql: string) {
        let params: unknown[] = [];
        return {
          bind(...values: unknown[]) {
            params = values;
            return this;
          },
          async first<T>() {
            return (db.prepare(sql).get(...(params as any[])) ??
              null) as T | null;
          },
          async all<T>() {
            return {
              results: db.prepare(sql).all(...(params as any[])) as T[],
            };
          },
          async run() {
            return {
              meta: {
                changes: Number(
                  db.prepare(sql).run(...(params as any[])).changes,
                ),
              },
            };
          },
        };
      },
      batch: async () => [],
    },
  };
  const call = async (body: unknown, token = "test-secret") =>
    worker.fetch(
      new Request("https://fixture.invalid", {
        method: "POST",
        headers: { authorization: "Bearer " + token },
        body: JSON.stringify(body),
      }),
      env,
    );
  const intent = {
    key: "one",
    ref: "refs/heads/main",
    expected: null,
    actor: "test",
    purpose: null,
    revision: {
      tenant: "test",
      artifact: "fixture",
      generation: "one",
      repositoryId: "repo",
      objectFormat: "sha1",
      oid: "a".repeat(40),
      tree: "b".repeat(40),
    },
  };
  try {
    expect((await call({ action: "initialize" }, "wrong")).status).toBe(401);
    expect((await call({ action: "initialize" })).status).toBe(200);
    const claims = await Promise.all([
      call({ action: "claim", intent }),
      call({ action: "claim", intent }),
    ]);
    const rows = (await Promise.all(claims.map((x) => x.json()))) as any[];
    expect(rows.filter((x) => x.value.owned)).toHaveLength(1);
    expect(
      (
        (await (
          await call({ action: "finish", intent, outcome: "accepted" })
        ).json()) as any
      ).value.outcome,
    ).toBe("accepted");
    expect(
      (
        (await (
          await call({ action: "finish", intent, outcome: "rejected" })
        ).json()) as any
      ).value.outcome,
    ).toBe("accepted");
    expect(
      ((await (await call({ action: "get", intent })).json()) as any).value
        .outcome,
    ).toBe("accepted");
  } finally {
    db.close();
  }
});
