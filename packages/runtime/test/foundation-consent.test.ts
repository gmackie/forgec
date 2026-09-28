import { foundation, foundationAdapters } from "./helpers/foundation.js";
import { Effect } from "effect";
import { expect, it } from "vitest";
import { Consent } from "../src/foundation/consent.js";
const prefix = "@forgegraph/foundation/consent/_/";
const ctx = { tenant: "acme", actor: "user", requestId: "consent" };

const JAN = "2026-01-01T00:00:00Z";
const JAN_15 = "2026-01-15T00:00:00Z";
const FEB = "2026-02-01T00:00:00Z";
const FEB_15 = "2026-02-15T00:00:00Z";
const FEB_20 = "2026-02-20T00:00:00Z";
const MAR = "2026-03-01T00:00:00Z";
const MAR_05 = "2026-03-05T00:00:00Z";

for (const adapter of foundationAdapters)
  it(`${adapter}: grants, evidence, withdrawal, and what was known when`, async () => {
    const f = await foundation("consent", adapter);
    const engine = f.engine;
    try {
      const call = (op: string, input: Record<string, unknown>, context = ctx) =>
        Effect.runPromise(engine.call(prefix + op, input, context));
      const run = Effect.runPromise;
      const service = new Consent(engine);

      const subject = await call("ConsentSubject.create", { label: "Ada" });
      const keyed = async (resource: string, key: string) =>
        String((await call(`${resource}.create`, { key, label: key })).id);
      const research = await keyed("ConsentPurpose", "research");
      const marketing = await keyed("ConsentPurpose", "marketing");
      const store = await keyed("ProcessingActivity", "store");
      const share = await keyed("ProcessingActivity", "share");
      const health = await keyed("ConsentScope", "health-records");
      const partner = await keyed("ConsentCounterparty", "partner-lab");
      const explicit = await keyed("ConsentBasis", "explicit-consent");

      const selector = { subject: String(subject.id), purpose: research, activity: store, scope: health };

      // F93-01: a durable grant, with both axes recorded from the start.
      const original = await run(service.grant({
        ...selector, grantedTo: partner, basis: explicit,
        conditions: "Anonymized before analysis",
        validFrom: JAN, recordedAt: JAN,
      }, ctx));

      // F93-03: purpose, activity and scope are separate axes. Agreeing to store for research
      // is not agreeing to share, nor to store for marketing.
      expect(await run(service.effectiveAt({ ...selector, activity: share }, { validAt: JAN_15 }, ctx))).toBeNull();
      expect(await run(service.effectiveAt({ ...selector, purpose: marketing }, { validAt: JAN_15 }, ctx))).toBeNull();
      expect((await run(service.effectiveAt(selector, { validAt: JAN_15 }, ctx)))?.grant).toBe(original["id"]);

      // F93-04: evidence is attachable and is not a precondition for the grant existing.
      expect((await run(service.effectiveAt(selector, { validAt: JAN_15 }, ctx)))?.evidenced).toBe(false);
      await run(service.evidence(String(original["id"]), {
        capturedAt: JAN, method: "signed-form", provenance: "Scanned consent form, reference RF-2026-0001",
      }, ctx));
      expect((await run(service.effectiveAt(selector, { validAt: JAN_15 }, ctx)))?.evidenced).toBe(true);
      // Evidence cannot predate the grant it evidences.
      await expect(run(service.evidence(String(original["id"]), {
        capturedAt: "2025-01-01T00:00:00Z", method: "backdated", provenance: "too early",
      }, ctx))).rejects.toThrow();

      // F93-08, the case this package exists for. The subject withdraws on 1 March, backdated
      // to take effect on 1 February. Three questions with three different right answers.
      await run(service.withdraw(String(original["id"]), { effectiveAt: FEB, recordedAt: MAR }, "Subject withdrew", ctx));

      // Asked on 20 February: the withdrawal had not been recorded, so a decision made then
      // relied on a live grant and stays explainable.
      expect((await run(service.effectiveAt(selector, { validAt: FEB_15, knownAt: FEB_20 }, ctx)))?.grant).toBe(original["id"]);
      // Asked on 5 March about the same moment: now we know, so the answer changes.
      expect(await run(service.effectiveAt(selector, { validAt: FEB_15, knownAt: MAR_05 }, ctx))).toBeNull();
      // Asked on 5 March about January: the withdrawal took effect in February, so January
      // was permitted and a backdated withdrawal does not reach further back than it says.
      expect((await run(service.effectiveAt(selector, { validAt: JAN_15, knownAt: MAR_05 }, ctx)))?.grant).toBe(original["id"]);
      // Present tense defaults knowledge to the same instant.
      expect(await run(service.effectiveAt(selector, { validAt: MAR_05 }, ctx))).toBeNull();

      // F93-02: withdrawal preserves history rather than deleting it. Datetimes are compared
      // as instants, because the codec owns their serialized spelling and this is not a test
      // of that spelling.
      const instant = (value: unknown) => Date.parse(String(value));
      expect(instant((await call("ConsentGrant.get", { id: original["id"] }))["validFrom"])).toBe(Date.parse(JAN));
      const disposition = await call("ConsentDisposition.find.byGrant", { params: { grant: original["id"] } });
      expect(disposition["withdrawn"]).toBe(true);
      expect(instant(disposition["effectiveAt"])).toBe(Date.parse(FEB));
      expect(instant(disposition["recordedAt"])).toBe(Date.parse(MAR));
      // One terminal fact only: a second disposition loses atomically.
      await expect(run(service.withdraw(String(original["id"]), { effectiveAt: MAR, recordedAt: MAR }, "Again", ctx))).rejects.toThrow();

      // A fresh grant after withdrawal is a new fact, and re-consent works.
      const renewed = await run(service.grant({ ...selector, validFrom: MAR, recordedAt: MAR }, ctx));
      expect((await run(service.effectiveAt(selector, { validAt: MAR_05 }, ctx)))?.grant).toBe(renewed["id"]);
      // Two grants cannot claim the same subject/purpose/activity/scope/start.
      await expect(run(service.grant({ ...selector, validFrom: MAR, recordedAt: MAR }, ctx))).rejects.toThrow();

      // A disposition must either withdraw or hand over; it cannot do neither.
      const successor = await run(service.grant({ ...selector, validFrom: "2026-04-01T00:00:00Z", recordedAt: MAR }, ctx));
      await expect(call("ConsentDisposition.create", {
        grant: renewed["id"], replacement: null, withdrawn: false,
        effectiveAt: MAR, recordedAt: MAR, reason: "Neither",
      })).rejects.toThrow();
      // A replacement must be the same subject, purpose and activity, and start where this ends.
      await expect(run(service.supersede(String(renewed["id"]), String(successor["id"]), { effectiveAt: MAR, recordedAt: MAR }, "Wrong boundary", ctx))).rejects.toThrow();
      await run(service.supersede(String(renewed["id"]), String(successor["id"]), { effectiveAt: "2026-04-01T00:00:00Z", recordedAt: MAR }, "Renewed", { ...ctx, idempotencyKey: "supersede" }));
      await run(service.supersede(String(renewed["id"]), String(successor["id"]), { effectiveAt: "2026-04-01T00:00:00Z", recordedAt: MAR }, "Renewed", { ...ctx, idempotencyKey: "supersede" }));
      expect((await run(service.effectiveAt(selector, { validAt: "2026-04-15T00:00:00Z" }, ctx)))?.grant).toBe(successor["id"]);

      // An expiry needs no disposition at all.
      const bounded = { ...selector, scope: await keyed("ConsentScope", "telemetry") };
      const expiring = await run(service.grant({ ...bounded, validFrom: JAN, validUntil: FEB, recordedAt: JAN }, ctx));
      expect((await run(service.effectiveAt(bounded, { validAt: JAN_15 }, ctx)))?.grant).toBe(expiring["id"]);
      expect(await run(service.effectiveAt(bounded, { validAt: FEB }, ctx))).toBeNull();
      await expect(run(service.grant({ ...bounded, validFrom: FEB, validUntil: JAN, recordedAt: JAN }, ctx))).rejects.toThrow();

      // Tenant isolation.
      expect(await run(service.effectiveAt(selector, { validAt: JAN_15 }, { ...ctx, tenant: "other" }))).toBeNull();
    } finally {
      await f.close();
    }
  });
