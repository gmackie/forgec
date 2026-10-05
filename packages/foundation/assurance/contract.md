# Assurance system contract

Experimental `@forgegraph/foundation/assurance` 0.2.0 implements issue #40 on
Specification, Evaluation, Evidence, Artifact and standalone Attestation with explicit co-deployment.

Findings, one-time reasoned dispositions, remediation intent/finish and finding
closure are separate immutable facts. Re-evaluation explicitly links corrective
work and the original finding to a different completed evaluation. Reconsideration
creates a predecessor-linked finding; no prior disposition is overwritten.

FindingAttestation profiles a standalone issuer assertion with exact specification, evaluation,
sealed evidence and optional artifact pins. Validity is half-open; unique terminal
revocation/supersession retains historical interpretation. Domain conclusion and
execution details remain typed satellites. Current lookups authorize terminal facts
and support rather than interpreting unreadability as absence.

## Acceptance evidence

All issue criteria F40-01 through F40-07, and F40-R01, F40-R02 and F40-AUTH,
have local evidence in `packages/runtime/test/foundation-assurance.test.ts`.
Two comprehensive generated-consumer tests exercise memory and SQLite with actual
Specification/Evaluation/Evidence/Artifact dependencies. **F40-STORE stays planned**:
no hosted-provider concurrency certification is claimed.

```sh
target/debug/forgec build packages/foundation/assurance/fixtures/consumer --out /tmp/foundation-assurance-consumer
FORGE_FOUNDATION_CONSUMER=/tmp/foundation-assurance-consumer pnpm --filter @forgegraph/runtime exec vitest run test/foundation-assurance.test.ts
```

See README.md for disposition reconsideration, finding closure and support-policy
semantics. Shared verifier registration, exports and generated fixture refresh belong
to the integrator; no source-provider SDK or production application migration is added.

Version 0.2 replaces the local assertion envelope and lifecycle with the
standalone Attestation substrate and a FindingAttestation profile. See README
for explicit subject/issuer migration and historical-row preservation.
