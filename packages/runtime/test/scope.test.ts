/**
 * M12 runtime (PAR-102..107): purpose-scoped calls project through the
 * compiled surface (checked output object, never a cast), query authority
 * is separate from read, actions are separate from field updates, purposes
 * do not union at runtime, and scoped readers are nominal service keys.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Cause, Effect } from "effect";
import { beforeEach, describe, expect, it } from "vitest";
import { Model, type AppBundle } from "../src/model.js";
import { Engine, type CallContext } from "../src/engine.js";
import { ForgeError } from "../src/errors.js";
import { MemoryStorage } from "../src/adapters/memory.js";
import { testLayer } from "../src/testing.js";
import { scopedReader, type ScopedReader } from "../src/scope.js";

const bundle = JSON.parse(readFileSync(resolve(import.meta.dirname, "..", "..", "..", "conformance", "fixtures", "acme-next.app.json"), "utf8")) as AppBundle;
const N = "@acme/commerce-next/_";
const G = "@acme/governance/_";
const base: CallContext = { tenant: "t", actor: "agent", requestId: "r" };
const support: CallContext = { ...base, purpose: `${G}/CustomerSupport` };
const parent: CallContext = { ...base, purpose: `${G}/ParentCommunication` };
const run = <A>(e: Effect.Effect<A, unknown, never>) => Effect.runPromise(e as Effect.Effect<A, never, never>);
const fails = async (e: Effect.Effect<unknown, unknown, never>) => { const x = await Effect.runPromiseExit(e as Effect.Effect<unknown, never, never>); if (x._tag === "Success") throw new Error("expected failure, got " + JSON.stringify(x.value)); const s = Cause.squash(x.cause); if (s instanceof ForgeError) return s; throw s; };

let engine: Engine;
let contact: { id: string; customer: string };
beforeEach(async () => {
  engine = new Engine(new Model(bundle), testLayer(new MemoryStorage()));
  // Seed through the privileged path (no purpose): edition 2027 requires an explicit maintenance actor for that.
  const seed = { ...base, actor: "maintenance", maintenance: true } as CallContext;
  const c = await run(engine.call(`${N}/Customer.create`, { code: "ACME", name: "Acme" }, seed));
  const k = await run(engine.call(`${N}/Contact.create`, { customer: c.id, name: "Pat", email: "pat@example.com", supportNotes: "prefers email" }, seed));
  contact = { id: k.id, customer: c.id };
});

describe("purpose-scoped reads", () => {
  it("PAR-104: a scoped read emits only approved keys — the stored record's hidden fields never leave the engine", async () => {
    const viaParent = await run(engine.call(`${N}/Contact.get`, { id: contact.id }, parent));
    expect(Object.keys(viaParent).sort()).toEqual(["customer", "email", "id", "name"]);
    const viaSupport = await run(engine.call(`${N}/Contact.get`, { id: contact.id }, support));
    expect(Object.keys(viaSupport).sort()).toEqual(["customer", "email", "id", "name", "supportNotes"]);
    // serializing the projection reveals nothing extra
    expect(JSON.parse(JSON.stringify(viaParent))).not.toHaveProperty("supportNotes");
  });
  it("a purpose-scoped resource cannot be read without a purpose (edition 2027), and an unbound purpose has no surface (PAR-100)", async () => {
    expect((await fails(engine.call(`${N}/Contact.get`, { id: contact.id }, base))).code).toBe("NotPermitted");
    expect((await fails(engine.call(`${N}/Contact.get`, { id: contact.id }, { ...base, purpose: `${G}/Marketing` }))).code).toBe("NotPermitted");
  });
  it("PAR-102: two purposes in one invocation are rejected; no ambient union", async () => {
    expect((await fails(engine.call(`${N}/Contact.get`, { id: contact.id }, { ...base, purpose: `${G}/CustomerSupport,${G}/ParentCommunication` }))).code).toBe("ValidationFailed");
  });
});

describe("query authority (PAR-105)", () => {
  it("filtering or ordering by a field outside the surface's filter/order sets is refused before execution", async () => {
    const ok = await run(engine.call(`${N}/Contact.list.byCustomer`, { params: { customer: contact.customer } }, parent));
    expect(ok.items.map((i: any) => Object.keys(i).sort())).toEqual([["customer", "email", "id", "name"]]);
    // the view partition `customer` is in ContactRead's filter set; Customer.list.byTier under CustomerSupport filters on tier (allowed by Directory)
    const cust = await run(engine.call(`${N}/Customer.list.byTier`, { params: { tier: "standard" } }, support));
    expect(cust.items.map((i: any) => Object.keys(i).sort())).toEqual([["code", "id", "name", "tier"]]);
    // Order lists by customer under OrderFulfillment; the FulfillmentRead surface on Site allows filter{customer} — but Site.find.byCustomerCode filters on `code`, not permitted
    const denied = await fails(engine.call(`${N}/Site.find.byCustomerCode`, { params: { customer: contact.customer, code: "HQ" } }, { ...base, purpose: `${G}/OrderFulfillment` }));
    expect(denied.code).toBe("NotPermitted");
    expect(denied.detail).toMatch(/filter.*code/);
  });
});

describe("mutations under a surface (PAR-107)", () => {
  it("update is limited to the surface's update set; actions are granted separately from field writes", async () => {
    const ok = await run(engine.call(`${N}/Contact.update`, { id: contact.id, expectedVersion: 1, patch: { email: "new@example.com" } }, support));
    expect(Object.keys(ok).sort()).toEqual(["customer", "email", "id", "name", "supportNotes"]);
    expect((await fails(engine.call(`${N}/Contact.update`, { id: contact.id, expectedVersion: 2, patch: { name: "X" } }, support))).code).toBe("NotPermitted");
    expect((await fails(engine.call(`${N}/Contact.update`, { id: contact.id, expectedVersion: 2, patch: { email: "x@example.com" } }, parent))).code).toBe("NotPermitted");
  });
  it("a named action runs under its own grant even though the status field is never writable", async () => {
    const seed = { ...base, actor: "maintenance", maintenance: true } as CallContext;
    const s = await run(engine.call(`${N}/Site.create`, { customer: contact.customer, code: "HQ", name: "HQ" }, seed));
    const o = await run(engine.call(`${N}/Order.create`, { customer: contact.customer, site: s.id, total: "10.00" }, seed));
    const fulfil = { ...base, purpose: `${G}/OrderFulfillment` };
    const submitted = await run(engine.call(`${N}/Order.status.submit`, { id: o.id, expectedVersion: 1, input: {} }, fulfil));
    expect(submitted.status).toBe("Submitted");
    expect((await fails(engine.call(`${N}/Order.status.complete`, { id: o.id, expectedVersion: 2, input: {} }, fulfil))).code).toBe("NotPermitted");
  });
});

describe("nominal scoped readers (PAR-103)", () => {
  it("a reader for one (resource, purpose) cannot satisfy a requirement for another even with an identical shape", async () => {
    const a: ScopedReader = scopedReader(engine, `${N}/Contact`, `${G}/CustomerSupport`);
    const b: ScopedReader = scopedReader(engine, `${N}/Contact`, `${G}/ParentCommunication`);
    expect(a.key).not.toBe(b.key);
    expect(a.surface.digest).not.toBe(b.surface.digest);
    const program = Effect.gen(function* () {
      const reader = yield* b.service; // requires the ParentCommunication reader
      return yield* reader.get(contact.id, base);
    });
    // Providing the CustomerSupport reader under its own key does not satisfy the ParentCommunication requirement.
    const wrong = await Effect.runPromiseExit(program.pipe(Effect.provideService(a.service, a.reader)) as never);
    expect(wrong._tag).toBe("Failure");
    const right = await Effect.runPromise(program.pipe(Effect.provideService(b.service, b.reader)) as never);
    expect(Object.keys(right as object).sort()).toEqual(["customer", "email", "id", "name"]);
  });
});

/** PAR-143: a cached value loaded under a broad surface is disclosed only through the caller's current surface. */
describe("cached values under purpose surfaces", () => {
  it("the same cache entry is projected per purpose; a narrower purpose never sees fields the broader load stored", async () => {
    const seed: CallContext = { ...base, actor: "maintenance", maintenance: true };
    await run(engine.call(`${N}/ContactPreference.create`, { contact: contact.id, channel: "email", marketingOptIn: true, internalScore: 42, effectiveFrom: "2020-01-01T00:00:00Z" }, seed));
    // CustomerSupport (Scoring) loads the cache: the stored value is the full loader result
    const broad = await run(engine.call(`${N}/CurrentPreference.read`, { key: { contact: contact.id } }, support));
    expect(broad.value).toMatchObject({ channel: "email", internalScore: 42 });
    expect(Object.keys(broad.value as object).sort()).toEqual(["channel", "contact", "effectiveFrom", "effectiveUntil", "id", "internalScore", "marketingOptIn"]);
    // ParentCommunication (Preference) hits the same entry: internalScore is not on its surface
    const narrow = await run(engine.call(`${N}/CurrentPreference.read`, { key: { contact: contact.id } }, parent));
    expect(narrow.source).toBe("cache");
    expect(Object.keys(narrow.value as object).sort()).toEqual(["channel", "contact", "effectiveFrom", "effectiveUntil", "id", "marketingOptIn"]);
    expect(JSON.stringify(narrow)).not.toContain("internalScore");
    // a purpose with no surface on the value's resource cannot read the cache at all, even though the entry exists
    const none = await fails(engine.call(`${N}/CurrentPreference.read`, { key: { contact: contact.id } }, { ...base, purpose: `${G}/Marketing` }));
    expect(none.code).toBe("NotPermitted");
    // and in the strict edition a scoped resource's cache needs a purpose
    expect((await fails(engine.call(`${N}/CurrentPreference.read`, { key: { contact: contact.id } }, base))).code).toBe("NotPermitted");
  });
});
