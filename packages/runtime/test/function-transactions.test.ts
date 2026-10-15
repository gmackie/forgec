import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Effect } from "effect";
import { afterEach, expect, it } from "vitest";
import { Model, type AppBundle } from "../src/model.js";
import { Engine } from "../src/engine.js";
import { MemoryStorage } from "../src/adapters/memory.js";
import { testLayer } from "../src/testing.js";
import { defineFunction, type FunctionContext } from "../src/functions.js";
import { err, type ForgeError } from "../src/errors.js";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { createClient } from "@libsql/client";
import { D1Storage } from "../src/adapters/d1.js";
import { libsqlExecutor } from "../src/adapters/libsql-executor.js";
import type {
  SqlExecutor,
  SqlStatement,
} from "../src/adapters/sql-executor.js";
import type { StorageAdapter, CommitPlan } from "../src/services.js";
import { localAuthorizer } from "../src/gatekeeper.js";
const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const close of cleanup.splice(0)) close();
});

const p = "@acme/commerce/_/",
  fn = p + "Compose",
  ctx = { tenant: "functions", actor: "operator", requestId: "tx" };
const run = Effect.runPromise;
function fixture(
  body: (
    deps: FunctionContext,
  ) => Effect.Effect<Record<string, unknown> | void, ForgeError>,
  storage: StorageAdapter = new MemoryStorage(),
  transactional = true,
) {
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
  model.functions.push({
    id: fn,
    name: "Compose",
    uses: [
      { kind: "resource", resource: p + "Customer", capability: "write" },
      { kind: "resource", resource: p + "Site", capability: "write" },
    ],
    sends: [{ channel: p + "OrderEvents", message: "OrderSubmitted" }],
    errors: [],
    generated: false,
  });
  const engine = new Engine(model, testLayer(storage), {
    functions: [defineFunction(fn, body, { transactional })],
  });
  return { engine, storage: storage as MemoryStorage, model };
}

it("a declared function sees staged versions and references, retaining its receipt and message", async () => {
  let calls = 0;
  const { engine, storage } = fixture((d) =>
    Effect.gen(function* () {
      calls++;
      const customer = yield* d.resources.Customer!.create({
        code: "PARENT",
        name: "first",
      });
      yield* d.resources.Customer!.update(String(customer.id), 1, {
        name: "second",
      });
      expect(
        yield* d.resources.Customer!.get(String(customer.id)),
      ).toMatchObject({ version: 2, name: "second" });
      const site = yield* d.resources.Site!.create({
        customer: customer.id,
        code: "HQ",
        name: "HQ",
        timezone: "UTC",
      });
      yield* d.send("OrderEvents", "OrderSubmitted", {
        order: "test",
        customer: customer.id,
        revision: 2,
      });
      return site;
    }),
  );
  const context = { ...ctx, idempotencyKey: "command" };
  const result = await run(engine.call(fn, {}, context));
  expect(await run(engine.call(fn, {}, context))).toEqual(result);
  expect(calls).toBe(1);
  expect(
    await run(storage.getReceipt(ctx.tenant, fn, "command")),
  ).toMatchObject({ response: result });
  const dump = await storage.dump(ctx.tenant);
  expect(dump.audit).toHaveLength(3);
  expect(
    dump.outbox!.filter((o) => o.channel === p + "OrderEvents"),
  ).toHaveLength(1);
});

it("a late function failure leaves no writes, messages or receipt", async () => {
  const { engine, storage } = fixture((d) =>
    Effect.gen(function* () {
      yield* d.resources.Customer!.create({ code: "ROLLBACK", name: "before" });
      yield* d.send("OrderEvents", "OrderSubmitted", {
        order: "test",
        customer: "test",
        revision: 1,
      });
      return yield* Effect.fail(err("ValidationFailed", "late failure"));
    }),
  );
  const before = await storage.dump(ctx.tenant);
  await expect(
    run(engine.call(fn, {}, { ...ctx, idempotencyKey: "failed" })),
  ).rejects.toMatchObject({ code: "ValidationFailed" });
  expect(await storage.dump(ctx.tenant)).toEqual(before);
  expect(await run(storage.getReceipt(ctx.tenant, fn, "failed"))).toBeNull();
});

