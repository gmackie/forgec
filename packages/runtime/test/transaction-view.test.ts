import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Effect } from "effect";
import { expect, it } from "vitest";
import { Engine } from "../src/engine.js";
import { MemoryStorage } from "../src/adapters/memory.js";
import { Model, type AppBundle } from "../src/model.js";
import { testLayer } from "../src/testing.js";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { createClient } from "@libsql/client";
import { D1Storage } from "../src/adapters/d1.js";
import { libsqlExecutor } from "../src/adapters/libsql-executor.js";
import type {
  SqlExecutor,
  SqlStatement,
} from "../src/adapters/sql-executor.js";
import { Storage, type StorageAdapter } from "../src/services.js";
import { localAuthorizer } from "../src/gatekeeper.js";
import { afterEach } from "vitest";

const model = new Model(
  JSON.parse(
    readFileSync(
      resolve(
        import.meta.dirname,
        "../../../conformance/fixtures/acme.app.json",
      ),
      "utf8",
    ),
  ) as AppBundle,
);
const p = "@acme/commerce/_/",
  ctx = { tenant: "transaction", actor: "operator", requestId: "test" };
const run = Effect.runPromise;
const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const close of cleanup.splice(0)) close();
});
async function fixture(adapter = "memory", testModel = model) {
  let storage: StorageAdapter = new MemoryStorage();
  let audit = async () =>
    (await (storage as MemoryStorage).dump(ctx.tenant)).audit!;
  if (adapter !== "memory") {
    const schema = readFileSync(
      resolve(
        import.meta.dirname,
        "../../../conformance/fixtures/acme.0001_init.sql",
      ),
      "utf8",
    );
    let sql: SqlExecutor;
    if (adapter === "libsql") {
      const db = createClient({ url: "file::memory:" });
      cleanup.push(() => db.close());
      await db.executeMultiple(schema);
      sql = libsqlExecutor(db);
    } else {
      const db = new DatabaseSync(":memory:");
      cleanup.push(() => db.close());
      db.exec(schema);
      const write = (s: SqlStatement) => ({
        changes: Number(
          db.prepare(s.sql).run(...(s.params as SQLInputValue[])).changes,
        ),
      });
      sql = {
        facade: "sqlite-test",
        first: async <T>(s: SqlStatement) =>
          (db.prepare(s.sql).get(...(s.params as SQLInputValue[])) ??
            null) as T | null,
        all: async <T>(s: SqlStatement) =>
          db.prepare(s.sql).all(...(s.params as SQLInputValue[])) as T[],
        run: async (s) => write(s),
        batch: async (statements) => {
          db.exec("BEGIN");
          try {
            const result = statements.map(write);
            db.exec("COMMIT");
            return result;
          } catch (error) {
            db.exec("ROLLBACK");
            throw error;
          }
        },
      };
    }
    storage = new D1Storage(sql, testModel);
    audit = () =>
      sql.all<Record<string, unknown>>({
        sql: "SELECT * FROM forge_audit WHERE tenant = ?",
        params: [ctx.tenant],
      });
  }
  const engine = new Engine(testModel, testLayer(storage));
  return {
    storage,
    audit,
    engine,
    call: (op: string, input: Record<string, unknown>) =>
      run(engine.call(p + op, input, ctx)),
  };
}

