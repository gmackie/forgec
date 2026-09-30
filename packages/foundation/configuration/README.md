# Configuration (experimental)

Reconciliation #46 asks whether observed reality matches what was desired. This asks what was
desired in the first place. The two have different lifecycles: a configuration is authored,
layered and resolved long before anything observes it, and it stays valid when nothing is
observing at all.

ParameterDefinition, Configuration, ParameterAssignment, ResolvedConfiguration and ResolvedValue
are append-only facts. `Configuration` from `@forgegraph/runtime` resolves a chain and records
the result. The application invokes it behind its own authenticated, authorized surface; this
package generates no HTTP routes.

**Configuration is not arbitrary JSON.** Every value is an assignment to a parameter declared by
a `specification.SpecificationPin`, so an unknown key cannot be set and a key cannot be assigned
twice in one configuration. An assignment whose parameter belongs to a different pin is
refused, as is an inheritance edge across revisions. Parameter types currently provide named
identities and secret/literal separation. Literal values remain text: integer and boolean
syntax validation is still required for F94-01 and issue #94.

## Deterministic resolution

Layers carry an ordinal, and a child's ordinal is strictly greater than its parent's — enforced
by a rule, not by convention. So precedence is a total order along the chain and resolution
gives the same answer whichever end you start from; there is never a tie to break. The nearest
assignment wins, and a parameter nobody assigned falls back to its declared default. A required
parameter with neither is an error rather than a silent gap.

Every resolved value records the configuration it actually came from. Without that, a surprising
value is unattributable and the only way to explain it is to re-derive the whole chain by hand.

A resolution's digest binds its specification pin, parameter identities, effective values
and their sources in key order. Moving the same value to a different supplying layer changes
that identity. `(configuration, digest)` is unique and repeat resolution verifies stored values.

Queries that exceed the requested bound fail with `BudgetExceeded`. Resolution supports up to
32 values: a preparation header records the expected count, then all values commit atomically.
After interruption, `listValues` refuses incomplete snapshots and `resolve` retries the value
write. Direct CRUD readers must not treat header existence as completion. Resolution rejects
per-operation idempotency keys; its durable command identity is `(configuration, digest)`.

## Secrets

A secret-typed parameter carries a reference to a `SecretBinding` and never a literal, may not
carry a default, and resolves to that reference. An ordinary parameter refuses a reference.
Neither can be both and neither can be empty, and the rule reads the parameter's own type rather
than trusting the caller. This package is deliberately incapable of dereferencing a binding, and
a test scans the compiled contract for any field that could hold secret material.

A note on how those rules are written: kernel expressions hydrate one reference hop, so
`parameter.valueType.secret` is out of reach. `ParameterDefinition` therefore snapshots `secret`
and `Configuration` snapshots `layerOrdinal`, each validated against its source on write. That
is the documented pattern for this limitation, and a snapshot that disagrees with its source is
refused — which is what keeps the one-hop rules built on it sound.

Run `node scripts/verify-foundation.mjs --suite local --package configuration`. Tests use
generated bundles on memory and SQLite, covering pinning, snapshot validation, layered
overrides, defaults, secret handling, digest stability, provenance, required-parameter failure
and tenant isolation. The consumer fixture parameterizes four shapes that share no vocabulary —
a workspace agent, an industrial process unit, a SaaS tenant plan and a deployment — through one
model, and shows a reconciler consuming a resolution while holding no values of its own.
Seven issue criteria have local evidence; F94-01 remains planned until scalar validation is
implemented. `contract.json` records this distinction.

Fixtures are synthetic, not production adoption. Hosted provider certification is separate and
is not claimed.