async function sqlStorage(adapter: string) {
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

  return sql;
}

for (const adapter of ["sqlite", "libsql"]) {
  it(`${adapter}: commits staged updates, references and function receipts atomically`, async () => {
    const sql = await sqlStorage(adapter);
    const body = (d: FunctionContext) =>
      Effect.gen(function* () {
        const customer = yield* d.resources.Customer!.create({
          code: "SQL",
          name: "before",
        });
        yield* d.resources.Customer!.update(String(customer.id), 1, {
          name: "after",
        });
        yield* d.resources.Site!.create({
          customer: customer.id,
          code: "HQ",
          name: "HQ",
          timezone: "UTC",
        });
        yield* d.send("OrderEvents", "OrderSubmitted", {
          order: "test",
          customer: customer.id,
          revision: 2,
        });
        return yield* d.resources.Customer!.get(String(customer.id));
      });
    const f = fixture(body);
    const storage = new D1Storage(sql, f.model);
    const engine = new Engine(f.model, testLayer(storage), {
      functions: [defineFunction(fn, body, { transactional: true })],
    });
    const context = { ...ctx, idempotencyKey: "sql-command" };
    const result = await run(engine.call(fn, {}, context));
    expect(result).toMatchObject({ name: "after", version: 2 });
    expect(await run(engine.call(fn, {}, context))).toEqual(result);
    expect(
      await run(storage.getReceipt(ctx.tenant, fn, "sql-command")),
    ).toMatchObject({ response: result });
    expect(
      await run(
        storage.get(
          ctx.tenant,
          f.model.resource(p + "Customer"),
          String(result.id),
        ),
      ),
    ).toMatchObject({ name: "after", version: 2 });
    expect(
      await sql.all({
        sql: "SELECT * FROM forge_audit WHERE tenant = ?",
        params: [ctx.tenant],
      }),
    ).toHaveLength(3);
  });
}

it("rejects unsupported adapters before executing the body", async () => {
  let executed = false;
  const storage = new MemoryStorage();
  Object.defineProperty(storage, "atomicComposition", { value: undefined });
  const { engine } = fixture(
    () =>
      Effect.sync(() => {
        executed = true;
      }),
    storage,
  );
  await expect(run(engine.call(fn, {}, ctx))).rejects.toMatchObject({
    code: "ValidationFailed",
  });
  expect(executed).toBe(false);
});

it("budgets the final receipt and messages before committing records", async () => {
  const storage = new MemoryStorage();
  const budgets: CommitPlan[][] = [];
  storage.budget = (plans) => {
    budgets.push(structuredClone(plans));
    return { actions: 2, limit: 1 };
  };
  const { engine } = fixture(
    (d) =>
      Effect.gen(function* () {
        yield* d.resources.Customer!.create({ code: "LIMIT", name: "limited" });
        yield* d.send("OrderEvents", "OrderSubmitted", { order: "test" });
      }),
    storage,
  );
  const before = await storage.dump(ctx.tenant);
  await expect(
    run(engine.call(fn, {}, { ...ctx, idempotencyKey: "budget" })),
  ).rejects.toMatchObject({ code: "BudgetExceeded" });
  expect(budgets).toHaveLength(1);
  expect(budgets[0]![0]!.receipt).toMatchObject({ key: "budget" });
  expect(
    budgets[0]![0]!.outbox.some((o) => o.channel === p + "OrderEvents"),
  ).toBe(true);
  expect(await storage.dump(ctx.tenant)).toEqual(before);
});

for (const sends of [false, true]) {
  it(`replays the actual result for a ${sends ? "message" : "receipt"}-only function`, async () => {
    let calls = 0;
    const { engine, storage } = fixture((d) =>
      Effect.gen(function* () {
        calls++;
        if (sends)
          yield* d.send("OrderEvents", "OrderSubmitted", { order: "test" });
        return { answer: 42 };
      }),
    );
    const context = { ...ctx, idempotencyKey: "read-only" };
    expect(await run(engine.call(fn, {}, context))).toEqual({ answer: 42 });
    expect(await run(engine.call(fn, {}, context))).toEqual({ answer: 42 });
    expect(calls).toBe(1);
    expect(
      await run(storage.getReceipt(ctx.tenant, fn, "read-only")),
    ).toMatchObject({ response: { answer: 42 } });
  });
}