for (const adapter of ["memory", "sqlite", "libsql"]) {
  it(`${adapter}: creates a staged parent and referenced child, with staged point reads`, async () => {
    const { engine, call } = await fixture(adapter);
    const result = await run(
      engine.transaction(
        (tx) =>
          Effect.gen(function* () {
            const parent = yield* tx.call(p + "Customer.create", {
              code: "PARENT",
              name: "parent",
            });
            expect(
              yield* tx.call(p + "Customer.get", { id: parent.id }),
            ).toMatchObject(parent);
            const child = yield* tx.call(p + "Site.create", {
              customer: parent.id,
              code: "HQ",
              name: "HQ",
              timezone: "UTC",
            });
            return { parent, child };
          }),
        ctx,
      ),
    );
    expect(
      await call("Site.get", {
        id: (result.child as Record<string, unknown>).id,
      }),
    ).toMatchObject({
      customer: (result.parent as Record<string, unknown>).id,
    });
  });

  it(`${adapter}: consolidates sequential updates and preserves both logical audits`, async () => {
    const { engine, storage, audit, call } = await fixture(adapter);
    const commit = storage.commitAll.bind(storage);
    let physicalWrites = 0;
    storage.commitAll = (plans, absent) => {
      physicalWrites = plans.filter((plan) => plan.kind !== "publish").length;
      return commit(plans, absent);
    };
    const record = await call("Customer.create", {
      code: "GUARD",
      name: "before",
    });
    const result = await run(
      engine.transaction(
        (tx) =>
          Effect.gen(function* () {
            yield* tx.call(p + "Customer.update", {
              id: record.id,
              expectedVersion: 1,
              patch: { name: "first" },
            });
            expect(
              yield* tx.call(p + "Customer.get", { id: record.id }),
            ).toMatchObject({ version: 2, name: "first" });
            return yield* tx.call(p + "Customer.update", {
              id: record.id,
              expectedVersion: 2,
              patch: { name: "last" },
            });
          }),
        ctx,
      ),
    );
    expect(result).toMatchObject({ version: 3, name: "last" });
    expect(await call("Customer.get", { id: record.id })).toMatchObject(result);
    expect((await audit()).filter((a) => a.kind === "update")).toHaveLength(2);
    expect(physicalWrites).toBe(1);
  });

  it(`${adapter}: retains the original durable guard and rolls back the entire group on conflict`, async () => {
    const { engine, storage, call } = await fixture(adapter);
    const record = await call("Customer.create", {
      code: "RACE",
      name: "before",
    });
    const commit = storage.commitAll.bind(storage);
    let injected = false;
    storage.commitAll = (plans, absent) =>
      Effect.gen(function* () {
        if (!injected) {
          injected = true;
          yield* engine.call(
            p + "Customer.update",
            {
              id: record.id,
              expectedVersion: 1,
              patch: { name: "competitor" },
            },
            ctx,
          );
        }
        yield* commit(plans, absent);
      });
    await expect(
      run(
        engine.transaction(
          (tx) =>
            Effect.gen(function* () {
              yield* tx.call(p + "Customer.create", {
                code: "ROLLBACK",
                name: "rollback",
              });
              yield* tx.call(p + "Customer.update", {
                id: record.id,
                expectedVersion: 1,
                patch: { name: "first" },
              });
              return yield* tx.call(p + "Customer.update", {
                id: record.id,
                expectedVersion: 2,
                patch: { name: "last" },
              });
            }),
          ctx,
        ),
      ),
    ).rejects.toMatchObject({ code: "VersionConflict" });
    expect(await call("Customer.get", { id: record.id })).toMatchObject({
      version: 2,
      name: "competitor",
    });
    expect(
      await call("Customer.create", { code: "ROLLBACK", name: "reused" }),
    ).toMatchObject({ name: "reused" });
  });

  it(`${adapter}: a late unique conflict removes the parent, child, audits and outbox`, async () => {
    const { engine, call, audit, storage } = await fixture(adapter);
    await call("Customer.create", { code: "TAKEN", name: "existing" });
    const before = await audit();
    const beforeOutbox = await run(
      storage.outboxSweep(ctx.tenant, Date.now(), 100),
    );
    await expect(
      run(
        engine.transaction(
          (tx) =>
            Effect.gen(function* () {
              const parent = yield* tx.call(p + "Customer.create", {
                code: "NEW",
                name: "new",
              });
              yield* tx.call(p + "Site.create", {
                customer: parent.id,
                code: "HQ",
                name: "HQ",
                timezone: "UTC",
              });
              return yield* tx.call(p + "Customer.create", {
                code: "TAKEN",
                name: "conflict",
              });
            }),
          ctx,
        ),
      ),
    ).rejects.toMatchObject({ code: "UniqueConflict" });
    expect(await audit()).toEqual(before);
    expect(await run(storage.outboxSweep(ctx.tenant, Date.now(), 100))).toEqual(
      beforeOutbox,
    );
    expect(
      await call("Customer.create", { code: "NEW", name: "reused" }),
    ).toMatchObject({ name: "reused" });
  });
}

