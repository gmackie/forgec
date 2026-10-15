import { Effect } from "effect";
import { beforeAll, afterAll, expect, it } from "vitest";
import { providerEnvironment } from "./environment.js";
import { Engine } from "../../src/engine.js";
import { defineFunction } from "../../src/functions.js";
const a = "@forgegraph/foundation/allocation/_/",
  p = "@foundation-provider/probe/_/";
let f: Awaited<ReturnType<typeof providerEnvironment>>;
const run = Effect.runPromise;
beforeAll(async () => {
  f = await providerEnvironment();
});
afterAll(async () => {
  await f?.close();
});
const context = (name: string) => ({
  tenant: f.tenantPrefix + "-tx-" + name,
  actor: "transaction-certification",
  requestId: name,
});
const pool = (key: string) => ({
  key,
  mode: "exclusive",
  capacity: "1",
  unit: "slot",
});
const reservation = (id: unknown) => ({
  pool: id,
  key: "child",
  quantity: "1",
  unit: "slot",
  from: "2026-01-02T00:00:00Z",
  until: "2026-01-03T00:00:00Z",
  holdUntil: "2026-01-01T12:00:00Z",
});

it("staged-parent-query", async () => {
  const ctx = context("parent");
  const result = await run(
    f.engine.transaction(
      (tx) =>
        Effect.gen(function* () {
          const parent = yield* tx.call(
            a + "AllocationPool.create",
            pool("parent"),
          );
          const child = yield* tx.call(
            a + "AllocationReservation.create",
            reservation(parent.id),
          );
          expect(
            yield* tx.call(a + "AllocationPool.find.byKey", {
              params: { key: "parent" },
            }),
          ).toEqual(parent);
          expect(
            (yield* tx.call(a + "AllocationReservation.list.all", {
              params: {},
            })).items,
          ).toHaveLength(1);
          return yield* tx.call(p + "Publication.create", {
            key: "result",
            reservation: child.id,
          });
        }),
      ctx,
    ),
  );
  expect(
    await run(
      new Engine(f.model, f.engine.layer).call(
        p + "Publication.find.byKey",
        { params: { key: "result" } },
        ctx,
      ),
    ),
  ).toEqual(result);
});

it("predicate-phantom-rollback", async () => {
  const ctx = context("phantom"),
    commit = f.storage.commitAll.bind(f.storage);
  let injected = false;
  f.storage.commitAll = (plans, absent, reads) =>
    Effect.gen(function* () {
      if (reads?.length && !injected) {
        injected = true;
        yield* Effect.promise(() =>
          run(
            f.engine.call(p + "Publication.create", { key: "competitor" }, ctx),
          ),
        );
      }
      return yield* commit(plans, absent, reads);
    });
  try {
    await expect(
      run(
        f.engine.transaction(
          (tx) =>
            Effect.gen(function* () {
              expect(
                (yield* tx.call(p + "Publication.list.all", { params: {} }))
                  .items,
              ).toEqual([]);
              yield* tx.call(p + "Publication.create", { key: "rollback" });
            }),
          ctx,
        ),
      ),
    ).rejects.toMatchObject({ code: "VersionConflict" });
    await expect(
      run(
        f.engine.call(
          p + "Publication.find.byKey",
          { params: { key: "rollback" } },
          ctx,
        ),
      ),
    ).rejects.toMatchObject({ code: "NotFound" });
  } finally {
    f.storage.commitAll = commit;
  }
});

it("read-only-snapshot-conflict", async () => {
  const ctx = context("read-only"),
    commit = f.storage.commitAll.bind(f.storage);
  let injected = false;
  f.storage.commitAll = (plans, absent, reads) =>
    Effect.gen(function* () {
      if (reads?.length && !injected) {
        injected = true;
        yield* Effect.promise(() =>
          run(f.engine.call(p + "Publication.create", { key: "new" }, ctx)),
        );
      }
      return yield* commit(plans, absent, reads);
    });
  try {
    await expect(
      run(
        f.engine.transaction(
          (tx) => tx.call(p + "Publication.list.all", { params: {} }),
          ctx,
        ),
      ),
    ).rejects.toMatchObject({ code: "VersionConflict" });
  } finally {
    f.storage.commitAll = commit;
  }
});

it("declared-function-receipt", async () => {
  const ctx = { ...context("function"), idempotencyKey: "command" },
    id = p + "TransactionProbe";
  f.model.functions.push({
    id,
    name: "TransactionProbe",
    uses: [
      {
        kind: "resource",
        resource: a + "AllocationPool",
        capability: "create",
      },
      {
        kind: "resource",
        resource: a + "AllocationReservation",
        capability: "create",
      },
    ],
    sends: [],
    errors: [],
    generated: false,
  });
  let calls = 0;
  const impl = defineFunction(
    id,
    (d) =>
      Effect.gen(function* () {
        calls++;
        const parent = yield* d.resources.AllocationPool!.create(
          pool("function"),
        );
        return yield* d.resources.AllocationReservation!.create(
          reservation(parent.id),
        );
      }),
    { transactional: true },
  );
  const engine = new Engine(f.model, f.engine.layer, { functions: [impl] });
  const result = await run(engine.call(id, {}, ctx));
  expect(await run(engine.call(id, {}, ctx))).toEqual(result);
  expect(calls).toBe(1);
  expect(
    await run(f.storage.getReceipt(ctx.tenant, id, "command")),
  ).toMatchObject({ response: result });
});

it("competing-transaction-guards", async () => {
  const ctx = context("race"),
    commit = f.storage.commitAll.bind(f.storage);
  let waiting = 0,
    release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  f.storage.commitAll = (plans, absent, reads) =>
    Effect.gen(function* () {
      if (reads?.length) {
        if (++waiting === 2) release();
        yield* Effect.promise(() => gate);
      }
      return yield* commit(plans, absent, reads);
    });
  try {
    const outcomes = await Promise.allSettled(
      ["left", "right"].map((key) =>
        run(
          f.engine.transaction(
            (tx) =>
              Effect.gen(function* () {
                expect(
                  (yield* tx.call(p + "Publication.list.all", { params: {} }))
                    .items,
                ).toEqual([]);
                yield* tx.call(p + "Publication.create", { key });
              }),
            ctx,
          ),
        ),
      ),
    );
    expect(outcomes.filter((x) => x.status === "fulfilled")).toHaveLength(1);
    expect(outcomes.filter((x) => x.status === "rejected")).toHaveLength(1);
  } finally {
    release();
    f.storage.commitAll = commit;
  }
});
