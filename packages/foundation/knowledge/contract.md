# Knowledge

Implements issue #64 over Artifact, Specification, Classification, Publication, Entitlement and Evaluation. KnowledgeItem is an immutable library identity with a required access right/scope; KnowledgeRevision pins exact specification, artifact content, assessment definition and classification meaning. Synthetic SupportArticle, StandardOperatingProcedure and TrainingMaterial consumers demonstrate the three requested domains. No CMS layout, search index, collaboration engine or notification delivery is introduced.

## Immutable editions

`Knowledge.createRevision(input, context)` creates a successor or initial revision. Unique item/revision and predecessor claims prevent divergent successor chains. Classification snapshots contain 1–16 immutable ClassificationAssignment links; each resolves its exact ConceptRevision, never a floating latest concept. Duplicate meanings fail validation. Creating a snapshot can leave unselected immutable nodes if the final revision conflicts; these nodes have no edition authority. With an idempotency key, snapshot stages use stable depth keys and changed inputs conflict.

`meanings(revision, context)` reads the bounded snapshot. Subsequent concept edits, retirement, supersession or assignment retraction do not erase the historical meaning of an existing revision. New knowledge revisions explicitly choose new assignment pins. Artifact content must pin the same SpecificationPin as the knowledge revision; editing content requires a new revision.

`publish(revision, releaseAudienceLink, context)` requires a validated Published release from Publications and exact matching artifact/specification pins. The resulting KnowledgePublication is the edition and retains the typed audience link. `history(edition, context)` remains available under normal authorization after retirement and returns the edition, exact revision/meanings and authoritative publication status. It fails closed for raw staged Releases without published authority. Publication deprecation/retirement composes the existing Publication journal rather than introducing a second competing lifecycle.

## Access and content

`resolve(edition, {entitlement, participation}, context)` uses the runtime clock, not a caller-selected historical instant. It checks publication is not retired, the edition already exists, the supplied Entitlement has the item's exact right/scope and remains effective, and the holder has an effective Participation in the pinned audience. Hidden terminal revocation facts fail closed. Deprecated editions remain accessible with a Deprecated status; retirement blocks access while preserving history.

`download` performs the same checks and calls Artifacts.download, preserving current artifact inspection and governance. Business entitlement/audience checks do not establish that the caller represents the holder Party. The application must independently authorize Party representation and resource access through Gatekeeper; arbitrary client-supplied entitlement IDs must never be trusted as authentication. Direct low-level metadata/artifact surfaces also need application policy. Revocation checks use the observed runtime snapshot and do not claim a serializable lock against an external concurrent revocation. Downloads retain normal signed-URL lifetime semantics.

## Feedback

`feedback(edition, run, context)` binds an EvaluationRun to the exact published edition and revision before observed execution. The run must use the edition's pinned assessment definition. `finishFeedback(feedback, finish, context)` accepts only that run's finish; declared execution time may not precede the edition binding. A run or finish cannot be attached twice. Completion, failure and cancellation remain Evaluation outcomes, not an invented universal reader score. Domain-specific ratings or findings belong in typed satellites. Feedback started before retirement may finish afterward, preserving its historical target; retired editions reject new helper-created feedback.

EvaluationStart timing is an executor-supplied business timestamp. Raw write authorities must be restricted appropriately; these helpers do not turn untrusted executor claims into proof of actual execution. All reads/writes use ordinary Engine.call, with tenant, policy, suppression and fence behavior intact.

## Verification

Nine generated tests pass on memory, SQLite and isolated local PostgreSQL 17: downloaded Artifact bytes, exact specification/content and taxonomy revision retention, successor race, all three domain fixtures, cross-tenant rejection, immutable history, entitlement revocation, specifically hidden revocation reads, denied revision creation, independent audience membership, retirement history, and exact-run feedback rejection/acceptance. Runtime typecheck, Forge formatting and deterministic repeat consumer generation pass.

```sh
cargo run -q -p forgegraph-cli -- build packages/foundation/knowledge/fixtures/consumer --out /tmp/forge-knowledge-consumer
FORGE_FOUNDATION_CONSUMER=/tmp/forge-knowledge-consumer pnpm --filter @forgegraph/runtime exec vitest run test/foundation-knowledge.test.ts
# FORGE_FOUNDATION_PG_URL adds isolated PostgreSQL schema tests.
pnpm --filter @forgegraph/runtime typecheck
```

Live D1 and DynamoDB are not verified; local evidence permits development composition, not provider certification. The consumer fixtures are synthetic examples, not claims of application dogfooding.
