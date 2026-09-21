# Contributing

Thanks for being here. This project makes a strong claim — that one package
behaves equivalently on very different infrastructure — and the only thing
holding that claim up is evidence. Most of what follows is about evidence.

## Getting set up

You need:

- **Rust 1.97+** (`rustup toolchain install 1.97`) with `rustfmt` and `clippy`
- **Node 22.5+** and **pnpm 10** (`corepack enable`)
- **PostgreSQL 17** for the Node-profile suites. Point `FORGE_PG_URL` at it and
  create two databases: `forge_node` and `forge_temporal`.

```sh
git clone https://github.com/gmackie/forgegraph && cd forgegraph
pnpm install
cargo test --workspace          # the compiler
pnpm -r run build && pnpm -r test   # the runtime and packages
```

The cloud suites need credentials and are not required to contribute. They run
in CI and during certification; everything else runs locally against the
reference model, SQLite and PostgreSQL.

## The rules that matter

**Every behaviour change starts with a failing test.** A Rust test, a runtime
vitest, or a conformance scenario — whichever is the right level. Write it,
watch it fail for the right reason, then make it pass. A test written after the
code passes immediately and proves nothing.

**A portability claim starts with a conformance scenario.** Scenarios are the
specification. A feature is portable when the same scenario passes on the
reference model *and* on the targets you are claiming, not when it looks like
it should. If a target cannot support something, say so and let the compiler
report it — an honest gap is far better than a silent divergence.

**Evidence goes in the commit message.** Which suites ran, on which profiles,
and what they proved. "Fixed the outbox" tells a future reader nothing; "outbox
delivery no longer drops the second message of a batch on D1; added
`messaging/batch-redelivery` scenario, passing on d1 / dynamo / pg" tells them
everything.

## Working on the compiler

```sh
cargo test --workspace
cargo clippy --workspace --all-targets -- -D warnings
cargo fmt --all
```

Accept an `insta` snapshot only after reading the diff. After a change to the
IR, the planner or codegen, re-run `./scripts/refresh-fixtures.sh` and review
what moved — CI fails if the committed fixtures do not match what the compiler
in your commit produces. Re-run `forgec lock` when a dependency contract
changes.

## Working on the runtime

```sh
pnpm -r test
pnpm -r typecheck
```

Schema changes ship with a reviewed migration under `examples/acme/migrations`.
A migration that is not idempotent will pass on your machine and fail on a
fresh database; we have made that mistake already.

## Compatibility

`forgec compat` between the previous bundle and yours must not report
`breaking` without a written rationale in the pull request. If it does report
one and the break is intended, say who it breaks and what they should do. See
[docs/stability.md](docs/stability.md) for what each package promises.

## Pull requests

Small and single-purpose beats large and comprehensive. Fill in the template —
the "Evidence" section is the part reviewers read first. If a check fails and
you cannot see why, say so in the PR rather than pushing repeatedly; a flaky
suite is a bug we want to know about.

Discussion, design questions and "is this a good idea before I build it" belong
in [Discussions](https://github.com/gmackie/forgegraph/discussions).
Vulnerabilities go through [SECURITY.md](SECURITY.md), never an issue.

By contributing you agree your work is licensed under Apache-2.0, matching the
rest of the project.
