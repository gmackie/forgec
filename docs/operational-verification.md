# Operational verification (FORGE-086)

How a running deployment is checked against what was declared, approved and measured, and what each
signal can and cannot prove.

## The five graphs

| graph | source | proves |
|---|---|---|
| declared | `uses` edges in the IR (`requestFrom`) | what the code *could* call |
| approved | published `dependency-grant/1` records | what owners reviewed |
| activated | `GrantRegistry.activate` per deployed identity | what the runtime will allow now |
| observed | telemetry edge events (`forge_edges_observed_total`, `OperationEvent.purpose/decision`) | what was seen, at the caller's **assurance tier** |
| snapshot | `SnapshotHolder.state()` | whether the authority the runtime decided under is still valid |

`driftReport()` (`@forge/registry/evidence`) joins them:

- **unexpected edges**: observed but not activated. Attribution is qualified: under `workload-bound`
  credentials a span that claims `FunctionA` attributes to the *workload*; only an `isolated-callable`
  identity attributes to a function (PAR-170).
- **unused grants**: activated but not observed in the window. A *suggestion* carrying telemetry coverage
  and whether traces were sampled; nothing is revoked automatically and absence is not proof of no use
  (PAR-171). Use `GrantRegistry.reviewUnused` to act.
- **declared-not-approved / approved-not-activated**: pending requests and pending activations.
- **snapshot**: expired or degraded snapshots bound every allow decision by the expiry rule.
- **linked changes**: semantic diff findings (`forge compat`) link to the dashboard panels they affect
  (`surface-narrowed` → `privacy:denials`, `dependency-added` → `grants:edges`).

## Telemetry semantics

- One `completion` event per logical request; retried tries are `attempt` events on the same
  `requestId`. SLIs use completions as the denominator (`Telemetry.sli`), never attempts (PAR-166).
- Declared business errors are `business` outcomes: neither good nor bad for availability.
- Export loss is counted (`stats().dropped`, `coverage:loss`) and widens error budgets into a band
  (`errorBudget`); traces are sampled and never an exact source (PAR-167).
- Labels are bounded: operation, kind, resource, outcome, target, purpose (opaque `p:<hash>` handle when
  the purpose's handling is confidential), decision. No tenant, actor, id or input ever (PAR-164/165).
- Provider gaps render as `missing` panels, never zero (PAR-168).

## Evidence

`signEvidence` binds build/contract/grant/policy/adapter hashes, per-profile test results with windows,
migration acknowledgments and telemetry coverage windows. `evidenceClaims` renders each as a bounded
claim (`verified` | `stale` | `unknown` | `failed`); a verified signature proves provenance of the claims,
not anything beyond their scope, and never regulatory compliance (PAR-169). Confidential artifacts are
listed by audience and not disclosed outside it.

## Release verification checklist

1. `forge compat` and `forge migrate` against the deployed artifact (pulled by the inventory's digest).
2. Deployment ledger rollout: preflight → expand → compat-release → backfill → verify → traffic → drain → contract, under a lease.
3. SLO gate with minimum evidence (`@forge/release-gates`); acknowledgments signed and artifact-bound.
4. `driftReport` on the new window; unexpected edges block promotion; unused-grant suggestions go to review.
5. Publish `deployment-evidence/1`; the dashboard (`@forge/interfaces/dashboards`) links to panels.
