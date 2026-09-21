# Stability tiers

Everything ForgeGraph publishes is 0.x. A tier does not promise a frozen API;
it tells you how much churn to plan for and what we will do to you when
something changes. Each package records its tier in `package.json` under
`forgegraph.stability`, so tooling can read it without consulting this page.

| tier | what it means |
| --- | --- |
| **stable candidate** | The shape is what we intend to ship as 1.0. Breaking changes need a documented migration and land only on a minor version, never a patch. Deprecated exports keep working for at least one minor. |
| **experimental** | The shape is still being learned from use. Breaking changes can land on any minor, with a CHANGELOG entry but without a migration path. Do not build a public API on top of one of these without pinning an exact version. |
| **internal** | Not published. Part of how this repository tests itself; no compatibility of any kind. |

## Packages

| package | tier | notes |
| --- | --- | --- |
| `@forgegraph/runtime` | stable candidate | The engine and the host contracts. The most exercised surface in the project: every conformance scenario on every profile runs through it. |
| `@forgegraph/react` | stable candidate | Small surface over generated clients. Follows React's own conventions, so it moves when they do. |
| `@forgegraph/interfaces` | stable candidate | The exported *artifacts* (OpenAPI, Smithy, `/forge/discovery`, the dashboard shape `forge-dashboard/1`) are versioned contracts and change under their own version. The TypeScript that generates them is the stable-candidate part. |
| `@forgegraph/capability-manifest` | stable candidate | A contract package. The manifest schema is versioned; a new shape is a new version, not a mutation of this one. |
| `@forgegraph/registry` | experimental | Signing, catalog and grant lifecycle. The grant flow in particular is expected to change as it meets more than one real organisation. |
| `@forgegraph/governance` | experimental | Disposition planning, subject rights, redaction, control packs. Regulatory mapping is our reading, not legal advice, and it will be revised. |
| `@forgegraph/adapters` | experimental | Provider packs and the certification matrix. New providers arrive here first and the interface moves to accommodate them. |
| `@forgegraph/release-gates` | experimental | Promotion gates. Thin, but its inputs (evidence shapes) are still settling. |
| `@forgegraph/temporal` | experimental | Certified against a single-node Temporal dev server only. Multi-node behaviour is untested by us; see `RELEASE_MANIFEST.json`. |
| `@forgegraph/conformance` | internal | The suite itself. Private, never published. |

## Crates

| crate | tier | notes |
| --- | --- | --- |
| `forgegraph-cli` | stable candidate | The `forgec` command line and its output formats. Flags are removed only after a release that deprecates them. JSON output carries its own `version` field. |
| `forge-semantic` | experimental | `domain-ir/1` (the IR document) is a versioned contract and stable. The Rust API that produces it is not: consume the IR, not the crate, unless you are ready to track it. |
| `forge-syntax`, `forge-planner`, `forge-codegen` | experimental | Published so `forgegraph-cli` can be published and so the compiler can be embedded. Treat them as internals with a version number. |

## Versioned contracts

These are independent of package versions and change only by taking a new
version string. Consuming one of these is the most stable thing you can do:

- `domain-ir/1` — the compiled domain IR.
- `forge-dashboard/1` — the provider-neutral dashboard and SLO-rule shape.
- the capability manifest schema, in `@forgegraph/capability-manifest`.
- the generated OpenAPI and Smithy documents, whose shape is pinned by the
  conformance fixtures in `conformance/fixtures`.

## What "breaking" means here

A change is breaking if a package or deployment that was passing the
conformance suite stops passing it, or if a compiled bundle that `forgec
compat` previously called compatible would now be called incompatible. Changes
to *unobservable* internals are not breaking even when the source looks
different.

`forgec compat` is the tool for answering this about your own packages; we hold
ourselves to the same definition.
