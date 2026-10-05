# configuration substrate contract

Implemented experimental package; acceptance evidence is recorded per criterion in `contract.json`. Local verification covers generated memory/SQLite runtimes and typed consumers. It does not certify hosted providers.
Logical Forge identity: `@forgegraph/foundation/configuration`. Initial release target: experimental `0.1.0`.
Source: [issue #94](https://github.com/gmackie/forgec/issues/94), under [epic #25](https://github.com/gmackie/forgec/issues/25).

## Ownership and identity

- ParameterDefinition: a typed parameter declared by a SpecificationPin
- Configuration: one authored layer, optionally inheriting from a lower one
- ParameterAssignment: exactly one of a literal value or a secret reference
- ResolvedConfiguration and ResolvedValue: a digest-identified resolution carrying the configuration each value came from

Configuration identity is (pin, key, layer). A resolution's identity is (configuration, digest), computed over the specification pin, parameter identities, effective values and their sources in key order, so the same desired state is the same fact. Parameter types and layers are keyed registries rather than enums, so an application adds a layer or a value type without a language change. SecretBinding holds a locator, never material. No universal entity reference and no numeric quantity semantics.

## Dependencies and composition

Frozen direct substrate dependencies: `specification`.
Normal Forge imports and `uses` reference accepted package-qualified contracts. The application explicitly co-deploys the selected durable package closure into one transaction domain. Import alone must not imply remote reference integrity. Domain wrappers own business payloads and any reverse provenance links. No universal EntityRef, arbitrary JSON payload, generic Task/Case/Result schema or additional import edge is authorized by this contract.

Reconciliation #46 may consume a resolution and owns none of it; Change #41 may govern configuration change; Publication #48 may publish specification revisions. This contract authorizes no reverse edge from an observation back into a configuration.

## Commands and queries

These are required semantic operations, not a claim that callable implementations exist:

- DeclareParameter(pin, key, valueType, required, defaultValue?)
- Configure(pin, key, layer, parent?); Assign(configuration, parameter, value | secretRef)
- Resolve(configuration, resolvedAt); ListResolvedValues(resolved)

## Invariants

- Configuration is not arbitrary JSON: every assignment names a parameter declared by the same pinned specification revision, so an unknown key cannot be set and a retyped key cannot be silently inherited
- Precedence is a total order along the inheritance chain: a child's layer ordinal is strictly greater than its parent's, so resolution is deterministic and independent of traversal direction
- Secret parameters carry a reference and never a literal, and may not carry a default; this package stores no secret material
- A resolution is identified by a digest over its pin, parameter identities, effective values and sources, so repeat resolution of that snapshot is one fact
- Every resolved value records the configuration it came from, so a surprising value is attributable without re-deriving the chain
- Configuration is authored and resolved independently of anything observing it; desired-versus-observed reconciliation is a separate lifecycle owned elsewhere
- Tenant isolation, declared capabilities and normal governance apply to every operation, reference and read surface.
- Commands retain idempotency identity and reject conflicting replay; terminal history cannot be erased by exposed CRUD.
- Existing instances retain immutable references across compatible package evolution.

## Acceptance traceability

Every issue checkbox appears verbatim below and in `contract.json`; IDs are stable and statuses record local verification. Verification kind names describe required evidence, not executed checks.

| ID | Kind | Required evidence | Status |
| --- | --- | --- | --- |
| F94-01 | runtime | typed configuration definition against SpecificationPin. | partial: scalar validation pending |
| F94-02 | runtime | defaults + explicit overrides. | passing (local) |
| F94-03 | runtime | composition/inheritance rules with deterministic resolution. | passing (local) |
| F94-04 | runtime | environment/context bindings without provider lock-in. | passing (local) |
| F94-05 | compile | secret references do not expose secret values. | passing (local) |
| F94-06 | runtime | resolved configuration has stable/provenance-aware identity. | passing (local) |
| F94-07 | fixture | fixtures for workspace agent, industrial device/process, SaaS tenant and deployment configuration. | passing (local) |
| F94-08 | fixture | Reconciliation can consume configuration without owning it. | passing (local) |

F94-04 is satisfied by construction rather than by a provider abstraction: layers are keyed registry rows with an ordinal, so an environment or context is a row an application creates. No provider, region, cloud or runtime concept appears in this contract, which is what "without lock-in" has to mean at this layer.

## Implementation note: validated snapshots

Kernel expressions hydrate one reference hop, so a rule cannot read `parameter.valueType.secret` or `parent.layer.ordinal`. `ParameterDefinition.secret` and `Configuration.layerOrdinal` are explicit snapshots of those fields, each validated against its source by a one-hop rule on write. A snapshot that disagrees with its source is refused, so the rules built on it remain sound. This is the documented pattern for the multi-hop limitation and is not a claim that multi-hop hydration exists.

## Executable verification

`node scripts/verify-foundation.mjs --package configuration --suite local` rebuilds both
the package and its typed consumer fixture twice, checks deterministic artifacts,
and runs the generated-bundle tests. `contract.json` links every criterion to its
source test files. Fixtures are synthetic; no adoption in an external production
application is implied. Live D1/PostgreSQL/DynamoDB certification is separate from
the local memory/SQLite acceptance results and is not claimed.

## Durable resolution bounds

Resolution refuses truncated definition or assignment pages with `BudgetExceeded`.
Snapshots support at most 32 values, the runtime atomic mutation limit. A header
records the expected count before the values commit atomically. After interruption,
`listValues` rejects an incomplete header and retrying `resolve` completes it.
The header itself is not atomically committed with its children; direct CRUD readers
must not interpret header existence as completion. Existing values are compared
with the expected snapshot before replay succeeds. The durable command identity is
(configuration, digest); a per-operation idempotency key is rejected.

Parameter types currently provide named types and secret/literal separation. They
do not validate scalar syntax (for example integer or boolean literals). Full scalar
validation remains required before F94-01 and issue #94 can be closed.
