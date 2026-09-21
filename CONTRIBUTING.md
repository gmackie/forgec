# Contributing

- Every behaviour change starts with a failing test: a Rust test, a runtime
  vitest, or a conformance scenario. Scenarios are the specification; a feature
  is portable only when the same scenario passes on the reference model and on
  both live targets.
- Compiler changes: `cargo test --workspace`; accept `insta` snapshots only
  after reviewing the diff. Run `scripts/refresh-fixtures.sh` after IR or
  planner changes and re-run `forge lock` when a dependency contract changes.
- Runtime changes: `pnpm -r test`; `pnpm -r exec tsc --noEmit -p tsconfig.json`.
- Schema changes ship with a reviewed migration under `examples/acme/migrations`.
- Compatibility: `forge compat` between the previous and new bundle must not
  report `breaking` without an RFC.
- Commit messages describe the semantic change and its evidence (which suites,
  which deployments).
