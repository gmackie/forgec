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
twice in one configuration. Pinning is what makes "typed" mean anything: the same key may be a
boolean in one revision and an integer in the next, and a configuration authored against the old
revision must not silently retype. An assignment whose parameter belongs to a different pin is
refused, as is an inheritance edge across revisions.

## Deterministic resolution

Layers carry an ordinal, and a child's ordinal is strictly greater than its parent's — enforced
by a rule, not by convention. So precedence is a total order along the chain and resolution
gives the same answer whichever end you start from; there is never a tie to break. The nearest
assignment wins, and a parameter nobody assigned falls back to its declared default. A required
parameter with neither is an error rather than a silent gap.

Every resolved value records the configuration it actually came from. Without that, a surprising
value is unattributable and the only way to explain it is to re-derive the whole chain by hand.

A resolution is identified by a digest over its resolved values in key order, so the same
desired state has the same identity on any machine, and resolving twice is one fact rather than
two rows — `(configuration, digest)` is unique and the service returns the existing resolution
rather than fighting it. A reconciler can then compare identities instead of values.

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
model, and shows a reconciler consuming a resolution while holding no values of its own. All
eight issue criteria have executable local evidence in `contract.json`.

Fixtures are synthetic, not production adoption. Hosted provider certification is separate and
is not claimed.
