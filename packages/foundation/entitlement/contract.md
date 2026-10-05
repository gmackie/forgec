# Entitlement substrate contract

Issue #30, experimental `@forgegraph/foundation/entitlement` version 0.1.0.
Direct dependency: Party. Holder and obligatedParty reference Party directly;
Participant is not this package's business identity.

[README.md](README.md) defines the executable lifecycle, exact quantity, source-satellite
and PIP boundaries. All seven issue criteria have local evidence in
`packages/runtime/test/foundation-entitlement.test.ts`, running actual generated
memory and SQLite bundles. Contract JSON retains the stable F30-01 through F30-07 IDs.

The authoritative facts are immutable grants/duties and unique terminal facts.
Renewal is an independent successor issuance, not mutation or implied continuation
of policy. Source provenance and domain conditions are typed higher-layer resources;
no Agreement, Decision, Participation or generic EntityRef dependency is introduced.

Integration requires registering the runtime helper export and rebuilding both
`packages/foundation/entitlement` and `fixtures/consumer`. Tests read
`FORGE_FOUNDATION_CONSUMER`, defaulting to `conformance/fixtures/entitlement-consumer`.
Run the shared local verifier once registered. Provider certification is a separate gate.
