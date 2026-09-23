# Party substrate contract

Implemented experimental `@forgegraph/foundation/party` version `0.1.0`, issue #52.
Local acceptance covers generated memory/SQLite runtimes, not hosted provider certification.

## Ownership and identity

Party is an append-only tenant-scoped business actor with an optional unique
Identifiers.IdentifierSet sidecar. PrincipalRepresentation records many-to-many
principal/Party associations, half-open validity, recorded actor and reason.
RepresentationRevocation is a unique append-only terminal fact. Person, Organization,
Customer and Worker are typed consumer satellites. No universal EntityRef or
inheritance hierarchy is introduced.

The principal is an external authentication identifier scoped by tenant. Its removal
cannot cascade into Party or erase business history; external deprovisioning must
explicitly record representation revocation. Representation never grants authority.

## Composition and operations

Direct dependency: `identifiers`, explicitly co-deployed with `deploy = true`.
`Parties` exposes create, represent, revoke and paginated listRepresentedAt operations
through Engine. Lists preserve cursors even for empty filtered pages. Existing
revocation facts and referenced Party reads must be authorized; unreadable terminal
history is never treated as absent. Different-start overlapping representations are
permitted and are separate facts; callers needing a set deduplicate Party IDs.

## Verification

All six F52 acceptance criteria in `contract.json` link to
`packages/runtime/test/foundation-party.test.ts`. Four generated-runtime tests cover
the memory and SQLite adapters. Typed consumer compilation covers Person, Organization,
Customer and Worker; runtime cases cover identifier linkage, duplication/revocation
races, half-open windows, history, paging, append-only guards, cross-tenant denial and
independent authorization denial. The migrated Participation consumer additionally
proves representation revocation removes PIP eligibility without changing membership.

Shared harness registration is integrator-owned. Reproduce independently after
building with the current compiler:

```sh
cargo build -p forgegraph-cli --locked
target/debug/forgec build packages/foundation/party/fixtures/consumer --out /tmp/foundation-party-consumer
FORGE_FOUNDATION_CONSUMER=/tmp/foundation-party-consumer pnpm --filter @forgegraph/runtime exec vitest run test/foundation-party.test.ts
```

See README.md for semantics and `docs/foundation/party-identity-migration.md` for the
explicit breaking change to experimental Participation identity. No production data
migration or remote identity-provider synchronization is claimed.
