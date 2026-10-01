# Local release evidence

`differential.json` and `differential-suite.json` retain the completed 2026-10-01
Node v24.14.0 invocation. All 15 scenarios passed on memory, SQLite (D1 adapter)
and native PostgreSQL 17; each of the three pairs compared 221 steps with zero
unexplained differences. Both test assertions passed with no skips. The second
assertion covers purpose surfaces on memory and SQLite only.

This certifies in-process scenario semantics and storage adapter comparisons.
Object storage is memory-backed. It does not certify hosted object bytes,
HTTP/WebSocket endpoints, realtime delivery, durable restart, or production
migration. Provider-generated values and post-race differences are explained by
the existing comparator; this is not arbitrary application equivalence.

The report records the bundle hash, source fingerprint, Node version and exact
scenario IDs. Manifest generation rejects mismatched, incomplete, failed,
future-dated or expired evidence. The CDK pin comes from the dependency lock.
The manifest remains an unsigned draft, with both cloud profiles unverified.
Foundation run 34 remains historical evidence for its recorded source; it was
not rerun for this release-tooling change.

To refresh, build the runtime and adapters with Node 24, provide `FORGE_PG_URL`
for a dedicated disposable PostgreSQL database, and run `pnpm differential`.
The test resets that database's public schema. The CLI deletes stale working
reports before execution and publishes only after both assertions pass.
After reviewing success, copy `conformance/reports/differential.json` and
`differential-suite.json` into this directory and run `pnpm release:manifest`.
The manifest reads these retained reports, not ignored working output.
