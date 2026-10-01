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
unchanged. This does not prove multi-ref atomicity, durable receipts, ambiguous
write recovery, or a Forge runtime publication implementation. A mirror clone
and fsck verify export of reachable history; reimport is not yet qualified.
