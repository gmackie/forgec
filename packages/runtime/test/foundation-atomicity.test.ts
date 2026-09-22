/**
 * Foundation prerequisites exercised against the existing compiled Acme model.
 * Customer is only a versioned guard/posting stand-in; these tests do not
 * implement capacity arithmetic or ledger semantics or certify other stores.
 * Unsupported staged-reference/read-overlay requirements are documented in
 * docs/foundation/kernel-gaps.md and are not counted as passing tests here.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Cause, Effect, type Exit } from "effect";
import { beforeEach, describe, expect, it } from "vitest";
import { MemoryStorage } from "../src/adapters/memory.js";
import { Engine, type CallContext } from "../src/engine.js";
import { ForgeError } from "../src/errors.js";
import { Model, type AppBundle } from "../src/model.js";
import { testLayer } from "../src/testing.js";

const bundle = JSON.parse(readFileSync(resolve(import.meta.dirname, "../../../conformance/fixtures/acme.app.json"), "utf8")) as AppBundle;
const model = new Model(bundle);
const ctx: CallContext = { tenant: "foundation-probe", actor: "operator", requestId: "atomicity" };
const customer = "@acme/commerce/_/Customer";
const run = <A>(effect: Effect.Effect<A, ForgeError, never>) => Effect.runPromise(effect);
const failureCode = <A>(exit: Exit.Exit<A, ForgeError>): string => {
  if (exit._tag === "Success") throw new Error("expected commit conflict");
  const failure = Cause.squash(exit.cause);
  if (!(failure instanceof ForgeError)) throw new Error(Cause.pretty(exit.cause));
  return failure.code;
};

let storage: MemoryStorage;
let engine: Engine;
beforeEach(() => {
  storage = new MemoryStorage();
  engine = new Engine(model, testLayer(storage));
});
const plan = (operation: string, input: Record<string, unknown>) => run(engine.planFor(operation, input, ctx).pipe(Effect.provide(engine.layer)));
const create = (code: string) => run(engine.call(`${customer}.create`, { code, name: code }, ctx));
const get = (id: string) => run(engine.call(`${customer}.get`, { id }, ctx));

describe("Foundation memory transaction prerequisites", () => {
  it("competing groups share one version guard; a losing group's second record and audit do not survive", async () => {
    const guard = await create("POOL");
    // Both contenders finish planning before either can commit. This forces the
    // shared stale read that an unguarded capacity-check/insert would miss.
    const [claimA, claimB, guardA, guardB] = await Promise.all([
      plan(`${customer}.create`, { code: "CLAIMA", name: "A" }),
      plan(`${customer}.create`, { code: "CLAIMB", name: "B" }),
      plan(`${customer}.update`, { id: guard.id, expectedVersion: 1, patch: { name: "claimed A" } }),
      plan(`${customer}.update`, { id: guard.id, expectedVersion: 1, patch: { name: "claimed B" } }),
    ]);
    // Put guard last to prove a conflict rolls back an earlier applied write.
    const outcomes = await Promise.all([
      Effect.runPromiseExit(Effect.suspend(() => storage.commitAll([claimA, guardA]))),
      Effect.runPromiseExit(Effect.suspend(() => storage.commitAll([claimB, guardB]))),
    ]);
    expect(outcomes.filter((outcome) => outcome._tag === "Success")).toHaveLength(1);
    const failed = outcomes.find((outcome) => outcome._tag === "Failure")!;
    expect(failureCode(failed)).toBe("VersionConflict");
    const winner = outcomes[0]!._tag === "Success" ? claimA : claimB;
    const loser = winner === claimA ? claimB : claimA;
    expect(await get(guard.id)).toMatchObject({ version: 2 });
    expect(await get(winner.id)).toMatchObject({ id: winner.id });
    expect(failureCode(await Effect.runPromiseExit(engine.call(`${customer}.get`, { id: loser.id }, ctx)))).toBe("NotFound");
    const audit = (await storage.dump(ctx.tenant))["audit"]!;
    expect(audit.some((entry) => entry.opId === loser.opId)).toBe(false);
    expect(audit.filter((entry) => entry.opId === winner.opId)).toHaveLength(1);
  });

  it("a last-plan conflict rolls back all earlier posting-like writes, unique claims and audit", async () => {
    const guard = await create("ACCOUNT");
    const debit = await plan(`${customer}.create`, { code: "DEBIT", name: "debit" });
    const credit = await plan(`${customer}.create`, { code: "CREDIT", name: "credit" });
    const account = await plan(`${customer}.update`, { id: guard.id, expectedVersion: 1, patch: { name: "posted" } });
    await run(engine.call(`${customer}.update`, { id: guard.id, expectedVersion: 1, patch: { name: "competitor" } }, ctx));
    const before = await storage.dump(ctx.tenant);
    const rejected = await Effect.runPromiseExit(Effect.suspend(() => storage.commitAll([debit, credit, account])));
    expect(failureCode(rejected)).toBe("VersionConflict");
    expect(await storage.dump(ctx.tenant)).toEqual(before);
    // Unique claims must roll back too, not merely disappear from public reads.
    expect(await create("DEBIT")).toMatchObject({ code: "DEBIT" });
    expect(await create("CREDIT")).toMatchObject({ code: "CREDIT" });
    expect(await get(guard.id)).toMatchObject({ name: "competitor", version: 2 });
  });

  it("two same-record plans against one version reject atomically instead of silently losing a write", async () => {
    const guard = await create("GUARD");
    const first = await plan(`${customer}.update`, { id: guard.id, expectedVersion: 1, patch: { name: "first" } });
    const second = await plan(`${customer}.update`, { id: guard.id, expectedVersion: 1, patch: { name: "second" } });
    const before = await storage.dump(ctx.tenant);
    const rejected = await Effect.runPromiseExit(Effect.suspend(() => storage.commitAll([first, second])));
    expect(failureCode(rejected)).toBe("VersionConflict");
    expect(await storage.dump(ctx.tenant)).toEqual(before);
    expect(await get(guard.id)).toMatchObject({ name: "GUARD", version: 1 });
  });
});
