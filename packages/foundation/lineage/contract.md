# Lineage substrate contract

Experimental `@forgegraph/foundation/lineage` 0.1.0 implements #37. Direct dependency:
Specification, explicitly co-deployed. Domain artifacts/execution records reference
LineageNode/Transformation through typed satellites; no upward imports are added.

## Contract refinement

Immutable graph-local topological ranks replace the earlier serialized graph-guard
proposal. Raw relation rules enforce source.rank < target.rank and same graph;
transformation members enforce input.rank < transformation.rank < output.rank.
A cycle therefore cannot emerge from concurrent insertions, without query-only
cycle detection or a mutable graph revision. Rank reassignment is unsupported.

TransformationSeal uniquely pins bounded immutable membership-chain heads.
Input/output candidates outside those heads never become authoritative provenance.
Superseding relations retain endpoints/graph, increase revision and uniquely identify
a predecessor. Traversal returns historical records and explicit supersededBy links;
there is no silent rewriting of old provenance or inferred pairwise transform edge.

## Acceptance

Every #37 checkbox in contract.json has local evidence from four generated-consumer
tests across memory and SQLite in `foundation-lineage.test.ts`. Tests cover software
build, manufacturing batch, dataset transform and LevelForge-style generation, typed
execution detail, exact specification pins, sealed membership, concurrent seal
conflict, raw rank/graph/depth/revision rejection, true traversal-depth/fanout budgets
and governed completeness. Hosted provider certification is not claimed.

```sh
target/debug/forgec build packages/foundation/lineage/fixtures/consumer --out /tmp/foundation-lineage-consumer
FORGE_FOUNDATION_CONSUMER=/tmp/foundation-lineage-consumer pnpm --filter @forgegraph/runtime exec vitest run test/foundation-lineage.test.ts
```

See README.md for rank planning, correction semantics and conservative denial of
hidden candidate links. Shared fixture/verifier registration is integrator-owned.
