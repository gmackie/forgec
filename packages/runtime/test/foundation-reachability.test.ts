import { foundation, foundationAdapters } from "./helpers/foundation.js";
import { Effect } from "effect";
import { expect, it } from "vitest";
import { Reachability } from "../src/foundation/reachability.js";
const prefix = "@forgegraph/foundation/reachability/_/";
const ctx = { tenant: "acme", actor: "user", requestId: "reachability" };

/** Half-open windows throughout: a locator is reachable on [validFrom, validUntil). */
const T = {
  start: "2026-01-01T00:00:00Z",
  mid: "2026-02-01T00:00:00Z",
  later: "2026-03-01T00:00:00Z",
  before: "2025-12-31T23:59:59Z",
};

for (const adapter of foundationAdapters)
  it(`${adapter}: profiles stay separated, preference resolves, supersession ends reachability`, async () => {
    const f = await foundation("reachability", adapter);
    const engine = f.engine;
    try {
      const call = (op: string, input: Record<string, unknown>, context = ctx) =>
        Effect.runPromise(engine.call(prefix + op, input, context));
      const run = Effect.runPromise;
      const service = new Reachability(engine);

      const set = await call("LocatorSet.create", { label: "Ada Lovelace" });
      const other = await call("LocatorSet.create", { label: "Billing platform" });

      // Kinds are a registry, so the personal/system split is data rather than syntax.
      const kind = async (key: string, personal: boolean) =>
        call("LocatorKind.create", { key, label: key, personal });
      const email = await kind("email", true);
      const phone = await kind("telephone", true);
      const postal = await kind("postal", true);
      const api = await kind("api-url", false);
      const mcp = await kind("mcp", false);
      const webhook = await kind("webhook", false);

      const purpose = async (key: string) => call("LocatorPurpose.create", { key, label: key });
      const billing = await purpose("billing");
      const support = await purpose("support");
      const emergency = await purpose("emergency");

      // F91-01: email, phone and postal contact points.
      const contact = (kindId: unknown, purposeId: unknown, value: string, preference: number, validUntil?: string) =>
        run(service.declare("ContactPoint", {
          locatorSet: String(set.id), kind: String(kindId), purpose: String(purposeId),
          value, preference, validFrom: T.start, ...(validUntil ? { validUntil } : {}),
        }, ctx));
      const primary = await contact(email.id, billing.id, " ada@example.com ", 1);
      await contact(email.id, billing.id, "ada.alt@example.com", 2);
      await contact(phone.id, emergency.id, "+44 20 7946 0000", 1);
      await contact(postal.id, billing.id, "12 Ockham Road, London", 1);
      // The value normalizer runs on write, so a padded address is one address.
      expect(primary["value"]).toBe("ada@example.com");

      // F91-02: API, MCP and webhook endpoints, on a set that is not a person.
      const endpoint = (kindId: unknown, purposeId: unknown, value: string, preference: number) =>
        run(service.declare("Endpoint", {
          locatorSet: String(other.id), kind: String(kindId), purpose: String(purposeId),
          value, preference, validFrom: T.start,
        }, ctx));
      await endpoint(api.id, support.id, "https://api.example.com/v1", 1);
      await endpoint(mcp.id, support.id, "https://mcp.example.com/sse", 2);
      const hook = await endpoint(webhook.id, billing.id, "https://hooks.example.com/invoices", 1);

      // The profiles are not interchangeable, and the rule is what says so.
      await expect(contact(api.id, support.id, "https://api.example.com/v1", 9)).rejects.toThrow();
      await expect(endpoint(email.id, support.id, "ops@example.com", 9)).rejects.toThrow();

      // F91-05: purpose separates otherwise identical values rather than colliding with them.
      await contact(email.id, support.id, "ada@example.com", 1);
      await expect(contact(email.id, billing.id, "ada@example.com", 7)).rejects.toThrow();
      // One locator per rank within a purpose, so "preferred" is never ambiguous.
      await expect(contact(email.id, billing.id, "ada.third@example.com", 1)).rejects.toThrow();

      // Concurrent writers cannot both claim the same value.
      const racing = await Promise.allSettled(
        Array.from({ length: 8 }, () => contact(phone.id, support.id, "+44 20 7946 0999", 1)),
      );
      expect(racing.filter((r) => r.status === "fulfilled")).toHaveLength(1);

      // F91-03: resolution respects preference, then validity.
      const selector = { locatorSet: String(set.id), kind: String(email.id), purpose: String(billing.id) };
      const resolved = await run(service.resolve("ContactPoint", selector, T.mid, ctx));
      expect(resolved).toMatchObject({ locator: primary["id"], preference: 1, verified: false });

      // F91-04: verification is evidence about a locator, not a precondition for having one.
      await run(service.verify("ContactPoint", String(primary["id"]), {
        verifiedAt: T.mid, method: "double-opt-in", evidence: "confirmation token redeemed",
      }, ctx));
      expect((await run(service.resolve("ContactPoint", selector, T.later, ctx)))?.verified).toBe(true);
      // Verification cannot predate the locator it verifies.
      await expect(run(service.verify("ContactPoint", String(hook["id"]), {
        verifiedAt: T.before, method: "ping", evidence: "too early",
      }, ctx))).rejects.toThrow();

      // F91-03: supersession ends reachability at a boundary and hands over to the replacement.
      const replacement = await contact(email.id, billing.id, "ada@newdomain.example", 3, undefined);
      await expect(run(service.supersede("ContactPoint", String(primary["id"]), String(replacement["id"]), T.mid, "Domain change", ctx))).rejects.toThrow();
      const successor = await run(service.declare("ContactPoint", {
        locatorSet: String(set.id), kind: String(email.id), purpose: String(billing.id),
        value: "ada@newer.example", preference: 4, validFrom: T.later,
      }, ctx));
      await run(service.supersede("ContactPoint", String(primary["id"]), String(successor["id"]), T.later, "Domain change", { ...ctx, idempotencyKey: "supersede-primary" }));
      // Replay of the same decision is the same fact, not a second one.
      await run(service.supersede("ContactPoint", String(primary["id"]), String(successor["id"]), T.later, "Domain change", { ...ctx, idempotencyKey: "supersede-primary" }));
      // One terminal disposition only: a conflicting revoke loses.
      await expect(run(service.revoke("ContactPoint", String(primary["id"]), T.later, "Conflicting", ctx))).rejects.toThrow();

      // Before the disposition the original still answers; after it, the next preference does.
      expect((await run(service.resolve("ContactPoint", selector, T.mid, ctx)))?.locator).toBe(primary["id"]);
      const after = await run(service.resolve("ContactPoint", selector, T.later, ctx));
      expect(after?.locator).not.toBe(primary["id"]);
      // A bounded page containing only a retired locator cannot prove absence.
      await expect(run(service.resolve("ContactPoint", selector, T.later, ctx, 1))).rejects.toMatchObject({ code: "BudgetExceeded" });
      // The first surviving preference is decisive even when later candidates remain.
      expect((await run(service.resolve("ContactPoint", selector, T.mid, ctx, 1)))?.locator).toBe(primary["id"]);

      // A replacement must belong to the same set, so one subject's locator cannot supersede
      // another's, even when the value and kind match exactly.
      const thirdParty = await call("LocatorSet.create", { label: "Unrelated platform" });
      const foreign = await run(service.declare("Endpoint", {
        locatorSet: String(thirdParty.id), kind: String(webhook.id), purpose: String(billing.id),
        value: "https://hooks.example.com/invoices", preference: 1, validFrom: T.later,
      }, ctx));
      await expect(run(service.supersede("Endpoint", String(hook["id"]), String(foreign["id"]), T.later, "Wrong set", ctx))).rejects.toThrow();
      // The same supersession within the owning set is accepted.
      const ownSuccessor = await run(service.declare("Endpoint", {
        locatorSet: String(other.id), kind: String(webhook.id), purpose: String(billing.id),
        value: "https://hooks.example.com/invoices-v2", preference: 2, validFrom: T.later,
      }, ctx));
      await run(service.supersede("Endpoint", String(hook["id"]), String(ownSuccessor["id"]), T.later, "Rotated", ctx));

      // Tenant isolation: another tenant sees none of this.
      const elsewhere = { ...ctx, tenant: "other" };
      expect(await run(service.resolve("ContactPoint", selector, T.mid, elsewhere))).toBeNull();

      // An expired window is unreachable without any disposition at all.
      const expiring = await run(service.declare("ContactPoint", {
        locatorSet: String(set.id), kind: String(phone.id), purpose: String(billing.id),
        value: "+44 20 7946 0123", preference: 1, validFrom: T.start, validUntil: T.mid,
      }, ctx));
      const phoneBilling = { locatorSet: String(set.id), kind: String(phone.id), purpose: String(billing.id) };
      expect((await run(service.resolve("ContactPoint", phoneBilling, T.start, ctx)))?.locator).toBe(expiring["id"]);
      expect(await run(service.resolve("ContactPoint", phoneBilling, T.mid, ctx))).toBeNull();
      expect(await run(service.resolve("ContactPoint", phoneBilling, T.before, ctx))).toBeNull();
      await expect(run(service.declare("ContactPoint", {
        locatorSet: String(set.id), kind: String(postal.id), purpose: String(support.id),
        value: "backwards", preference: 1, validFrom: T.mid, validUntil: T.start,
      }, ctx))).rejects.toThrow();
    } finally {
      await f.close();
    }
  });
