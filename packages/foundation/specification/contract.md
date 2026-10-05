# specification substrate contract

Implemented experimental package; acceptance evidence is recorded per criterion in `contract.json`. Local verification covers generated memory/SQLite runtimes and typed consumers. It does not certify hosted providers.
Logical Forge identity: `@forgegraph/foundation/specification`. Initial release target: experimental `0.1.0`.
Source: [issue #26](https://github.com/gmackie/forgec/issues/26), under [epic #25](https://github.com/gmackie/forgec/issues/25).

## Ownership and identity

- Repository: stable source repository identity independent of provider URL
- SpecificationPin: repository + semantic anchor + complete Git commit object ID
- Realization: source pin + buildHash + published manifest digest

No mutable specification lifecycle: resolve, then record an immutable pin; new source produces a new pin. Repository is owned here as source identity, not a source-control account. Domain instances point to pins. Realization records have no Artifact back-reference: ArtifactRevision points to the pin/realization and carries the published digest. Pin queries are bounded and indexed. No quantity units apply.

## Dependencies and composition

Frozen direct substrate dependencies: none.
Normal Forge imports and `uses` reference accepted package-qualified contracts. The application explicitly co-deploys the selected durable package closure into one transaction domain. Import alone must not imply remote reference integrity. Domain wrappers own business payloads and any reverse provenance links. No universal EntityRef, arbitrary JSON payload, generic Task/Case/Result schema or additional import edge is authorized by this contract.

## Commands and queries

These are required semantic operations, not a claim that callable implementations exist:

- ResolveSelector(repository, anchor, selector) -> immutable pin via declared provider adapter
- RecordRealization(pin, buildHash, manifestDigest)
- ListBySpecification(repository, anchor); ListByRevision(pin); ResolveSourceSpan(pin)

## Invariants

- Branches, tags and latest are discovery inputs only, never stored durable revisions
- Source commit, compiled semantic hash and content digest remain distinct typed values
- File movement preserves identity when semantic anchor is preserved; instances never float
- Provider resolution and source-map lookup cannot silently substitute another commit
- Tenant isolation, declared capabilities and normal governance apply to every operation, reference and read surface.
- Commands retain idempotency identity and reject conflicting replay; terminal history cannot be erased by exposed CRUD.
- Existing instances retain immutable references across compatible package evolution.

## Acceptance traceability

Every issue checkbox appears verbatim below and in `contract.json`; IDs are stable and statuses record local verification. Verification kind names describe required evidence, not executed checks.

| ID | Kind | Required evidence | Status |
| --- | --- | --- | --- |
| F26-01 | compile | typed immutable specification pin | passing (local) |
| F26-02 | provider | mutable selector -> immutable commit resolution API | passing (local) |
| F26-03 | compile | no durable branch/tag pins | passing (local) |
| F26-04 | compile | semantic-anchor integration with source-map work | passing (local) |
| F26-05 | runtime | realization/artifact provenance link | passing (local) |
| F26-06 | compile | source-control provider abstraction remains outside business semantics | passing (local) |
| F26-07 | fixture | fixtures proving old instances remain pinned after spec evolution | passing (local) |

## Executable verification

`node scripts/verify-foundation.mjs --package specification --suite local` rebuilds both
the package and its typed consumer fixture twice, checks deterministic artifacts,
and runs the generated-bundle tests. `contract.json` links every criterion to its
source test files. Fixtures are synthetic; no adoption in an external production
application is implied. Live D1/PostgreSQL/DynamoDB certification is separate from
the local memory/SQLite acceptance results and is not claimed.
