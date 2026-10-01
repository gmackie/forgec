# Provider certification — 2026-10-01 UTC

Source: `be8e98f244931df316e25f25c356d162bc457fdb`.
[Forgejo run 34](https://git.forgegraf.com/gmackie/forge/actions/runs/34) passed
on the existing `hetzner-bob` runner. All 16 package profiles passed on native
PostgreSQL17, hosted D1 and hosted DynamoDB: 48 cells / 144 exact assertions,
plus the three core-provider runs / 15 assertions. No failed or skipped assertions
were accepted.

`ci-certification.json` is the published CI aggregate. `certification.json` is
an independent local verification of the downloaded artifact: all 16 consumer
bundles were rebuilt from matching source and every cell's source, artifact,
provider identity and raw report hashes were checked. All 51 execution receipts
and 51 raw Vitest reports are retained here. `run.json` binds the artifact to the
run/commit and records its SHA-256. Forgejo's unavailable REST artifact endpoint
required read-only recovery from its artifact store; the database record matched
this repository, run and commit. No server configuration was changed.

Reproduce the package aggregate from matching source:

```sh
node scripts/verify-foundation-certification.mjs \
  --receipt-dir docs/foundation/provider-evidence/2026-10-01 \
  --out /tmp/forge-provider-revalidation.json
```

The independent check also validated the 15 core assertions and their current
source/report digests. `local/` retains current resource-relations and settlement
package verifier receipts (compiler bindings, deterministic double builds, and
12 / 20 memory-SQLite tests respectively).

A duplicate serial local cloud run was intentionally interrupted after 22 passing
receipts while the parallel CI run completed. Its partial results remain in the
private provider state; it is not a completed matrix. This retained matrix uses
the complete published CI artifact.

Scope: database durability and the named Foundation invariants. Object bytes
use memory test doubles. This does not certify deployed release HTTP/WebSocket
profiles, object storage, application adoption or production migration. See
[temporal realization evidence](../../temporal-realization-evidence.md) for the
bounded compiler/runtime connection. Earlier dated aggregates are historical.
