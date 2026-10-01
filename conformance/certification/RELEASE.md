# Release certification — 2026-10-01

`RELEASE_MANIFEST.json` now records all five required profiles as certified.
`release-signature.json` signs its complete canonical content through the
registry's `signEvidence` format. `release-trust.json` pins the existing
`forge.gmac.io` / `instance-v1` Ed25519 public key, derived from the operator's
existing `SIGNING_KEY_JWK` reference. No private key was committed, copied to
Forgejo, or regenerated. Verify after building registry dependencies:

```sh
pnpm --filter @forgegraph/registry... build
node scripts/release-signature.mjs --verify
```

The signer refuses incomplete manifests. Verification rejects changes to any
manifest field, an untrusted key, or another authority. Signing proves the
origin and integrity of these bounded claims, not production readiness.

## Executed evidence

- `latest.json`: seven complete live invocations, 62 assertions, no skips.
- `live/suite-1.json`: 28 reference/vector/migration assertions.
- `live/suite-2.json` and `live/suite-4.json`: 15 scenarios / 221 steps each on
  Cloudflare Workers/D1/R2 and AWS Lambda/DynamoDB/S3. Blob scenarios include
  hosted upload/download bytes. Both endpoint discovery bodies and headers
  matched the current bundle before and after target testing.
- `live/suite-3.json` and `live/suite-5.json`: actual WebSocket publication,
  reconnect and resume on Durable Objects and API Gateway respectively.
- `live/suite-6.json` and `live/suite-7.json`: fenced export/import/verify and
  continued writes in both provider directions, using disposable tenants.
- `live/bench-*.json`: client-observed measurements; no cross-region latency
  promise or sustained-load claim.
- `differential.json` and `differential-suite.json`: local memory/SQLite/native
  PostgreSQL17 comparisons, three pairs of 221 steps, zero unexplained drift.
  Purpose surfaces are checked on memory/SQLite only; local objects use memory.

Source fingerprints identify the tested checkout contents. The live report's
legacy `commit` field records its base revision, not a claim that uncommitted
certification tooling was absent. `live/deployments.json` records the isolated
cloud deployments and AWS code hash. Neither pre-existing Acme development
resources nor Foundation provider infrastructure were changed. Both temporary
cloud sandboxes were deleted after certification, including workflow instances,
queue consumers/queues, D1, R2 objects/bucket, the AWS stack, and its retained
DynamoDB table and S3 objects/bucket. The URLs are historical test endpoints.

[Forgejo run 35](https://git.forgegraf.com/gmackie/forge/actions/runs/35) passed
the complete job on hetzner-bob, including typecheck, regression suites, all
three differential profiles and artifact upload.

The local profile job is weekly/manual in Forgejo on `[forgegraph-ci, heavy]`
(hetzner-bob), with a fresh PostgreSQL17 service and Node24.14.0. It retains its
own reports and generated manifest as artifacts. It does not redeploy cloud
endpoints or automatically re-sign releases. A source/runtime/scenario change
requires fresh certification; expiry is 90 days. The private signing key stays
in the existing operator credential store.

## Remaining scope

Foundation run34 remains evidence for its recorded source. This release run
does not replace that independent package matrix. Production migration needs a
real source snapshot, target constraints and authority, drain/fence/import and
operational verification. Application/staging adoption remains deferred.
Cloudflare Forge connector qualification still lacks a distinct upstream
generator implementation: the two revisions after initial release change only
README documentation. No local test can establish that missing upgrade result.