it("fails closed for unsupported adapters, stale staged versions, queries and escaped handles", async () => {
  const { engine, storage, call } = await fixture();
  const record = await call("Customer.create", {
    code: "LIMIT",
    name: "before",
  });
  let escaped: import("../src/transaction.js").TransactionContext | undefined;
  await run(
    engine.transaction((tx) => {
      escaped = tx;
      return Effect.void;
    }, ctx),
  );
  await expect(
    run(escaped!.call(p + "Customer.get", { id: record.id })),
  ).rejects.toMatchObject({ code: "ValidationFailed" });
  await expect(
    run(
      engine.transaction(
        (tx) =>
          Effect.gen(function* () {
            yield* tx.call(p + "Customer.update", {
              id: record.id,
              expectedVersion: 1,
              patch: { name: "staged" },
            });
            return yield* tx.call(p + "Customer.update", {
              id: record.id,
              expectedVersion: 1,
              patch: { name: "stale" },
            });
          }),
        ctx,
      ),
    ),
  ).rejects.toMatchObject({ code: "VersionConflict" });
  expect(
    await run(
      engine.transaction(
        (tx) =>
          Effect.gen(function* () {
            yield* tx.call(p + "Customer.update", {
              id: record.id,
              expectedVersion: 1,
              patch: { name: "staged" },
            });
            return yield* tx.call(p + "Customer.find.byCode", {
              params: { code: "LIMIT" },
            });
          }),
        ctx,
      ),
    ),
  ).toMatchObject({ name: "staged", version: 2 });
  expect(await call("Customer.get", { id: record.id })).toMatchObject({
    version: 2,
    name: "staged",
  });
  Object.defineProperty(storage, "atomicComposition", { value: false });
  await expect(
    run(engine.transaction(() => Effect.void, ctx)),
  ).rejects.toMatchObject({ code: "ValidationFailed" });
});

it("checks authorization on staged reads and mutations, and checks physical budget before commit", async () => {
  const { engine, storage, call } = await fixture();
  const record = await call("Customer.create", {
    code: "AUTH",
    name: "before",
  });
  engine.gatekeeper.authorizer = localAuthorizer({
    policies: [],
    pips: [],
    epoch: 1,
    knownObligations: [],
  });
  await expect(
    run(
      engine.transaction(
        (tx) => tx.call(p + "Customer.get", { id: record.id }),
        ctx,
      ),
    ),
  ).rejects.toMatchObject({ code: "NotFound" });
  await expect(
    run(
      engine.transaction(
        (tx) =>
          tx.call(p + "Customer.update", {
            id: record.id,
            expectedVersion: 1,
            patch: { name: "denied" },
          }),
        ctx,
      ),
    ),
  ).rejects.toMatchObject({ code: "NotFound" });
  const fresh = new Engine(model, engine.layer);
  storage.budget = () => ({ actions: 101, limit: 100 });
  await expect(
    run(
      fresh.transaction(
        (tx) =>
          tx.call(p + "Customer.create", { code: "BUDGET", name: "rejected" }),
        ctx,
      ),
    ),
  ).rejects.toMatchObject({ code: "BudgetExceeded" });
  const underlying = await run(Storage.pipe(Effect.provide(fresh.layer)));
  expect(
    await run(
      underlying.get(ctx.tenant, model.resource(p + "Customer"), record.id),
    ),
  ).toMatchObject({ version: 1 });
});

