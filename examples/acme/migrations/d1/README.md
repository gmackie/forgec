# D1 migrations

`0001_init.sql` is the generated baseline for the *current* model (kept equal to `forge build`'s output by
`conformance/test/migrations.test.ts`). Later files are the incremental steps existing deployments took and
are written idempotently (`IF NOT EXISTS`), so a fresh database applying every file in order ends in the same
schema as a deployment that applied them one release at a time. A column added to the baseline needs no
incremental file for fresh databases; existing databases got it through the release that introduced it
(`delivered` from M5 and `trace` from M8 on `forge_outbox` were `ALTER TABLE` steps; SQLite cannot guard them, so they
live only in the baseline and are already applied wherever those releases ran).
