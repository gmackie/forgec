import { foundation, foundationAdapters } from "./helpers/foundation.js";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Effect } from "effect";
import { expect, it } from "vitest";
import { Consent, type ConsentSelector } from "../src/foundation/consent.js";
const prefix = "@forgegraph/foundation/consent/_/";
const consumer = "@foundation-probe/consent-consumers/_/";
const ctx = { tenant: "acme", actor: "user", requestId: "consent-consumer" };
const JAN = "2026-01-01T00:00:00Z", FEB = "2026-02-01T00:00:00Z", FEB_15 = "2026-02-15T00:00:00Z";
const MAR = "2026-03-01T00:00:00Z";

for (const adapter of foundationAdapters)
  it(`${adapter}: intake produces consent, a policy reads it, preferences stay separate`, async () => {
    const f = await foundation("consent", adapter, true);
    const engine = f.engine;
    try {
      const call = (op: string, input: Record<string, unknown>, context = ctx) =>
        Effect.runPromise(engine.call(op, input, context));
      const run = Effect.runPromise;
      const service = new Consent(engine);
      const keyed = async (resource: string, key: string) =>
        String((await call(prefix + `${resource}.create`, { key, label: key })).id);

      const subject = await call(prefix + "ConsentSubject.create", { label: "Ada" });
      const person = await call(consumer + "PersonRecord.create", { name: "Ada Lovelace", consents: subject.id });
      const selector: ConsentSelector = {
        subject: String(subject.id),
        purpose: await keyed("ConsentPurpose", "research"),
        activity: await keyed("ProcessingActivity", "share"),
        scope: await keyed("ConsentScope", "health-records"),
      };

      // F93-06: an intake form produces a grant and owns none of it. The submission keeps its
      // own identity and answers; the permission is the grant, which it can only point at.
      const grant = await run(service.grant({ ...selector, validFrom: JAN, recordedAt: JAN }, ctx));
      const submission = await call(consumer + "ResearchIntakeSubmission.create", {
        person: person.id, formVersion: "v3", submittedAt: JAN, produced: grant["id"],
      });
      expect(Object.keys(submission).sort()).toEqual(["formVersion", "id", "person", "produced", "submittedAt"]);
      // One submission per grant: a form cannot be replayed into two permissions.
      await expect(call(consumer + "ResearchIntakeSubmission.create", {
        person: person.id, formVersion: "v3", submittedAt: JAN, produced: grant["id"],
      })).rejects.toThrow();

      /**
       * F93-05: consent used as a policy information point. This is the PIP *pattern* over the
       * substrate — a decision function reads consent as one input and records which grant it
       * relied on — not an integration into `src/gatekeeper.ts`, which this package does not
       * touch. Recording the grant is what keeps the decision explainable after a withdrawal.
       */
      const decide = async (at: string) => {
        const state = await run(service.effectiveAt(selector, { validAt: at, knownAt: at }, ctx));
        return call(consumer + "AccessDecision.create", {
          person: person.id, relied: state?.grant ?? null, permitted: state !== null,
          decidedAt: at, reason: state ? "consent in force" : "no consent recorded",
        });
      };
      const permitted = await decide(FEB_15);
      expect(permitted).toMatchObject({ permitted: true, relied: grant["id"] });

      // After a withdrawal the same question answers differently, and the earlier decision
      // still names the grant it relied on rather than being rewritten.
      await run(service.withdraw(String(grant["id"]), { effectiveAt: MAR, recordedAt: MAR }, "Withdrew", ctx));
      const refused = await decide("2026-03-15T00:00:00Z");
      expect(refused).toMatchObject({ permitted: false, relied: null });
      expect(await call(consumer + "AccessDecision.get", { id: permitted.id })).toMatchObject({
        permitted: true, relied: grant["id"],
      });

      // F93-07: a notification preference is a different fact with a different lifecycle.
      // Muting a channel does not touch consent, and withdrawing consent does not mute.
      await call(consumer + "MarketingPreference.create", { person: person.id, channel: "email", enabled: false });
      const preference = await call(consumer + "MarketingPreference.find.byPersonChannel", {
        params: { person: person.id, channel: "email" },
      });
      expect(preference["enabled"]).toBe(false);
      // The preference carries no reference to a grant at all, which is what keeps them apart.
      expect(Object.keys(preference)).not.toContain("grant");
      expect((await run(service.effectiveAt(selector, { validAt: FEB }, ctx)))?.grant).toBe(grant["id"]);
    } finally {
      await f.close();
    }
  });

/**
 * F93-07, checked structurally as well as behaviourally: no notification or preference concept
 * may become a consent fact. Consent says what a subject permitted; whether they want an email
 * about it is a preference, and the moment one of those words appears as a field here the two
 * have been conflated in the schema rather than only in someone's head.
 */
it("declares no notification, preference or authorization mechanics", () => {
  const bundle = JSON.parse(
    readFileSync(resolve(import.meta.dirname, "../../../conformance/fixtures/consent/app.json"), "utf8"),
  ) as { contracts: { resources: { name: string; fields?: { name: string }[] }[] } };
  const foreign = /subscription|preference|channel|notify|notification|unsubscribe|permission|role|grantee.*role/i;
  const offending = bundle.contracts.resources.flatMap((r) =>
    (r.fields ?? []).filter((field) => foreign.test(field.name)).map((field) => `${r.name}.${field.name}`),
  );
  expect(offending).toEqual([]);
  expect(bundle.contracts.resources.map((r) => r.name).sort()).toEqual([
    "ConsentBasis", "ConsentCounterparty", "ConsentDisposition", "ConsentEvidence",
    "ConsentGrant", "ConsentPurpose", "ConsentScope", "ConsentSubject", "ProcessingActivity",
  ]);
});