it("rejects immutable unique-key changes and more than 32 mutations without writes", async () => {
  const { engine, call, audit } = await fixture();
  const record = await call("Customer.create", {
    code: "STABLE",
    name: "before",
  });
  const before = await audit();
  await expect(
    run(
      engine.transaction(
        (tx) =>
          Effect.gen(function* () {
            yield* tx.call(p + "Customer.update", {
              id: record.id,
              expectedVersion: 1,
              patch: { name: "staged" },
            });
            return yield* tx.call(p + "Customer.update", {
              id: record.id,
              expectedVersion: 2,
              patch: { code: "CHANGED" },
            });
          }),
        ctx,
      ),
    ),
  ).rejects.toMatchObject({ code: "UnknownField" });
  await expect(
    run(
      engine.transaction(
        (tx) =>
          Effect.gen(function* () {
            for (let n = 0; n < 33; n++)
              yield* tx.call(p + "Customer.create", {
                code: `LIMIT${n}`,
                name: "limit",
              });
          }),
        ctx,
      ),
    ),
  ).rejects.toMatchObject({ code: "BudgetExceeded" });
  expect(await audit()).toEqual(before);
  expect(await call("Customer.get", { id: record.id })).toMatchObject({
    code: "STABLE",
    name: "before",
    version: 1,
  });
});

it("folds a mutable unique key and releases the original claim", async () => {
  const bundle = JSON.parse(
    readFileSync(
      resolve(
        import.meta.dirname,
        "../../../conformance/fixtures/acme.app.json",
      ),
      "utf8",
    ),
  ) as AppBundle;
  const mutable = new Model(bundle);
  mutable
    .resource(p + "Customer")
    .fields.find((field) => field.name === "code")!.immutable = false;
  const storage = new MemoryStorage(),
    engine = new Engine(mutable, testLayer(storage));
  const record = await run(
    engine.call(p + "Customer.create", { code: "BEFORE", name: "before" }, ctx),
  );
  expect(
    await run(
      engine.transaction(
        (tx) =>
          Effect.gen(function* () {
            yield* tx.call(p + "Customer.update", {
              id: record.id,
              expectedVersion: 1,
              patch: { name: "staged" },
            });
            return yield* tx.call(p + "Customer.update", {
              id: record.id,
              expectedVersion: 2,
              patch: { code: "AFTER" },
            });
          }),
        ctx,
      ),
    ),
  ).toMatchObject({ code: "AFTER", version: 3 });
  expect(
    await run(engine.call(p + "Customer.get", { id: record.id }, ctx)),
  ).toMatchObject({ code: "AFTER", name: "staged", version: 3 });
});

