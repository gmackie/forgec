# Place

`Place` owns stable business location identity and a kernel `@hierarchical` containment tree. Its IdentifierSet is immutable. Moves use versioned `.move` operations; kernel audit entries retain committed create/update history. Parent references remain tenant-scoped, and cycle prevention is checked at commit. Address and timezone are separate append-only revision resources, allowing addressless locations and preserving prior values.

Address/timezone revisions have a unique `(place, revision)` identity and a validated, strictly earlier predecessor from the same Place. Revisions need not be consecutive; callers explicitly pin the desired revision. Two writers cannot create the same revision. This profile does not elect a mutable latest pointer or claim a single successor per predecessor.

The consumer fixture includes Facility/Room, CustomerSite and WarehouseLocation. Room's facility relation is validated when the domain fact is created; later Place moves do not rewrite this historical domain fact. Applications that require a live room/facility invariant must coordinate those operations in a domain command.

## Verification

From repository root:

```sh
cargo run -q -p forgegraph-cli -- check packages/foundation/place/fixtures/consumer
cargo run -q -p forgegraph-cli -- build packages/foundation/place/fixtures/consumer --out /tmp/foundation-place-test
FORGE_FOUNDATION_FIXTURE=/tmp/foundation-place-test pnpm --filter @forgegraph/runtime exec vitest run test/foundation-place.test.ts
```

The suite uses generated runtime surfaces against memory and a transactional SQLite executor for the D1 adapter. It checks moves, opposing concurrent moves, restricted deletion, tenant references, typed consumers, immutable revisions, unique revision races and audit history. This is not live D1/PostgreSQL/DynamoDB certification. The timezone invalid-value assertion intentionally requires kernel timezone validation; a string-only codec fails this suite and must not be reported as supported.

`contract.json` acceptance remains planned until the shared evidence verifier records the implementation and provider results. Root integration owns fixture generation, package verifier registration and exports.
