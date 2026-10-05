import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import {
  ArtifactPublisher,
  type ArtifactPublicationProvider,
} from "../src/artifact-publication.js";
import { SqlArtifactPublicationJournal } from "../src/adapters/artifact-publication-sql.js";
import type { SqlExecutor } from "../src/adapters/sql-executor.js";

const oid = (n: number) => n.toString(16).padStart(40, "0");
const ctx = { tenant: "tenant", actor: "alice", requestId: "request" };
const pin = {
  tenant: "tenant",
  artifact: "source",
  generation: "one",
  repositoryId: "repo",
  objectFormat: "sha1" as const,
  oid: oid(2),
  tree: oid(3),
};
const request = () => ({
  key: "operation",
  ref: "refs/heads/main",
  expected: oid(1),
  revision: { ...pin },
});
function executor(db: DatabaseSync): SqlExecutor {
  return {
    facade: "test-sqlite",
    first: async (s) =>
      (db.prepare(s.sql).get(...(s.params as any[])) ?? null) as any,
    all: async (s) => db.prepare(s.sql).all(...(s.params as any[])) as any,
    run: async (s) => ({
      changes: Number(db.prepare(s.sql).run(...(s.params as any[])).changes),
    }),
    batch: async () => {
      throw new Error("unused");
    },
  };
}
async function fixture(path = ":memory:") {
  const db = new DatabaseSync(path),
    journal = new SqlArtifactPublicationJournal(executor(db));
  await journal.initialize();
  let head: string | null = oid(1),
    writes = 0,
    allowed = true,
    fail: "none" | "before" | "after" = "none",
    repoId = "repo";
  const provider: ArtifactPublicationProvider = {
    open: async () => ({
      repositoryId: repoId,
      objectFormat: "sha1",
      commit: async (id) => ({ oid: id, tree: pin.tree, parents: [] }),
      head: async () => head,
      compareAndSwap: async (_ref, old, next) => {
        writes++;
        if (fail === "before") throw Error("secret");
        if (head !== old) return "rejected";
        head = next;
        if (fail === "after") throw Error("secret");
        return "accepted";
      },
      dispose: () => {},
    }),
  };
  const publisher = () =>
    new ArtifactPublisher(
      [
        {
          tenant: "tenant",
          artifact: "source",
          generation: "one",
          repositoryId: "repo",
          provider,
        },
      ],
      journal,
      async () => allowed,
    );
  return {
    db,
    journal,
    publisher,
    provider,
    get writes() {
      return writes;
    },
    setHead: (x: string | null) => (head = x),
    setAllowed: (x: boolean) => (allowed = x),
    setFailure: (x: typeof fail) => (fail = x),
    setRepo: (x: string) => (repoId = x),
  };
}
it("persists confirmed receipts across process-style reopen without republishing", async () => {
  const dir = await mkdtemp(join(tmpdir(), "forge-publication-"));
  try {
    const path = join(dir, "journal.sqlite"),
      f = await fixture(path);
    expect((await f.publisher().publish(request(), ctx)).outcome).toBe(
      "accepted",
    );
    f.db.close();
    const g = await fixture(path);
    expect((await g.publisher().publish(request(), ctx)).outcome).toBe(
      "accepted",
    );
    expect(g.writes).toBe(0);
    g.db.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
it("admits only one dispatch for concurrent retries of one key", async () => {
  const f = await fixture();
  try {
    const receipts = await Promise.all(
      Array.from({ length: 8 }, () => f.publisher().publish(request(), ctx)),
    );
    expect(f.writes).toBe(1);
    expect(
      receipts.every((r) => ["pending", "accepted"].includes(r.outcome)),
    ).toBe(true);
  } finally {
    f.db.close();
  }
});
it("rejects stale expected head and records rejection", async () => {
  const f = await fixture();
  try {
    f.setHead(oid(9));
    expect((await f.publisher().publish(request(), ctx)).outcome).toBe(
      "rejected",
    );
    expect((await f.publisher().publish(request(), ctx)).outcome).toBe(
      "rejected",
    );
    expect(f.writes).toBe(1);
  } finally {
    f.db.close();
  }
});
it("recovers a lost acknowledgement as observed, never attributed success or a second write", async () => {
  const f = await fixture();
  try {
    f.setFailure("after");
    expect((await f.publisher().publish(request(), ctx)).outcome).toBe(
      "pending",
    );
    expect((await f.publisher().recover(request(), ctx)).outcome).toBe(
      "observed",
    );
    expect(f.writes).toBe(1);
    f.setHead(oid(8));
    expect((await f.publisher().publish(request(), ctx)).outcome).toBe(
      "observed",
    );
  } finally {
    f.db.close();
  }
});
it("leaves an uncertain nonmatching head pending and never resends", async () => {
  const f = await fixture();
  try {
    f.setFailure("before");
    await f.publisher().publish(request(), ctx);
    f.setFailure("none");
    expect((await f.publisher().recover(request(), ctx)).outcome).toBe(
      "pending",
    );
    await f.publisher().publish(request(), ctx);
    expect(f.writes).toBe(1);
  } finally {
    f.db.close();
  }
});
it("rejects changed intent, actor, or purpose for an existing key", async () => {
  const f = await fixture();
  try {
    await f.publisher().publish(request(), ctx);
    for (const [req, context] of [
      [{ ...request(), expected: null }, ctx],
      [request(), { ...ctx, actor: "bob" }],
      [request(), { ...ctx, purpose: "other" }],
    ] as const)
      await expect(f.publisher().publish(req, context)).rejects.toMatchObject({
        code: "IdempotencyMismatch",
      });
  } finally {
    f.db.close();
  }
});
it("reauthorizes receipts and rejects cross-tenant or replaced bindings", async () => {
  const f = await fixture();
  try {
    await f.publisher().publish(request(), ctx);
    f.setAllowed(false);
    await expect(f.publisher().publish(request(), ctx)).rejects.toMatchObject({
      code: "NotPermitted",
    });
    f.setAllowed(true);
    await expect(
      f.publisher().publish(request(), { ...ctx, tenant: "other" }),
    ).rejects.toMatchObject({ code: "NotPermitted" });
    f.setRepo("replacement");
    await expect(f.publisher().recover(request(), ctx)).rejects.toMatchObject({
      code: "VersionConflict",
    });
    expect(f.writes).toBe(1);
  } finally {
    f.db.close();
  }
});
it("requires a real precondition, valid branch ref and matching pinned tree before dispatch", async () => {
  const f = await fixture();
  try {
    for (const req of [
      { ...request(), expected: undefined },
      { ...request(), ref: "main" },
      { ...request(), ref: "refs/heads/a..b" },
      { ...request(), revision: { ...pin, tree: oid(5) } },
    ])
      await expect(
        f.publisher().publish(req as any, ctx),
      ).rejects.toMatchObject({ code: "ValidationFailed" });
    expect(f.writes).toBe(0);
  } finally {
    f.db.close();
  }
});
it("records intent before dispatch and fails closed if journal is unavailable", async () => {
  const f = await fixture();
  f.db.close();
  await expect(f.publisher().publish(request(), ctx)).rejects.toMatchObject({
    code: "StorageUnavailable",
  });
  expect(f.writes).toBe(0);
});
it("recovery of an unrecorded key does not claim or dispatch it", async () => {
  const f = await fixture();
  try {
    await expect(f.publisher().recover(request(), ctx)).rejects.toMatchObject({
      code: "NotFound",
    });
    expect(f.writes).toBe(0);
  } finally {
    f.db.close();
  }
});
it("recovers after a successful push whose terminal journal write failed", async () => {
  const f = await fixture();
  try {
    const finish = f.journal.finish.bind(f.journal);
    f.journal.finish = async () => {
      throw Error("secret storage details");
    };
    await expect(f.publisher().publish(request(), ctx)).rejects.toMatchObject({
      code: "StorageUnavailable",
    });
    f.journal.finish = finish;
    expect((await f.publisher().recover(request(), ctx)).outcome).toBe(
      "observed",
    );
    expect(f.writes).toBe(1);
  } finally {
    f.db.close();
  }
});
it("snapshots the request across authorization and rejects generation changes", async () => {
  const f = await fixture();
  try {
    const req = request();
    const publisher = new ArtifactPublisher(
      [
        {
          tenant: "tenant",
          artifact: "source",
          generation: "one",
          repositoryId: "repo",
          provider: f.provider,
        },
      ],
      f.journal,
      async (auth) => {
        expect(Object.isFrozen(auth.revision)).toBe(true);
        req.ref = "refs/heads/other";
        req.revision.oid = oid(9);
        return true;
      },
    );
    const receipt = await publisher.publish(req, ctx);
    expect(receipt.intent.ref).toBe("refs/heads/main");
    expect(receipt.intent.revision.oid).toBe(pin.oid);
    await expect(
      f
        .publisher()
        .publish(
          { ...request(), revision: { ...pin, generation: "two" } },
          ctx,
        ),
    ).rejects.toMatchObject({ code: "VersionConflict" });
  } finally {
    f.db.close();
  }
});
it("permits expected-absent publication and keeps distinct requests subject to CAS", async () => {
  const f = await fixture();
  try {
    f.setHead(null);
    expect(
      (await f.publisher().publish({ ...request(), expected: null }, ctx))
        .outcome,
    ).toBe("accepted");
    expect(
      (
        await f
          .publisher()
          .publish({ ...request(), key: "second", expected: null }, ctx)
      ).outcome,
    ).toBe("rejected");
    expect(f.writes).toBe(2);
  } finally {
    f.db.close();
  }
});
it("claims a key once across independent SQL connections", async () => {
  const dir = await mkdtemp(join(tmpdir(), "forge-claims-"));
  try {
    const path = join(dir, "journal.sqlite"),
      f = await fixture(path),
      g = await fixture(path);
    try {
      await Promise.all([
        f.publisher().publish(request(), ctx),
        g.publisher().publish(request(), ctx),
      ]);
      expect(f.writes + g.writes).toBe(1);
    } finally {
      f.db.close();
      g.db.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
it("never dispatches an intent claimed before a process interruption", async () => {
  const f = await fixture();
  try {
    await f.journal.claim({ ...request(), actor: ctx.actor, purpose: null });
    expect((await f.publisher().publish(request(), ctx)).outcome).toBe(
      "pending",
    );
    expect((await f.publisher().recover(request(), ctx)).outcome).toBe(
      "pending",
    );
    expect(f.writes).toBe(0);
  } finally {
    f.db.close();
  }
});

it("applies the reviewed migration repeatedly without losing receipts", async () => {
  const f = await fixture();
  try {
    await f.publisher().publish(request(), ctx);
    const migration = readFileSync(
      new URL(
        "../../../examples/acme/migrations/d1/0006_artifact_publications.sql",
        import.meta.url,
      ),
      "utf8",
    );
    f.db.exec(migration);
    f.db.exec(migration);
    expect((await f.publisher().publish(request(), ctx)).outcome).toBe(
      "accepted",
    );
    expect(f.writes).toBe(1);
  } finally {
    f.db.close();
  }
});
