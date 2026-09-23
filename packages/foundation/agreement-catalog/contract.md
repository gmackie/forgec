# Agreement / Catalog

Implements issue #43: immutable catalogs, catalog entries, versioned offers, accepted agreements, signatory/term links and issuance of typed rights and duties. The synthetic consumer contains all four requested domain wrappers: SaaSSubscription, CourseEnrollment, LabServiceOrder and VendorContract. None claims application-repository dogfooding.

## Pinned composition

CatalogEntry pins a SpecificationPin describing the service. Offer independently pins its terms SpecificationPin, optional ArtifactRevision document, EvidenceSeal, EvaluationFinish, supplier Party, EntitlementScope and optional RightDefinition/RequirementDefinition. A document must pin exactly the terms revision. Offer revisions form immutable predecessor chains with unique revision and successor claims; publishing a revision never rewrites an existing offer or agreement. Evaluation completion is supporting execution evidence, not an approval verdict.

`AgreementCatalog.publish(input, context)` publishes an offer. `select(offer, decisionCase, approvedOption, context)` records OfferQualification before any responses. The immutable unique DecisionCase link prevents reuse for another offer; interpreted acceptance also checks the qualification timestamp precedes the first response. `qualify` reads a fully validated Decision outcome. `accept(input, context)` requires that exact qualification and expected terms/document, both distinct Party signers' Participation records, and both signers' active Decision responses selecting the approved option. Parties must share a ParticipationSet. The schema verifies signer identity and temporal eligibility at server acceptance time, offer validity and exact pins. Known ParticipationEnd facts are captured at acceptance; later backdated ends do not rewrite this knowledge snapshot.

The supplied acceptanceKey is durable logical command identity. Concurrent retries return one agreement or a conflict; changed acceptance inputs conflict. The caller's claimed Party representation still needs independent application authorization. Participation and Decision responses are business facts, not authorization credentials.

## Acceptance and resumable issuance

Agreement acceptance is immutable and inspectable before issuance. `issue(agreement, context)` creates the two AgreementParticipant links, AgreementTermLink, at most one unquantified customer Entitlement and one customer Obligation, their typed links, and finally AgreementIssued. This is a deliberately bounded first version: applications needing multiple grants or quantities must compose additional domain facts rather than encode arbitrary payloads.

Each mutation uses normal Engine.call, with deterministic receipt keys derived from immutable agreement identity and stage. No custom storage commit or authorization bypass exists. An interrupted stage is resumable, including grant-created/link-not-created failures. Concurrent retries cannot duplicate grants under the runtime's atomic receipt contract. Receipts used by incomplete issuance must be retained; deleting them before recovery removes that guarantee. After completion, unique linked records prevent reissuance. A new authorized issuer can resume without changing the accepted fact's attribution.

This is **not** an all-or-none transaction. Substrate grants and duties can become visible while AgreementIssued is absent. `state` reports PendingIssuance, and `rightsAt` returns no agreement-mediated rights until issuance is complete. Applications must use `rightsAt` when an agreement governs access. Direct Entitlements queries describe independent substrate facts, not complete agreement effectiveness. Completion does not silently imply payment or discharge.

## Validity and lifecycle

`state(agreement, at, context)` returns NotAccepted, PendingIssuance, Scheduled, Active, Expired, Suspended or Terminated with immutable history and issuance status. Dates are strictly decoded; validity is half-open. Hidden journal, completion or referenced rows fail closed. `rightsAt` also respects an EntitlementEnd fact.

`transition(agreement, Suspended|Resumed|Terminated, reason, context)` appends one of at most 32 lifecycle events. Unique `(agreement, ordinal)` and unique previous-event claims arbitrate concurrent commands. Schema rules reject skipped ordinals, duplicate suspension, resume without suspension, and any successor of termination. Commands that race may validly serialize if the later command reads the new head; callers must reread after conflicts.

Suspension and termination stop agreement-aware rights without silently revoking independent Entitlement records or cancelling Obligation facts. Duties remain inspectable. Issuance is fulfillment of accepted rights/duties and may finish after suspension or termination; such completion cannot reactivate agreement-aware rights. This preserves an explicit recovery path for partial issuance. Applications own settlement, cancellation and external actions.

Renewal and amendment create separate Agreement records with a new offer, fresh bound Decision approval, unique predecessor and explicit change kind. Renewal starts at or after predecessor expiry. Amendment may overlap, and does not implicitly terminate its predecessor; the application explicitly transitions the old agreement. Both histories and exact term pins remain intact.

Raw Agreement rows are accepted records only after validated interpretation; an authorized raw insert with invalid qualification/signatures fails closed in state/issue. Restrict raw command surfaces appropriately. This package does not provide an arbitrary commercial policy language, pricing or legal enforceability.

## Verification

Generated consumer tests pass on memory, SQLite and local PostgreSQL 17 (12 cases): immutable term/artifact pins, Evidence/Evaluation support, competing acceptance and issuance, no duplicate rights/duties, interrupted grant/link recovery, changed issuer retry, all four domain wrappers, missing signer, expiry, suspension/resume/termination, renewal and amendment, tenant rejection, denied writes and specifically hidden lifecycle reads.

```sh
cargo run -q -p forgegraph-cli -- build packages/foundation/agreement-catalog/fixtures/consumer --out /tmp/forge-agreement-consumer
FORGE_FOUNDATION_CONSUMER=/tmp/forge-agreement-consumer pnpm --filter @forgegraph/runtime exec vitest run test/foundation-agreement-catalog.test.ts
# Set FORGE_FOUNDATION_PG_URL to add isolated PostgreSQL schema tests.
pnpm --filter @forgegraph/runtime typecheck
```

Forge formatting checks and byte-identical repeat consumer builds pass. F43-STORE remains planned: local PostgreSQL and SQLite evidence does not establish live D1 or DynamoDB behavior. Local evidence permits further development composition, not production provider certification.
