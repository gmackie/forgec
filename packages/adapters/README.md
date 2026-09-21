# @forgegraph/adapters

Managed providers and deployment portability packs (M18). Certification is per exact tuple
(`specs/profiles/matrix.json`); nothing is inherited from a component's name.

| entry | what |
|---|---|
| `matrix` | `CertificationMatrix`: exact tuples, `certified` only with evidence from their own run, `unverified` otherwise, `unsupported` when a required guarantee failed; `requireCertified` for production requests. |
| `managed-postgres` | Attach-existing profiles (Neon direct / pooled-transaction, PlanetScale **for Postgres**, local). `resolveProfile` refuses PlanetScale without an engine and MySQL outright. `qualifyPostgres` runs the contract checks plus session-state; `transactionPooled` models a pgbouncer transaction-mode pooler. |
| `sqlite` | `nodeSqliteExecutor` (node:sqlite) and `qualifySqlite` (atomic batch, foreign keys, assertion abort, INSERT OR IGNORE, byte order, RETURNING). `sqlite-node` runs the full conformance suite through `D1Storage`; Turso stays unverified until run against a real endpoint. |
| `deployment-plan` | `resolvePlan(bundle, { target, stage, stateOwner, adopt, secrets })` → one resolved physical plan; `destroyPlan` retains adopted/authoritative resources unless explicitly approved. |
| `terraform` | `emitTerraform(plan)` → pinned `.tf.json` (providers, sensitive secret variables by reference, import blocks + `prevent_destroy` for adopted resources, migrations as a separate ledger-driven job); provider gaps are named in `pack.unsupported`. `nativeProjection`/`terraformProjection` prove plan equivalence. |
| `self-hosted` | `emitSelfHosted(plan)` → Dockerfile (nonroot, health, SIGTERM), compose.yaml (external secrets, no workflow-engine claim), flake.nix + NixOS module (`LoadCredential`). |

`FORGE_TF_VALIDATE=1` runs `terraform validate`; `FORGE_NIX_EVAL=1` evaluates the flake; `FORGE_PG_URL` enables the Postgres qualification.
