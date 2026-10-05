# Publication

Implements issue #48 with exact SpecificationPin and ArtifactRevision releases, fixed qualification policies, typed ParticipationSet audiences, durable promotion history, deprecation and retirement. Synthetic SoftwareRelease, ModelRelease, RecipePublication and DocumentPublication wrappers demonstrate all four domains. Publication never asserts deployment, installation, physical realization or delivery.

## API and pins

`Publications.register(input, context)` creates an immutable ReleaseCandidate under a PublicationSeries with a unique version. Its ArtifactRevision must pin exactly the candidate SpecificationPin. Optional supporting EvidenceSeal is validated. Policies are finite: None, EvaluationCompleted, DecisionApproved, Both. Their selected evaluation definition and DecisionCase/approved option are pinned before qualification. `candidatePhase` reports Proposed, Qualifying, Qualified or Rejected.

`attachEvaluation(candidate, run, context)` binds an EvaluationRun uniquely to a candidate before an observed start or finish. The run must use the pinned evaluation definition. Qualification also verifies that the run's declared startedAt is not before the attachment timestamp. EvaluationStart has a business timestamp rather than server creation time; execution timing remains a trusted executor assertion. Successful operational completion is the EvaluationCompleted gate; this is not an implicit domain verdict. Applications requiring a business verdict select DecisionApproved/Both and enforce their domain decision policy.

A selected Decision must have no responses when the candidate is registered. Validated qualification replays Decision state and checks its exact outcome, expected option and candidate timestamp preceding its first journal event. `qualify(candidate, {evaluation?, decision?}, context)` records the immutable qualifying fact after validating every selected gate. Failed, mismatched, absent or unreadable gates reject publication. Gates are revalidated when reading authoritative releases, including raw qualification rows.

`publish(candidate, channel, context)` stages an immutable Release retaining exact pins and then appends Published. A raw Release row is a staged record, not proof of publication. `release(id, context)` returns null until its Published event exists. `promote(release, channel, reason, context)` changes discovery and records history; `transition(release, Deprecated|Retired, reason, context)` preserves all content and qualification pins.

## Serialization and discovery

A PublicationSeries is bounded to 128 journal events. Promotion is the append-only journal resource for Published, Promoted, Deprecated and Retired events. Unique `(series, ordinal)` and previous-event claims serialize all channel/lifecycle changes in a series. Schema rules enforce consecutive same-series references; validated replay enforces publication before promotion, one publication per release, no promotion of deprecated releases and no transitions after retirement. All operations use the normal Engine.call authorization/purpose/tenant/fence pipeline.

Channel identities and ParticipationSet audiences are immutable. Their mutable discovery head is derived from the journal, not a separately updated pointer. Thus history cannot commit without its channel change, and promotion cannot race past retirement when both commands read the same head. A race may validly serialize if the later command observes the newer head. No cross-resource transaction is claimed. Failed commands may leave unselected Release rows, which remain unpublished.

`channel(id, context)` exposes current release and status. A deprecated release remains discoverable with its status; a retired release yields no active release while retained history still identifies it. `state(series, context)` replays the complete bounded journal and fails closed if any existing required row is hidden. Invalid authorized raw events can poison a series; consumers must use validated helpers and applications must restrict direct command authority.

`audience(promotion, context)` creates an idempotent ReleaseAudienceLink snapshot of the channel's typed audience. The channel itself already pins the audience at publication/promotion; this extra satellite may be created later. Audience membership is not authorization, and a ParticipationSet reference alone does not prove an actor can download content. Applications separately enforce their audience and access policies.

With an idempotency key, journal commands retain a unique commandKey. Same-input retry replays the original authorized operation; changed input is rejected. Staged release creation also has a deterministic candidate receipt. Keys are tenant command identities and must not be reused for unrelated commands. Replay is under current authority. Keep staged-operation receipts until recovery completes.

## Verification

Generated consumer tests run on memory, SQLite and isolated local PostgreSQL 17: all four policies, failed gates, exact pins, channel discovery, four domain wrappers, idempotent publication, promotion/retirement concurrency, raw ordinal rejection, immutable releases, deprecation, tenant isolation, specifically hidden journal reads and denied transitions. Repeated artifact generation is deterministic; Forge formatting and runtime typecheck pass.

```sh
cargo run -q -p forgegraph-cli -- build packages/foundation/publication/fixtures/consumer --out /tmp/forge-publication-consumer
FORGE_FOUNDATION_CONSUMER=/tmp/forge-publication-consumer pnpm --filter @forgegraph/runtime exec vitest run test/foundation-publication.test.ts
# FORGE_FOUNDATION_PG_URL adds isolated PostgreSQL traces.
pnpm --filter @forgegraph/runtime typecheck
```

F48-STORE remains planned because live D1 and DynamoDB are unverified. Local PostgreSQL and SQLite evidence supports development composition only, not complete provider certification. The fixtures are synthetic contract examples, not application dogfooding.