it("preserves purpose projection, suppression and write fencing for composed calls", async () => {
  const bundle = JSON.parse(
    readFileSync(
      resolve(
        import.meta.dirname,
        "../../../conformance/fixtures/acme-next.app.json",
      ),
      "utf8",
    ),
  ) as AppBundle;
  const storage = new MemoryStorage(),
    engine = new Engine(new Model(bundle), testLayer(storage));
  const n = "@acme/commerce-next/_/",
    g = "@acme/governance/_/",
    seed = { ...ctx, maintenance: true };
  const customer = await run(
    engine.call(n + "Customer.create", { code: "CUS", name: "Customer" }, seed),
  );
  const contact = await run(
    engine.call(
      n + "Contact.create",
      {
        customer: customer.id,
        name: "A",
        email: "a@example.com",
        supportNotes: "secret",
      },
      seed,
    ),
  );
  await expect(
    run(
      engine.transaction(
        (tx) =>
          tx.call(n + "Contact.update", {
            id: contact.id,
            expectedVersion: 1,
            patch: { supportNotes: "changed" },
          }),
        { ...ctx, purpose: g + "ParentCommunication" },
      ),
    ),
  ).rejects.toMatchObject({ code: "NotPermitted" });
  const updated = await run(
    engine.transaction(
      (tx) =>
        tx.call(n + "Contact.update", {
          id: contact.id,
          expectedVersion: 1,
          patch: { email: "b@example.com" },
        }),
      { ...ctx, purpose: g + "CustomerSupport" },
    ),
  );
  expect(Object.keys(updated).sort()).toEqual([
    "customer",
    "email",
    "id",
    "name",
    "supportNotes",
    "version",
  ]);
  await run(
    storage.putDocument(ctx.tenant, "admin", "fence", { on: true }, null),
  );
  await expect(
    run(
      engine.transaction(
        (tx) =>
          tx.call(n + "Contact.update", {
            id: contact.id,
            expectedVersion: 2,
            patch: { name: "fenced" },
          }),
        seed,
      ),
    ),
  ).rejects.toMatchObject({ code: "WriteFenced" });
  await run(
    storage.putDocument(ctx.tenant, "admin", "fence", { on: false }, 1),
  );
  const subject = engine.suppression.subjectOf(
    engine.model.resource(n + "Contact"),
    contact,
  )!;
  await run(
    engine.suppression
      .record(ctx.tenant, subject, {
        kind: "restricted",
        reason: "Privacy",
        at: "2026-01-01T00:00:00Z",
        epoch: 1,
      })
      .pipe(Effect.provide(engine.layer)),
  );
  await expect(
    run(
      engine.transaction(
        (tx) =>
          tx.call(n + "Contact.update", {
            id: contact.id,
            expectedVersion: 2,
            patch: { name: "suppressed" },
          }),
        seed,
      ),
    ),
  ).rejects.toMatchObject({ code: "Suppressed" });
});