it("expires escaped reads, writes, messages and external calls without executing them", async () => {
  let escaped!: FunctionContext;
  let externalCalls = 0;
  const f = fixture((d) =>
    Effect.sync(() => {
      escaped = d;
    }),
  );
  const external = "@acme/payments/_/AuthorizePayment";
  f.model.function(fn)!.uses.push({ kind: "function", function: external });
  const engine = new Engine(f.model, testLayer(f.storage), {
    functions: [
      defineFunction(
        fn,
        (d) =>
          Effect.sync(() => {
            escaped = d;
          }),
        { transactional: true },
      ),
    ],
    externals: {
      [external]: async () => {
        externalCalls++;
        return { ok: true, value: {} };
      },
    },
  });
  await run(engine.call(fn, {}, ctx));
  for (const effect of [
    escaped.resources.Customer!.get("missing"),
    escaped.resources.Customer!.create({ code: "ESCAPE", name: "escape" }),
    escaped.send("OrderEvents", "OrderSubmitted", {}),
    escaped.external(external, {}),
  ]) {
    await expect(run(effect)).rejects.toMatchObject({
      code: "ValidationFailed",
    });
  }
  expect(externalCalls).toBe(0);
  expect((await f.storage.dump(ctx.tenant)).audit).toHaveLength(0);
});

it("does not stage an unexecuted send Effect", async () => {
  const { engine, storage } = fixture((d) =>
    Effect.sync(() => {
      d.send("OrderEvents", "OrderSubmitted", {});
    }),
  );
  await run(engine.call(fn, {}, ctx));
  expect((await storage.dump(ctx.tenant)).outbox).toHaveLength(0);
});

it("rejects queries of touched resources and rolls back the writes", async () => {
  const { engine, storage } = fixture((d) =>
    Effect.gen(function* () {
      yield* d.resources.Customer!.create({ code: "QUERY", name: "query" });
      yield* d.resources.Customer!.find("byCode", { code: "QUERY" });
    }),
  );
  await expect(run(engine.call(fn, {}, ctx))).rejects.toMatchObject({
    code: "ValidationFailed",
  });
  expect((await storage.dump(ctx.tenant)).audit).toHaveLength(0);
});

it("runs authorization on staged mutations before committing", async () => {
  const { engine, storage } = fixture((d) =>
    d.resources.Customer!.create({ code: "AUTH", name: "denied" }),
  );
  engine.gatekeeper.authorizer = localAuthorizer({
    policies: [],
    pips: [],
    epoch: 1,
    knownObligations: [],
  });
  await expect(run(engine.call(fn, {}, ctx))).rejects.toMatchObject({
    code: "NotPermitted",
  });
  expect((await storage.dump(ctx.tenant)).audit).toHaveLength(0);
});

for (const adapter of ["memory", "sqlite", "libsql"]) {
  it(`${adapter}: commits subscription completion with staged writes and messages`, async () => {
    let calls = 0;
    const body = (d: FunctionContext) =>
      Effect.gen(function* () {
        calls++;
        const customer = yield* d.resources.Customer!.create({
          code: "CONSUMER",
          name: "before",
        });
        yield* d.resources.Customer!.update(String(customer.id), 1, {
          name: "after",
        });
        yield* d.send("OrderEvents", "OrderSubmitted", { order: "test" });
      });
    const f = fixture(body);
    f.model.subscription("fulfill-order")!.handler = fn;
    const storage =
      adapter === "memory"
        ? f.storage
        : new D1Storage(await sqlStorage(adapter), f.model);
    const original = storage.commitAll.bind(storage);
    let committed: CommitPlan[] = [];
    storage.commitAll = (plans) => {
      committed = plans;
      return original(plans);
    };
    const engine = new Engine(f.model, testLayer(storage), {
      functions: [defineFunction(fn, body, { transactional: true })],
    });
    const env = {
      channel: p + "OrderEvents",
      message: "OrderSubmitted",
      tenant: ctx.tenant,
      opId: "delivery",
      ordinal: 0,
      messageId: "delivery:0",
      payload: {},
      createdAt: "t",
    };
    expect(await engine.consume("fulfill-order", env)).toBe("processed");
    expect(committed[0]!.completion!.doc).toMatchObject({ status: "complete" });
    expect(
      committed[0]!.outbox.some((o) => o.channel === p + "OrderEvents"),
    ).toBe(true);
    expect(await engine.consume("fulfill-order", env)).toBe("duplicate");
    expect(calls).toBe(1);
    const completion = committed[0]!.completion!;
    expect(
      await run(
        storage.getDocument(ctx.tenant, completion.kind, completion.id),
      ),
    ).toMatchObject({ status: "complete" });
  });
}

