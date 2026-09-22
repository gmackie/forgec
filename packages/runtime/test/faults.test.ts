/**
 * M3 gate: a fault after the database commit but before the response (or
 * before publication) must not duplicate business mutations when the
 * client retries with its idempotency key; a failed precondition must leave
 * no audit/outbox rows. Faults are injected around the storage adapter.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Cause, Effect } from "effect";
import { beforeEach, describe, expect, it } from "vitest";
import { Model, type AppBundle } from "../src/model.js";
import { Engine, type CallContext } from "../src/engine.js";
import { err, ForgeError } from "../src/errors.js";
import { MemoryStorage } from "../src/adapters/memory.js";
import { testLayer } from "../src/testing.js";
import type { CommitPlan, StorageAdapter } from "../src/services.js";

const bundle = JSON.parse(readFileSync(resolve(import.meta.dirname, "..", "..", "..", "conformance", "fixtures", "acme.app.json"), "utf8")) as AppBundle;
const model = new Model(bundle);
const ctx: CallContext = { tenant: "acme", actor: "operator", requestId: "req", idempotencyKey: "k-1" };
const exitOf = <A>(e: Effect.Effect<A, ForgeError, never>) => Effect.runPromiseExit(e);

/** Wraps an adapter so the Nth commit succeeds durably but the call reports a crash. */
function faultAfterCommit(inner: MemoryStorage, onCommitNumber: number): StorageAdapter {
  let n = 0;
  return {
    ...inner,
    get: inner.get.bind(inner), findUnique: inner.findUnique.bind(inner), list: inner.list.bind(inner), countDependents: inner.countDependents.bind(inner),
    getReceipt: inner.getReceipt.bind(inner), commitAll: inner.commitAll.bind(inner), budget: inner.budget.bind(inner), getDocument: inner.getDocument.bind(inner), putDocument: inner.putDocument.bind(inner), putDocuments: inner.putDocuments.bind(inner), exportPage: inner.exportPage.bind(inner),
    outboxSweep: inner.outboxSweep.bind(inner), outboxTenants: inner.outboxTenants.bind(inner), overlapping: inner.overlapping.bind(inner), effectiveAt: inner.effectiveAt.bind(inner), children: inner.children.bind(inner), outboxClaim: inner.outboxClaim.bind(inner), outboxProgress: inner.outboxProgress.bind(inner), outboxDead: inner.outboxDead.bind(inner), outboxRedrive: inner.outboxRedrive.bind(inner), markProcessed: inner.markProcessed.bind(inner),
    commit: (plan: CommitPlan) => inner.commit(plan).pipe(Effect.flatMap(() => (++n === onCommitNumber ? Effect.fail(err("StorageUnavailable", "simulated crash after commit")) : Effect.void))),
  };
}

let storage: MemoryStorage;
beforeEach(() => {
  storage = new MemoryStorage();
});

describe("fault injection", () => {
  it("crash after commit, before response: the retried request replays the receipt and nothing is duplicated", async () => {
    const engine = new Engine(model, testLayer(faultAfterCommit(storage, 1)));
    const first = await exitOf(engine.call("@acme/commerce/_/Customer.create", { code: "ACME", name: "A" }, ctx));
    expect(first._tag).toBe("Failure");
    expect((Cause.squash((first as any).cause) as ForgeError).code).toBe("StorageUnavailable");
    // durable state already has the record, the audit row, the outbox row and the receipt
    const d1 = await storage.dump("acme");
    expect(d1["customer"]).toHaveLength(1);
    expect(d1["audit"]).toHaveLength(1);
    expect(d1["outbox"]).toHaveLength(1);
    // client retries with the same key
    const retry = await Effect.runPromise(engine.call("@acme/commerce/_/Customer.create", { code: "ACME", name: "A" }, ctx));
    expect(retry).toMatchObject({ code: "ACME", version: 1 });
    const d2 = await storage.dump("acme");
    expect(d2["customer"]).toHaveLength(1);
    expect(d2["audit"]).toHaveLength(1);
    expect(d2["outbox"]).toHaveLength(1);
  });

  it("a retry without an idempotency key after a post-commit crash is a semantic conflict, not a duplicate", async () => {
    const engine = new Engine(model, testLayer(faultAfterCommit(storage, 1)));
    const noKey = { tenant: "acme", actor: "operator", requestId: "r" };
    await exitOf(engine.call("@acme/commerce/_/Customer.create", { code: "ACME", name: "A" }, noKey));
    const retry = await exitOf(engine.call("@acme/commerce/_/Customer.create", { code: "ACME", name: "A" }, noKey));
    expect(retry._tag).toBe("Failure");
    expect((Cause.squash((retry as any).cause) as ForgeError).code).toBe("UniqueConflict");
    expect((await storage.dump("acme"))["customer"]).toHaveLength(1);
  });

  it("resumable changeset: crash mid-commit, then resume commits only the remaining rows", async () => {
    const engine = new Engine(model, testLayer(faultAfterCommit(storage, 2)));
    const cs = await Effect.runPromise(engine.call("@acme/commerce/_/changesets.propose", { operations: [
      { op: "@acme/commerce/_/Customer.create", input: { code: "AAA1", name: "1" } },
      { op: "@acme/commerce/_/Customer.create", input: { code: "BBB2", name: "2" } },
      { op: "@acme/commerce/_/Customer.create", input: { code: "CCC3", name: "3" } },
    ] }, ctx));
    const p = await Effect.runPromise(engine.call("@acme/commerce/_/changesets.preview", { id: cs.id }, ctx));
    await Effect.runPromise(engine.call("@acme/commerce/_/changesets.approve", { id: cs.id, contentHash: p.contentHash }, ctx));
    const first = await Effect.runPromise(engine.call("@acme/commerce/_/changesets.commit", { id: cs.id }, ctx));
    // row 2's commit was durable but reported a crash: it is marked error for now; row 3 committed
    expect(first.results.map((r: any) => r.status)).toEqual(["committed", "error", "committed"]);
    const resumed = await Effect.runPromise(engine.call("@acme/commerce/_/changesets.commit", { id: cs.id }, ctx));
    // every row commits under its own receipt (changeset id + index), so resuming row 2 replays its durable
    // result instead of re-executing it: the changeset converges to committed with exactly 3 records.
    expect(resumed.status).toBe("committed");
    expect(resumed.results.map((r: any) => r.status)).toEqual(["committed", "committed", "committed"]);
    expect(resumed.results[1].result.code).toBe("BBB2");
    expect((await storage.dump("acme"))["customer"]).toHaveLength(3);
  });
});