for (const adapter of ["memory", "sqlite", "libsql"]) {
  it(`${adapter}: overlays filtering, ordering and pagination after staged changes`, async () => {
    const { engine, call } = await fixture(adapter);
    const a = await call("Customer.create", { code: "AAA", name: "A" });
    await call("Customer.create", { code: "CCC", name: "C" });
    const result = await run(
      engine.transaction(
        (tx) =>
          Effect.gen(function* () {
            yield* tx.call(p + "Customer.update", {
              id: a.id,
              expectedVersion: 1,
              patch: { name: "Z" },
            });
            yield* tx.call(p + "Customer.create", { code: "BBB", name: "B" });
            return yield* tx.call(p + "Customer.list.byTier", {
              params: { tier: "standard" },
              limit: 2,
            });
          }),
        ctx,
      ),
    );
    expect((result.items as { name: string }[]).map((r) => r.name)).toEqual([
      "B",
      "C",
    ]);
    expect(await call("Customer.get", { id: a.id })).toMatchObject({
      name: "Z",
    });
  });

  it(`${adapter}: an empty query is fenced against a concurrent insertion`, async () => {
    const { engine, storage, call } = await fixture(adapter);
    const commit = storage.commitAll.bind(storage);
    let injected = false;
    storage.commitAll = (plans, absent, reads) =>
      Effect.gen(function* () {
        if (reads?.length && !injected) {
          injected = true;
          yield* Effect.promise(() =>
            call("Customer.create", { code: "PHANTOM", name: "competing" }),
          );
        }
        return yield* commit(plans, absent, reads);
      });
    await expect(
      run(
        engine.transaction(
          (tx) =>
            Effect.gen(function* () {
              expect(
                (yield* tx.call(p + "Customer.list.all", { params: {} })).items,
              ).toEqual([]);
              yield* tx.call(p + "Customer.create", {
                code: "MUST-NOT-LEAK",
                name: "loser",
              });
            }),
          ctx,
        ),
      ),
    ).rejects.toMatchObject({ code: "VersionConflict" });
    await expect(
      call("Customer.find.byCode", { params: { code: "MUST-NOT-LEAK" } }),
    ).rejects.toMatchObject({ code: "NotFound" });
    expect(
      await call("Customer.find.byCode", { params: { code: "PHANTOM" } }),
    ).toMatchObject({ name: "competing" });
  });

  it(`${adapter}: a read-only transaction validates its snapshot without adding an audit`, async () => {
    const { engine, storage, audit, call } = await fixture(adapter);
    const record = await call("Customer.create", {
      code: "READ",
      name: "before",
    });
    const before = await audit();
    expect(
      await run(
        engine.transaction(
          (tx) => tx.call(p + "Customer.get", { id: record.id }),
          ctx,
        ),
      ),
    ).toMatchObject({ name: "before" });
    expect(await audit()).toEqual(before);
    const commit = storage.commitAll.bind(storage);
    let injected = false;
    storage.commitAll = (plans, absent, reads) =>
      Effect.gen(function* () {
        if (reads?.length && !injected) {
          injected = true;
          yield* Effect.promise(() =>
            call("Customer.update", {
              id: record.id,
              expectedVersion: 1,
              patch: { name: "concurrent" },
            }),
          );
        }
        return yield* commit(plans, absent, reads);
      });
    await expect(
      run(
        engine.transaction(
          (tx) => tx.call(p + "Customer.get", { id: record.id }),
          ctx,
        ),
      ),
    ).rejects.toMatchObject({ code: "VersionConflict" });
  });

  it(`${adapter}: lowers soft delete and restore while retaining every audit`, async () => {
    const { engine, audit, call } = await fixture(adapter);
    const record = await call("Customer.create", {
      code: "RESTORE",
      name: "before",
    });
    await run(
      engine.transaction(
        (tx) =>
          Effect.gen(function* () {
            yield* tx.call(p + "Customer.delete", {
              id: record.id,
              expectedVersion: 1,
            });
            yield* tx.call(p + "Customer.restore", {
              id: record.id,
              expectedVersion: 2,
            });
            yield* tx.call(p + "Customer.update", {
              id: record.id,
              expectedVersion: 3,
              patch: { name: "after" },
            });
          }),
        ctx,
      ),
    );
    expect(await call("Customer.get", { id: record.id })).toMatchObject({
      name: "after",
      deletedAt: null,
      version: 4,
    });
    expect(await audit()).toHaveLength(4);
  });

  it(`${adapter}: lowers staged create/update/hard-delete to audit-only work`, async () => {
    const { engine, audit, call } = await fixture(adapter);
    const parent = await call("Customer.create", {
      code: "PARENT-DELETE",
      name: "parent",
    });
    let id: unknown;
    await run(
      engine.transaction(
        (tx) =>
          Effect.gen(function* () {
            const child = yield* tx.call(p + "Site.create", {
              customer: parent.id,
              code: "GONE",
              name: "before",
              timezone: "UTC",
            });
            id = child.id;
            yield* tx.call(p + "Site.update", {
              id,
              expectedVersion: 1,
              patch: { name: "after" },
            });
            yield* tx.call(p + "Site.delete", { id, expectedVersion: 2 });
          }),
        ctx,
      ),
    );
    await expect(call("Site.get", { id })).rejects.toMatchObject({
      code: "NotFound",
    });
    expect(await audit()).toHaveLength(4);
  });
}

