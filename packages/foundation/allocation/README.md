# Allocation

This initial profile owns immutable exclusive/fungible pools, inert reservation candidates and an append-only pool journal. Units are exact and domain-defined; quantities use six fractional digits and BigInt comparison/sweep arithmetic. Exclusive capacity is exactly one. Reservations specify half-open booking windows and an explicit hold expiry. WorkQueue leases have no role in business capacity ownership.

## Atomicity and authority

The unique `(pool, ordinal)` journal entry is **both the capacity guard and the claim/transition**. The helper reads and validates the full chain, computes the next transition, then creates that single row through normal Engine.call authorization, validation, unique claims and commit. Competing commands cannot publish the same next ordinal. A loser rereads the accepted chain and recomputes capacity. No pre-write count is treated as the guard, no direct planFor mutation is used, and no multi-plan transaction is claimed. A unique `(pool, commandKey)` additionally preserves command replay. The helper consumes context idempotencyKey as this durable command identity; it intentionally does not reuse the kernel receipt key for retry-dependent ordinal/time payloads.

Raw AllocationReservation and AllocationJournal resources are **candidate facts, not consumable authority**. Only `Allocations.inspect` and successful validated command results establish the bounded journal interpretation. Every consuming path enumerates the complete pool partition internally, authorizes each journal/reservation through Engine.get, enforces exact contiguous links and command transitions, and recomputes the overlapping quantity invariant at every step. A malicious raw oversubscription, gap, fork or invalid transition poisons that pool: reads and later commands fail closed instead of reporting usable capacity. Domain consumers must never equate a raw `.create` response or raw row list with a granted reservation. Access policy should reserve journal creation for the trusted command host. Direct adapters/administrative migration remain trusted boundaries.

The single-row gate is verified through actual memory and transactional SQLite/D1-adapter commits. It does not establish general staged-reference/read-overlay K-atomic semantics, multi-pool scheduling, or live D1/PostgreSQL/Dynamo certification. Those remain explicit integration gates. A pool has at most 512 journal entries; reaching the bound fails before writing. Pool rotation/migration needs an external controlled procedure; history is never silently compacted or erased.

## Lifecycle and time

`act(candidate, "reserve")` atomically admits a hold. `allocate` converts an unexpired hold to ownership. `release` ends allocated ownership; `cancel` ends a held reservation; `expire` records an elapsed hold. Terminal operations cannot return capacity twice. Repeat commands return the existing validated journal entry; reusing a caller key for a different reservation/action fails. A replay is historical command acknowledgement, not proof that the claim is still live—read current authority before consumption.

The injected kernel Clock supplies command time. The journal requires monotonic time and rejects future-authority rows at consumption. Host clocks must obey the kernel's trusted-clock contract; this implementation does not establish a distributed clock synchronization guarantee. Expired holds stop consuming capacity even before an explicit expiry entry. Allocated claims remain bounded by their booking window, independent of hold expiration. Capacity sweep processes interval ends before starts, permitting adjacent bookings.

`inspect(pool, instant)` projects **current ownership onto a booking instant**, returning available quantity, claims and the observed journal head. It is not historical ownership reconstruction after release or a promise that availability stays unchanged after returning. To claim capacity, use `act`; never check available then insert independently. All-or-none multi-pool reservations are not implemented here.

## Verification

```sh
cargo run -q -p forgegraph-cli -- check packages/foundation/allocation/fixtures/consumer
cargo run -q -p forgegraph-cli -- build packages/foundation/allocation/fixtures/consumer --out /tmp/foundation-allocation-test
FORGE_FOUNDATION_CONSUMER=/tmp/foundation-allocation-test pnpm --filter @forgegraph/runtime exec vitest run test/foundation-allocation.test.ts
```

Generated consumers cover RunnerGpu, HospitalBed and MachineCapacity. Tests verify competing claims, exact fungible capacity, adjacent intervals, release replay, expiry/cancellation races, malformed raw candidate rejection, immutable history, restart and tenant/authorization boundaries on memory and SQLite. Live-provider acceptance F34-05 remains planned. Root owns fixture refresh, exports, runner registration and evidence publication.
