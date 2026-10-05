# evidence substrate contract

Experimental implementation; generated memory/SQLite evidence is recorded per acceptance criterion. Hosted provider certification is not claimed.
Logical Forge identity: `@forgegraph/foundation/evidence`. Initial release target: experimental `0.1.0`.
Source: [issue #33](https://github.com/gmackie/forgec/issues/33), under [epic #25](https://github.com/gmackie/forgec/issues/25).

## Ownership and identity

- EvidenceBundle: subject-side support aggregate
- EvidenceItem: source identity, classification, observedAt, artifact revision or typed source satellite

Bundle Open -> Sealed is represented by a unique immutable EvidenceSeal referencing an exact EvidenceMember chain. EvidenceItem records are candidates; adding candidates after sealing never changes sealed support. Members use a strictly decreasing bounded rank; sealed membership is immutable. Corrections produce successor bundle/items with explicit predecessor relation. Evidence source actor/time is envelope metadata; a domain-owned typed satellite identifies external record/execution source without importing upper layers. Digest is optional for non-byte evidence and must match referenced revision where present. observedAt and recordedAt are distinct. No quantity units apply.

## Dependencies and composition

Frozen direct substrate dependencies: `artifact`.
Normal Forge imports and `uses` reference accepted package-qualified contracts. The application explicitly co-deploys the selected durable package closure into one transaction domain. Import alone must not imply remote reference integrity. Domain wrappers own business payloads and any reverse provenance links. No universal EntityRef, arbitrary JSON payload, generic Task/Case/Result schema or additional import edge is authorized by this contract.

## Commands and queries

Implemented helper operations (using authorized Engine calls):

- EvidenceBundle.create; Evidence.record; Evidence.member; Evidence.seal
- Evidence.artifact; Evidence.items (candidates); Evidence.sealedItems (authoritative support); Evidence.successor

## Invariants

- Subject points outward to bundle; Evidence never stores arbitrary subject type/id
- Artifact-backed item pins an immutable ArtifactRevision and preserves its digest
- Typed domain source satellite replaces polymorphic references; observations remain distinct from evaluation results
- Classification and access rules apply to metadata as well as bytes; sealed support cannot be silently replaced
- Tenant isolation, declared capabilities and normal governance apply to every operation, reference and read surface.
- Commands retain idempotency identity and reject conflicting replay; terminal history cannot be erased by exposed CRUD.
- Existing instances retain immutable references across compatible package evolution.

## Acceptance traceability

Every issue checkbox appears verbatim below and in `contract.json`; IDs are stable and all criteria have passing local generated-runtime evidence.

| ID | Kind | Required evidence | Status |
| --- | --- | --- | --- |
| F33-01 | compile | EvidenceBundle + EvidenceItem model | passing (local) |
| F33-02 | runtime | artifact/reference integration | passing (local) |
| F33-03 | runtime | provenance/source semantics | passing (local) |
| F33-04 | runtime | governance/data-classification behavior | passing (local) |
| F33-05 | compile | sidecar attachment idiom | passing (local) |
| F33-06 | fixture | fixtures for deployment verification, manufacturing inspection and agent review | passing (local) |

## Independent verification

Build package and consumer with the current compiler, then run:

```sh
FORGE_FOUNDATION_FIXTURE=/tmp/foundation-evidence FORGE_FOUNDATION_CONSUMER=/tmp/foundation-evidence-consumer pnpm --filter @forgegraph/runtime exec vitest run test/foundation-evidence.test.ts
```

Eight tests pass across memory and SQLite. Both builds reproduce byte-identically;
format/check and runtime typecheck pass. This is local evidence only, not hosted
D1/PostgreSQL/DynamoDB certification or external application adoption.

**Kernel prerequisite:** raw list confidentiality requires the Gatekeeper list fix
verified from commit `450994adebd07e9f0c9737f088b5fd38cbd52d94`. Without that fix,
the raw-list denial regression fails; helper-only denial is insufficient evidence.
The kernel change is integrated separately and is not duplicated in this package.
See README.md for the candidate/sealed distinction and governance boundary.
