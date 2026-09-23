import { foundation, foundationAdapters } from "./helpers/foundation.js";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { D1Storage } from "../src/adapters/d1.js";
import type { SqlExecutor, SqlStatement } from "../src/adapters/sql-executor.js";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Effect } from "effect";
import { expect, it } from "vitest";
import { Engine } from "../src/engine.js";
import { Model, type AppBundle } from "../src/model.js";
import { MemoryStorage } from "../src/adapters/memory.js";
import { testLayer } from "../src/testing.js";
import { Ledger } from "../src/foundation/ledger.js";
import { localAuthorizer } from "../src/gatekeeper.js";
const fixture = process.env["FORGE_FOUNDATION_CONSUMER"] ?? resolve(import.meta.dirname, "../../../conformance/fixtures/ledger-consumer");
const bundle = JSON.parse(readFileSync(resolve(fixture, "app.json"), "utf8")) as AppBundle;
const prefix = "@forgegraph/foundation/ledger/_/", consumer = "@foundation-probe/ledger-consumers/_/";
const ctx = { tenant: "acme", actor: "user", requestId: "usage" };
for (const adapter of foundationAdapters) it(`${adapter}: exact ledger, atomic groups, concurrent reversals and rebuilds`, async () => {
  const f = await foundation("ledger", adapter, true);
  const engine = f.engine, model = engine.model;
  try {
    const call = (op: string, input: Record<string, unknown>, context = ctx) => Effect.runPromise(engine.call(prefix + op, input, context));
    const service = new Ledger(engine), run = Effect.runPromise;
    const book = await call("LedgerBook.create", { key: "book" });
    const accounts: Record<string, string[]> = {};
    for (const [unit, consumerName] of [["USD", "Money"], ["widget", "Inventory"], ["credit", "ComputeCredits"]]) {
      accounts[unit!] = [];
      for (const key of ["source", "destination"]) {
        const a = await call("Account.create", { book: book.id, key: unit + key, unit });
        accounts[unit!]!.push(String(a.id));
        await run(engine.call(consumer + consumerName + ".create", { account: a.id }, ctx));
      }
    }
    const [source, destination] = accounts.USD! as [string, string];
    const input = { book: String(book.id), key: "purchase", policy: "balanced" as const, reason: "Purchase", entries: [{ account: source, quantity: "-0.100001" }, { account: destination, quantity: "0.100001" }] };
    const pending = await call("Entry.create", { book: book.id, account: destination, quantity: "500", next: null });
    expect((await run(service.balance(destination, ctx))).quantity).toBe("0.000000");
    const results = await Promise.allSettled(Array.from({ length: 5 }, () => run(service.post(input, ctx))));
    expect(results.filter(r => r.status === "fulfilled")).toHaveLength(5);
    const posted = (results[0] as PromiseFulfilledResult<Record<string, unknown>>).value;
    expect(new Set(results.map(r => (r as PromiseFulfilledResult<Record<string, unknown>>).value.id)).size).toBe(1);
    expect((await run(service.balance(destination, ctx))).quantity).toBe("0.100001");
    await expect(run(service.post({ ...input, reason: "Mismatch" }, ctx))).rejects.toMatchObject({ code: "IdempotencyMismatch" });
    await expect(run(service.post({ ...input, key: "unbalanced", entries: [{ account: source, quantity: "-1" }] }, ctx))).rejects.toThrow();
    await expect(run(service.post({ ...input, key: "exchange", entries: [{ account: source, quantity: "-1" }, { account: accounts.widget![0]!, quantity: "1" }] }, ctx))).rejects.toThrow();
    await expect(run(service.post({ ...input, key: "precision", entries: [{ account: source, quantity: "0.0000001" }] }, ctx))).rejects.toThrow();
    for (const [unit, pair] of Object.entries(accounts)) {
      await run(service.post({ ...input, key: unit, entries: [{ account: pair[0]!, quantity: "-9007199254.000001" }, { account: pair[1]!, quantity: "9007199254.000001" }] }, ctx));
    }
    const reversals = await Promise.allSettled([run(service.reverse(String(book.id), String(posted.id), "reverse-a", "Refund", ctx)), run(service.reverse(String(book.id), String(posted.id), "reverse-b", "Refund", ctx))]);
    expect(reversals.filter(r => r.status === "fulfilled")).toHaveLength(1);
    expect((await run(service.balance(destination, ctx))).quantity).toBe("9007199254.000001");
    await expect(run(service.reverse(String(book.id), String(posted.id), "reverse-c", "Again", ctx))).rejects.toThrow();
    await run(service.post({ ...input, key: "issuance", policy: "unrestricted", entries: [{ account: accounts.credit![1]!, quantity: "0.25" }] }, ctx));
    expect((await run(service.balance(accounts.credit![1]!, ctx))).quantity).toBe("9007199254.250001");
    const correction = await run(service.post({ ...input, key: "correction", entries: [{ account: source, quantity: "-0.200002" }, { account: destination, quantity: "0.200002" }] }, ctx));
    expect((await run(service.balance(destination, ctx))).quantity).toBe("9007199254.200003");
    const restarted = new Ledger(new Engine(model, engine.layer));
    expect(await run(restarted.rebuild(String(book.id), ctx))).toEqual(await run(service.rebuild(String(book.id), ctx)));
    for (const resource of ["PostingGroup", "Entry", "Account"]) {
      await expect(call(resource + ".update", { id: posted.id, patch: { reason: "Rewrite" } })).rejects.toThrow();
      await expect(call(resource + ".delete", { id: posted.id })).rejects.toThrow();
    }
    await expect(run(service.balance(destination, { ...ctx, tenant: "other" }))).rejects.toThrow();
    const guarded = new Engine(model, engine.layer);
    guarded.gatekeeper.authorizer = localAuthorizer({ policies: ["LedgerBook", "Account", "Entry"].map(name => ({ id: name, actions: [prefix + name + ".*"], requires: [], where: [] })), pips: [], epoch: 1, knownObligations: [] });
    await expect(run(new Ledger(guarded).balance(destination, ctx))).rejects.toMatchObject({ code: "NotFound" });
    await call("PostingGroup.create", { book: book.id, key: "malicious", claim: "post:malicious", head: pending.id, policy: "balanced", reversalOf: null, reason: "Raw unbalanced seal" });
    await expect(run(service.balance(destination, ctx))).rejects.toMatchObject({ code: "ValidationFailed" });
    await expect(run(service.post({ ...input, key: "after-poison" }, ctx))).rejects.toThrow();
    expect(correction.id).toBeTruthy();
  } finally { await f.close(); }
});
