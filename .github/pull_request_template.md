## What changes

<!-- The semantic change, not the diff. What can a user do now that they could not? -->

## Evidence

<!-- Which suites ran, and what they proved. A portability claim needs a conformance
     scenario; a behaviour change needs a test that failed before the change. -->

- [ ] `cargo test --workspace`
- [ ] `pnpm -r test`
- [ ] `./scripts/refresh-fixtures.sh` re-run and the diff reviewed (if IR, planner or codegen changed)
- [ ] `forgec compat` reports no `breaking` change, or the break is explained below

## Compatibility

<!-- If this changes a published package, a generated artifact, or a versioned
     contract, say what breaks and for whom. "Nothing" is a fine answer. -->
