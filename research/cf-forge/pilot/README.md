# Disposable Worker connector qualification

The application capability is `deployment.release-marker/1`: mark a disposable
Worker with a release tag, then verify that deployment metadata through a typed
ForgeGraph function. Application identity stays separate from Cloudflare's
`worker-script-settings-get-settings` and `worker-script-settings-patch-settings`.
The handwritten capability contract is deliberately narrower than vendor schema
import. This is an isolated qualification application, not production adoption.

`connector-artifact.json` binds the vendor schema, empty overlay, operation map,
generator/image identities, runtime/adapter hashes, credential reference, scope,
domain mapping, retry ownership, and rollback. Request types are in
`capability/src/index.forge`; `decodeSettings` validates consumed output, preserving
null versus absence and rejecting scalar coercion or pagination envelopes.

## Executed evidence

- `live-evidence.json`: Node 24 against the live Cloudflare API. One accepted PATCH
  had its response deliberately discarded. SQLite persisted the uncertain state;
  a reconstructed adapter reconciled the tag by GET, without a second PATCH.
  Expired prior Wrangler OAuth returned 401; the current login succeeded. Tenant
  mismatch and pre-dispatch cancellation sent no traffic. Direct REST shadow
  reads agreed with the generated SDK.
- `matrix-evidence.json`: the compiled `VerifyRelease` function called its
  declared ExternalBinding using two pinned ForgeGraph source snapshots and two
  independently generated SDKs. All four cells verified the actual release tag
  using GET only. The current upstream revision changes only README relative to
  the prior revision, so this establishes source-snapshot compatibility, **not**
  evidence of a second distinct generator release.
- Nine Node tests cover strict decoding, scoped credentials, reconciliation,
  cancellation during SDK fetch, bounded retries, operation removal, request-map
  changes, changed error envelopes, and unexpected pagination. These fault tests
  are simulated; live 429/5xx conditions were not manufactured at Cloudflare.

Only the Node-to-live-API host profile is qualified. The deployed Worker is the
sandbox resource, not a deployed connector host. AWS, inbound webhooks/polling,
application production rollout, and a future distinct generator release are not
certified here. The pilot has one writer. Tags are not a vendor idempotency key,
and this experiment does not establish safety with concurrent independent writers.
A failed read before PATCH leaves a conservative uncertain record for review.

## Credentials, rollback, and cleanup

Credentials are resolved for each call from the existing Wrangler login. Tokens
are never in checked-in artifacts, request logs, exceptions, or the Worker. The
local SQLite journal is private. Selecting the prior direct REST read adapter is
the rollback path; stop writes and reconcile outstanding journal entries before
manual retry. Comparisons never shadow writes. No existing client was replaced.

The disposable Worker was deleted after verification; see `cleanup-evidence.json`.
The journal and private Wrangler configuration remain locally for audit/replay;
the configuration alone cannot recreate a Worker. No production resource changed.

## License and distribution review

The selected Cloudflare OpenAPI is BSD-3-Clause; its source attribution/hash and
license are recorded in `provenance.json`, with the upstream notice retained in
`../fixtures/cloudflare-LICENSE`. Cloudflare Forge and its SDK wrapper identify
Apache-2.0; the repository license and generated source notices must be retained
if SDK output is later distributed. Fern CLI's upstream repository identifies
Apache-2.0 (LICENSE blob `261eeb9e9f8b2b4b0d119366dda99c6fd7d35c64`).
The selected generated SDK imports no third-party runtime modules.

This change distributes the research adapter, tests, selected schema with its
notice, and non-secret evidence. Generated SDK directories, bundled tooling,
container layers, and credentials are not distributed. The patched generator
image and its base ARM64 manifest/index digests are recorded in the artifact;
the base rootfs was verified as the patched image's layer prefix. Redistributing
the generator image would require its separate full bundled-dependency review;
this pilot does not authorize that distribution or claim a license for each
container dependency. No client/docs migration follows from this result.

## Reproduction

Use Node 24, the pinned transformer workspace and its tsx loader. Generate
`../.cache/pilot-sdk` and `../.cache/pilot-sdk-current` from `vendor.json`, then
build `app` into `../.cache/pilot-app`. Run both `*.test.mjs` with that loader.
`live.mjs` requires `FORGE_CONNECTOR_PILOT_STATE`, checks the exact disposable
account/script, and requires an explicitly provisioned test Worker. `matrix.mjs`
also requires the pinned prior runtime source exported into the private state's
`prior-runtime` directory; mutable worktrees are not used as historical evidence.
The retired configuration must not be treated as a standing deployment.
