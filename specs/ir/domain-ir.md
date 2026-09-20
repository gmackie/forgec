# DomainIR (`domain-ir/1`)

The package-level semantic model emitted by `forge inspect` and consumed by
every planner and emitter. Rust types live in `crates/forge-semantic/src/ir.rs`
and are the normative definition; this page explains the shape and the
determinism rules.

## Determinism

- Modules, and every declaration list inside a module, are sorted by stable
  id. Fields keep declaration order (it is wire-visible for output shapes).
- Synthesized fields follow declared fields in a fixed order:
  `version`, `createdAt`, `updatedAt`, `deletedAt`, `status`,
  `effectiveFrom`, `effectiveUntil`, `parent`.
- Every `list by` gets an `id asc` tie-breaker appended unless `id` is
  already an order key.
- No file paths, timestamps or machine-specific data appear in the IR. The
  snapshot test in `forge-semantic` compiles the reference app with reversed
  file order and backslash paths and requires byte-identical output.
- `content_hash()` is SHA-256 of the canonical JSON; `forge inspect` combines
  it with dependency hashes and the compiler version into `buildHash`.

## Top level

```json
{
  "version": "domain-ir/1",
  "package": { "name": "@acme/commerce", "version": "0.1.0", "edition": "2026", "profile": "portable-v1", "targets": ["cloudflare-d1", "aws-dynamodb"] },
  "imports": [ { "alias": "payments", "package": "@acme/payments" } ],
  "modules": [ { "id": "_", "enums": [], "types": [], "shapes": [], "resources": [], "functions": [], "channels": [], "sources": [], "subscriptions": [] } ]
}
```

## Identities

Stable ids are `<package>/<module>/<symbol>` (`@acme/commerce/_/Customer`).
Derived ids: `<resource>.Status` (synthesized enum), `<resource>.<operation>`
(`.create`, `.get`, `.update`, `.delete`, `.restore`, `.find.byCode`,
`.list.byTier`, `.status.submit`). Imported contracts keep the upstream id: a
channel declared `from payments.PaymentEvents` has its own local id and
`contract: "@acme/payments/_/PaymentEvents"`; a `uses payments.AuthorizePayment`
resolves to `@acme/payments/_/AuthorizePayment`.

## Types

`TypeSpec = { base, optional, normalizers, constraints }` where `base.kind` is
one of `scalar` (`name`, `args`), `enum`, `shape`, `reference`, `record`,
`identity`, `status`, `message`. A type alias's normalizers and constraints
are inherited by fields that use it, then extended by the field's own
refinements, in order.

## Resources

- `decorators`: elaborated flags plus `crud { path, operations? }`,
  `effectiveDated { uniqueBy }`, `label`.
- `fields[]`: `{ name, type, default?, derived?, immutable, serverOwned, synthesized, doc? }`.
  `id` is always server-owned and immutable. Derived (`:=`) fields are
  server-owned with an `Expr` and an inferred type.
- `uniques[]` (`@unique` fields and `unique … within …`), `finds[]`
  (each names the unique that covers it), `lists[]` (with full `order`).
- `rules[]`: boolean `Expr` trees over field paths; paths through references
  are checked against the referenced resource's fields.
- `lifecycle`: `{ field, enumId, states, initial, terminals, transitions[] }`
  per `specs/language/lifecycle.md`.
- `operations[]`: `{ id, kind, query?, action?, http? }`. HTTP bindings are
  present only for operations exposed by `@crud` (optionally narrowed by
  `operations: [..]`); lifecycle actions are never exposed by `@crud`.

## Functions, channels, sources, subscriptions

- `Function`: `input`/`output` TypeSpecs, `uses[]` (`resource` + capability,
  `transition`, `function`), `sends[]`, `errors[]`, `slo[]`, `http?`,
  `generated` (false: `impl/` must supply the body).
- `Channel`: `contract?`, `distribution` (default `broadcast`), `delivery`
  (`at-least-once`), `direction?` (`send-only` | `recv-only`), `messages[]`.
- `Source`: `cron?`, `timezone?`, `target` function id.
- `Subscription`: `{ channel, message, handler }`; the handler's input must be
  that message type.

## Diagnostics

`forge check` renders `severity[CODE]: file:line:col: message` with an optional
`help:` line, sorted by file, offset, code. Codes are listed in the
`E-*`/`W-*` tables of `specs/language/lifecycle.md` and the compiler source;
they are stable identifiers for tests and tooling.
