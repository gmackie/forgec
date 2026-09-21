# @forgegraph/release-gates

Governed previews and evidence-gated promotion.

**Stability: experimental.**

```bash
npm install @forgegraph/release-gates
```

- `previewProfile(bundle, { source: "production" | "synthetic", ttlHours })` derives per-field
  treatment from the bundle's data semantics: direct identifiers are pseudonymized deterministically,
  personal and restricted content on subject-bearing resources is redacted, structural fields are
  kept. Branching a production database as a preview source is refused.
- `sloGate(targets, observed)` returns `pass`, `fail` or **`insufficient-evidence`** — below the
  minimum sample count or window, or with a missing metric, a gate never passes.
- `acknowledge()` / `verifyAcknowledgment()` sign a promotion decision over the artifact, stage and
  gate result; an acknowledgment cannot be minted over a non-passing gate.
- `cleanupPolicy()` retains by default; deleting preview data on expiry requires a recorded decision.

Apache-2.0
