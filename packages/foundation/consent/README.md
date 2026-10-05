# Consent (experimental)

ConsentSubject is an application-owned typed sidecar, so consent belongs to whatever the
application treats as a person rather than to a Party type this package would have to define.
ConsentGrant, ConsentEvidence and ConsentDisposition are append-only facts.

`Consent` from `@forgegraph/runtime` grants, evidences, withdraws, supersedes and answers
`effectiveAt`. The application invokes these behind its own authenticated, authorized surface;
this package generates no HTTP routes. Normal Engine authorization still applies.

**Consent is not authorization.** A policy engine may read these facts as one input to a
decision, but nothing here grants access, and a null result means no permission was recorded —
which is not the same as a denial. Consent is also not an agreement, an entitlement or a
notification preference: an unsubscribed newsletter says nothing about research consent, and a
contract that permits processing is a different fact with a different lifecycle. A test asserts
structurally that no subscription, channel or permission field has appeared in this contract.

Purpose, activity and scope are three independent axes. Agreeing to *store* for *research* is
not agreeing to *share*, and not agreeing to store for *marketing*. Uniqueness is subject +
purpose + activity + scope + validFrom, so two grants cannot claim the same start.

## The two time axes

`validFrom`/`validUntil` is when the subject's permission applies. `recordedAt` is when this
instance learned of it. They differ whenever a paper form is entered late or a withdrawal is
backdated, and that difference is the point: a decision made last Tuesday has to be explainable
with what was known last Tuesday.

So `effectiveAt(selector, { validAt, knownAt })` counts a grant only when it was in force at
`validAt` *and* already recorded by `knownAt`, and a disposition suppresses it under exactly the
same two tests. A subject withdrawing on 1 March backdated to 1 February produces three
different correct answers:

| asked | about | answer |
| --- | --- | --- |
| 20 February | 15 February | permitted — the withdrawal was not yet recorded |
| 5 March | 15 February | not permitted — now we know, and it applied |
| 5 March | 15 January | permitted — the withdrawal reaches back only to 1 February |

This is a bounded interpretation built from ordinary fields, not an L0 temporal facet.
ConceptIR #75 is what would make valid and knowledge time a language-level axis; until then the
convention lives in this package and the query that reads it lives in the runtime service.

Withdrawal preserves history — a withdrawn grant remains, which is what makes the table above
answerable at all. A terminal disposition is unique per grant, so conflicting withdrawals fail
atomically, and it must either withdraw or hand over to a replacement rather than doing neither.
A replacement shares the subject, purpose and activity, starts strictly later, and takes effect
at its own start. Expiry needs no disposition.

Run `node scripts/verify-foundation.mjs --suite local --package consent`. Tests use generated
bundles on memory and SQLite, covering axis independence, evidence, the three bitemporal
questions, withdrawal and re-consent, supersession boundaries, idempotent replay, expiry and
tenant isolation. All eight issue criteria have executable local evidence in `contract.json`.

**On F93-05:** the consumer fixture demonstrates the policy-information-point *pattern* over
this substrate — a decision function reads consent as one input and records which grant it
relied on, so the decision stays explainable after a withdrawal. It is not an integration into
`packages/runtime/src/gatekeeper.ts`, which this package does not touch. Fixtures are synthetic,
not production adoption, and hosted provider certification is separate and not claimed.
