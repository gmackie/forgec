# Classification

This package owns business taxonomy and classification facts. It does not create governance `dataClass` declarations or confer authorization.

Taxonomy is append-only. Concept has stable identity, an immutable taxonomy/ordinal/identifier set, and audited kernel containment. Parent references must stay within the taxonomy. ConceptRevision preserves exact label, definition and historical parent meaning; its taxonomy and ordinal snapshots are checked against immutable Concept fields. Revision numbering is strictly increasing along each predecessor chain, but gaps and explicit branches are permitted. `(concept, revision)` is unique. No implicit latest revision exists.

ConceptDisposition is an append-only, unique terminal fact: null replacement retires a concept; a replacement pins a specific meaning in the same taxonomy. Successors must have a higher immutable taxonomy-local ordinal, preventing supersession cycles without unsafe graph prechecks. Ordinals are administrative successor order, not display order. This initial profile cannot supersede a concept with an older ordinal; use a newly registered successor instead. Retirement/supersession does not erase historical assignments or silently retarget aliases.

ConceptAlias is unique by taxonomy and normalized alias and pins one exact meaning. IdentifierSet links support separately qualified external codes. ClassificationSet is an application-owned sidecar target; ClassificationAssignment pins ConceptRevision, with append-only ClassificationRetraction preserving correction history. Assignments are historical assertions, so recording a past meaning remains allowed after retirement. This API does not assert that an assignment is currently eligible: callers inspect `Classification.status(concept, at)` when that distinction matters. The resolver authorizes both the assignment and meaning through Engine. Terminal status lookup fails closed on unreadable terminal facts.

The typed consumer fixture covers KnowledgeArticle, Product, RiskScenario and JobFamily without generic target IDs.

## Verification

```sh
cargo run -q -p forgegraph-cli -- check packages/foundation/classification/fixtures/consumer
cargo run -q -p forgegraph-cli -- build packages/foundation/classification/fixtures/consumer --out /tmp/foundation-classification-test
FORGE_FOUNDATION_FIXTURE=/tmp/foundation-classification-test pnpm --filter @forgegraph/runtime exec vitest run test/foundation-classification.test.ts
```

Tests execute generated bundles on memory and transactional SQLite through the D1 adapter. They cover same-taxonomy hierarchy, concurrent opposing moves, cross-tenant references, normalized aliases, external identifiers, immutable meaning after revision/hierarchy changes, supersession/revocation races, invalid successors and retraction retention. SQLite evidence does not certify live providers.

Kernel expressions currently hydrate one-hop references; explicit validated snapshots avoid depending on unsupported multi-hop hydration. Nullable arithmetic is avoided because rule evaluation is eager. No provider-specific semantic workaround is used. Shared evidence/catalogs, fixture refresh and runtime exports belong to the integrator; acceptance entries remain planned pending registered evidence.
