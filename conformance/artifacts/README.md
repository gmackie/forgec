# Live Cloudflare Artifacts qualification

This opt-in harness creates disposable repositories and an authenticated Worker,
bundles the actual Forge reader, tests the native Artifacts binding and Git smart
HTTP, and deletes its resources. It does not migrate Bob or deploy production.

Requires Python 3.11+, Git, Node 24+, installed workspace dependencies, and a
Wrangler credential file with Artifacts and Workers management access in a test
account. Use credential references, never token arguments. Run from a writable
workspace:

```sh
python3 scripts/qualify-artifacts.py \
  --account "$CF_TEST_ACCOUNT_ID" \
  --credential-file "$HOME/.wrangler/config/default.toml" \
  --state-dir "$HOME/.local/state/forgegraph/artifacts-unique-run" \
  --evidence /tmp/artifacts-evidence.json
```

Use a fresh state directory for each run. It contains private resource ownership
and Worker authentication state; never commit or upload it. Evidence contains no
tokens. Do not disable Python assertions. `--keep-on-failure` retains disposable
resources for diagnosis. After interruption or retained failure, repeat the same
arguments with `--cleanup-only` and a separate evidence output path. Cleanup
tracks resource names before creation, including uncertain management responses.
A DELETE acceptance is recorded as cleanup; physical provider reclamation may be
asynchronous. The shared `forge-runtime-cert` namespace remains reusable.

The harness retries only exact non-JSON platform error 1042 responses with HTTP
404/500 on its read-only Worker probes: at most five attempts with 2/4/6/8-second
backoff. Every such response is recorded, including a terminal failure. JSON
application errors and other transport failures are not retried by that helper.
Fork readiness and disposable name reuse have separate bounded polling loops.
Runtime adapter behavior is unchanged; these are qualification-host retries.

```sh
python3 -m unittest discover -s scripts -p test_artifact_probe.py
```

`live-2026-10-01.json` records all 17 checks passing and zero remaining resources.
Four 1042 responses preceded a successful file read; earlier diagnostic attempts
also saw intermittent non-JSON errors. Their cause remains unresolved. The
successful run is functional evidence, not production availability certification.

Concurrent pushes use one Git ref and `--force-with-lease` with the same explicit
old OID. Exactly one succeeds, and a subsequent stale push leaves the winner
unchanged. This reader/provider run does not prove multi-ref atomicity or journaled
publication; the separate publication run below covers receipts and recovery. A mirror clone
and fsck verify export of reachable history; reimport is not yet qualified.


## Journaled publication

The publisher qualification uses the actual Node `ArtifactPublisher`, Git
transport and SQL journal with disposable live Artifacts and D1 resources:

```sh
python3 scripts/qualify-artifact-publication.py \
  --account "$CF_TEST_ACCOUNT_ID" \
  --credential-file "$HOME/.wrangler/config/default.toml" \
  --state-dir "$HOME/.local/state/forgegraph/publication-unique-run" \
  --evidence /tmp/publication-evidence.json
```

Requires Node 24+, Python 3.11+, Git, pnpm, installed workspace dependencies, and
Artifacts plus D1 management scopes. The script builds the runtime before use.
Credentials are delivered to the child runner through stdin and Git's environment;
never commit the private state directory. Normal success/failure cleans up the
owned repository and database. After interruption, repeat with `--cleanup-only`
and a different evidence path to retain the original run evidence. Resource
ownership is recorded before creation; uncertain D1 creation is reconciled by
its unique generated name. Cloudflare deletion acceptance is the cleanup boundary.

`publication-live-2026-10-01.json` records 11 passing checks, runtime/runner source
hashes, tool versions and no remaining disposable resources. The run exercises
live D1 SQL over REST; it does not run the Node Git transport inside a Worker.
Lost acknowledgements and failed terminal persistence are deliberately injected
after real pushes. Recovery remains read-only and never resends uncertain writes.
This is functional evidence from a disposable run, not an availability guarantee.

## Forgejo certification

`.forgejo/workflows/artifact-certification.yml` runs the focused contracts on the
existing `forgegraph-ci, heavy` runner for relevant PRs, manual dispatch and a
weekly schedule. Live management credentials are never exposed to PR source.

Live runs require `ARTIFACT_CERT_CLOUDFLARE_TOKEN` with Artifacts, Workers and D1
management access limited to the disposable test account. Enable scheduled live
runs with repository variable `ARTIFACT_LIVE_CERTIFICATION_ENABLED=true`, or
explicitly select the manual `live` input. Until configured, the live job is
skipped and makes no certification claim. Interactive Wrangler OAuth is not an
unattended credential. Only redacted evidence is uploaded; private resource state
and credentials remain excluded. Always-run cleanup handles ordinary job failure;
a forcibly lost runner still requires cleanup using its retained ownership state.

## Native Workers D1 publication journal

Add `--workers-journal` to `qualify-artifact-publication.py` to deploy a disposable
secret-authenticated Worker with a real D1 binding. The actual Node Git publisher
uses the Worker's `SqlArtifactPublicationJournal(rawD1Executor(DB))`; it does not
substitute the D1 REST query API. Git dispatch still runs in Node. This mode is
separate from `--bob-root` and does not deploy the full Bob application.

`workers-journal-live-2026-10-02.json` records all eleven checks passing, including
fresh-process receipt replay, concurrent claims/writers, stale/no-op preconditions,
lost acknowledgement, claim-without-dispatch, failed terminal persistence and
revoked authorization. All disposable resources were removed.

This success does not resolve platform instability. Earlier disposable attempts
returned non-JSON 404/500 responses; one retained failure is
`workers-journal-failure-2026-10-02.json`. The read-only authenticated GET readiness
probe observed exact Cloudflare error 1042 and records response hashes and bounded
retries. No journal write or Git publication is retried by the transport. A later
full run passed; the platform cause remains unproven. The qualification fails on
ambiguous write transport instead of treating a subsequent observed head as proof
of acceptance. User-Agent matches the established reader harness because the
unidentified Python client received a non-JSON 403 at the edge.

The Forgejo live job now selects this journal mode, but remains disabled until its
dedicated management credential is provisioned. Local regression tests exercise
Worker authentication and journal invariants through a D1-shaped SQLite fixture;
these are explicitly separate from the deployed evidence above.

For the reviewed Bob HTTP pilot bundle, `--runner-host`, `--remote-pilot-bundle`
and `--local-pilot-bundle` select an existing SSH host. All three and `--bob-root`
are required. The host/path references are validated and the local/remote SHA-256
must match before configuration is passed on stdin to a disposable Node 24
container. No host port is published; the pilot uses loopback HTTP inside the
isolated host fixture. The host must already have the reviewed bundle, Docker and
Git in the chosen Node image. No production service is reconfigured.
