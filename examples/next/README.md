# Draft examples

These files make proposed syntax and adapter boundaries reviewable. They have **not** been compiled by Forge, deployed, or typechecked as Effect implementations.

- `m8-reference/` preserves the original package examples, including all nine application constructs.
- `acme-next/`, `governance/`, and `payments/` form a proposed workspace focused on purpose, classification and external callable dependencies.
- `bindings/interfaces.json` separates public bindings from one-way `source` triggers. The agent surface is an explicit narrowing of support access, not an implicit agent purpose.
- `bindings/deployment-profiles.json` is a requirements illustration, not ready-to-run Alchemy/CDK configuration or a certification claim.
- `pending-grant.json` intentionally has no valid approval. Its digests are placeholders. It cannot authorize a call.
- `expected-capability-surfaces.json` is checked by the included reference algebra smoke tests. Those checks do not validate the Forge grammar or the runtime.
- `industry-fixtures/` illustrates multi-subject education data and nonpersonal industrial sensitivity. Legal/safety applicability is not inferred by these samples.

Type names such as `email`, `personName`, `money`, `data.*` and generated `Resource.Record<Purpose>` are proposed standard-library/compiler features. Required implementation slots include SubmitOrder, external payment mapping/binding, host authentication, Gatekeeper policies, PIPs and deploy profiles. No missing slot should become a generated allow-all or no-op implementation.