it("a rejected subscription budget releases the claim for retry without committing writes", async () => {
  const f = fixture((d) =>
    d.resources.Customer!.create({ code: "RETRY", name: "retry" }),
  );
  f.model.subscription("fulfill-order")!.handler = fn;
  const budget = f.storage.budget.bind(f.storage);
  let reject = true;
  f.storage.budget = (plans) => {
    expect(plans[0]!.completion).toBeDefined();
    return reject ? { actions: 2, limit: 1 } : budget(plans);
  };
  const env = {
    channel: p + "OrderEvents",
    message: "OrderSubmitted",
    tenant: ctx.tenant,
    opId: "retry",
    ordinal: 0,
    messageId: "retry:0",
    payload: {},
    createdAt: "t",
  };
  await expect(f.engine.consume("fulfill-order", env)).rejects.toMatchObject({
    code: "BudgetExceeded",
  });
  expect((await f.storage.dump(ctx.tenant)).audit).toHaveLength(0);
  reject = false;
  expect(await f.engine.consume("fulfill-order", env)).toBe("processed");
  expect(await f.engine.consume("fulfill-order", env)).toBe("duplicate");
});

it("refuses overlapping resource effects within a transactional function", async () => {
  const { engine, storage } = fixture((d) =>
    Effect.all(
      [
        d.resources.Customer!.create({ code: "A", name: "A" }),
        d.resources.Customer!.create({ code: "B", name: "B" }),
      ],
      { concurrency: "unbounded" },
    ).pipe(Effect.asVoid),
  );
  await expect(run(engine.call(fn, {}, ctx))).rejects.toMatchObject({
    code: "ValidationFailed",
  });
  expect((await storage.dump(ctx.tenant)).audit).toHaveLength(0);
});

it("preserves subscription external-effect fencing after a transactional handler fails", async () => {
  let externalCalls = 0;
  const external = "@acme/payments/_/AuthorizePayment";
  const f = fixture(() => Effect.void);
  f.model.subscription("fulfill-order")!.handler = fn;
  f.model.function(fn)!.uses.push({ kind: "function", function: external });
  const engine = new Engine(f.model, testLayer(f.storage), {
    functions: [
      defineFunction(
        fn,
        (d) =>
          Effect.gen(function* () {
            yield* d.resources.Customer!.create({
              code: "EXTERNAL",
              name: "pending",
            });
            yield* d.external(external, {});
            return yield* Effect.fail(
              err("ValidationFailed", "after external effect"),
            );
          }),
        { transactional: true },
      ),
    ],
    externals: {
      [external]: async () => {
        externalCalls++;
        return { ok: true, value: {} };
      },
    },
  });
  const env = {
    channel: p + "OrderEvents",
    message: "OrderSubmitted",
    tenant: ctx.tenant,
    opId: "external",
    ordinal: 0,
    messageId: "external:0",
    payload: {},
    createdAt: "t",
  };
  await expect(engine.consume("fulfill-order", env)).rejects.toMatchObject({
    code: "DeliveryOutcomeUnknown",
  });
  await expect(engine.consume("fulfill-order", env)).rejects.toMatchObject({
    code: "DeliveryOutcomeUnknown",
  });
  expect(externalCalls).toBe(1);
  expect((await f.storage.dump(ctx.tenant)).audit).toHaveLength(0);
});