for (const adapter of ["memory", "sqlite", "libsql"]) {
  it(`${adapter}: a changed reference can target a parent created after the child's first mutation`, async () => {
    const mutable = new Model(structuredClone(model.bundle));
    mutable
      .resource(p + "Site")
      .fields.find((field) => field.name === "customer")!.immutable = false;
    const { engine, call } = await fixture(adapter, mutable);
    const first = await call("Customer.create", {
      code: "FIRST",
      name: "first",
    });
    const child = await run(
      engine.transaction(
        (tx) =>
          Effect.gen(function* () {
            const site = yield* tx.call(p + "Site.create", {
              customer: first.id,
              code: "MOVING",
              name: "site",
              timezone: "UTC",
            });
            const second = yield* tx.call(p + "Customer.create", {
              code: "SECOND",
              name: "second",
            });
            yield* tx.call(p + "Site.update", {
              id: site.id,
              expectedVersion: 1,
              patch: { customer: second.id },
            });
            return yield* tx.call(p + "Site.update", {
              id: site.id,
              expectedVersion: 2,
              patch: { name: "moved" },
            });
          }),
        ctx,
      ),
    );
    expect(await call("Site.get", { id: child.id })).toMatchObject({
      customer: child.customer,
      name: "moved",
      version: 3,
    });
    expect(await call("Customer.get", { id: child.customer })).toMatchObject({
      code: "SECOND",
    });
  });

  it(`${adapter}: rejects transient duplicate unique keys even when later changed away`, async () => {
    const { engine, call } = await fixture(adapter);
    await call("Customer.create", { code: "TAKEN", name: "holder" });
    await expect(
      run(
        engine.transaction(
          (tx) =>
            Effect.gen(function* () {
              yield* tx.call(p + "Customer.create", {
                code: "FRESH",
                name: "must roll back",
              });
              yield* tx.call(p + "Customer.create", {
                code: "TAKEN",
                name: "temporary duplicate",
              });
            }),
          ctx,
        ),
      ),
    ).rejects.toMatchObject({ code: "UniqueConflict" });
    await expect(
      call("Customer.find.byCode", { params: { code: "FRESH" } }),
    ).rejects.toMatchObject({ code: "NotFound" });
  });

  it(`${adapter}: update then hard delete preserves the original durable guard`, async () => {
    const { engine, call, audit } = await fixture(adapter);
    const parent = await call("Customer.create", {
      code: "HARD-PARENT",
      name: "parent",
    });
    const site = await call("Site.create", {
      customer: parent.id,
      code: "DURABLE",
      name: "before",
      timezone: "UTC",
    });
    await run(
      engine.transaction(
        (tx) =>
          Effect.gen(function* () {
            yield* tx.call(p + "Site.update", {
              id: site.id,
              expectedVersion: 1,
              patch: { name: "after" },
            });
            yield* tx.call(p + "Site.delete", {
              id: site.id,
              expectedVersion: 2,
            });
          }),
        ctx,
      ),
    );
    await expect(call("Site.get", { id: site.id })).rejects.toMatchObject({
      code: "NotFound",
    });
    expect(await audit()).toHaveLength(4);
  });
}

it("rejects a snapshot over the bound and adapters without read-set support before the body", async () => {
  const { engine, storage } = await fixture();
  let pages = 0;
  storage.exportPage = () =>
    Effect.succeed({ records: [], next: String(++pages) });
  await expect(
    run(
      engine.transaction(
        (tx) => tx.call(p + "Customer.list.all", { params: {} }),
        ctx,
      ),
    ),
  ).rejects.toMatchObject({ code: "BudgetExceeded" });
  Object.defineProperty(storage, "atomicReadSet", { value: undefined });
  let called = false;
  await expect(
    run(
      engine.transaction(
        () =>
          Effect.sync(() => {
            called = true;
          }),
        ctx,
      ),
    ),
  ).rejects.toMatchObject({ code: "ValidationFailed" });
  expect(called).toBe(false);
});

it("supports non-versioned repeated mutations using resource revision guards", async () => {
  const mutable = new Model(structuredClone(model.bundle));
  mutable.resource(p + "Customer").decorators.versioned = false;
  const { engine, call } = await fixture("memory", mutable);
  const record = await call("Customer.create", {
    code: "NONVERSIONED",
    name: "before",
  });
  await run(
    engine.transaction(
      (tx) =>
        Effect.gen(function* () {
          yield* tx.call(p + "Customer.update", {
            id: record.id,
            patch: { name: "middle" },
          });
          yield* tx.call(p + "Customer.update", {
            id: record.id,
            patch: { name: "after" },
          });
        }),
      ctx,
    ),
  );
  expect(await call("Customer.get", { id: record.id })).toMatchObject({
    name: "after",
  });
});
