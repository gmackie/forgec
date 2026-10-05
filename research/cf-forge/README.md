# Cloudflare Forge investigation

Executable research for **ForgeGraph compiler/runtime**, based on `de65061f3f57` and Cloudflare Forge `cfe397c296a5`. The control-plane repository is out of scope. No production compiler/runtime source is changed.

[Investigation and results](https://r32m3upf4zrf.postplan.dev) · [baseline](baseline.json) · [checked-in report](../../docs/plans/2026-09-28-forgegraph-cloudflare-forge-investigation.html)

## Reproduce

Use an isolated Cloudflare Forge worktree and Node 24+. Install its pinned dependencies with `pnpm install --frozen-lockfile`. In this compiler/runtime workspace install `pnpm install --frozen-lockfile --filter @forgegraph/runtime...`. Rust 1.97+ and a running Docker engine are required. Then, from the repository root:

```sh
export CF_FORGE_ROOT=/path/to/cf_forge/worktree
bash research/cf-forge/run.sh
```

The runner verifies upstream file hashes and fixture provenance. It downloads the pinned Cloudflare release, stages the two ignored OpenAPI files required by upstream packaging, builds the source transformer and generates both selected SDKs. Upstream's script patches a Fern generator image and retags `fernapi/fern-typescript-sdk:3.80.1`; use an isolated Docker environment if that tag is also used by other work. Image identity is recorded in the baseline, but upstream does not pin the base by digest: historical bit-for-bit replay across machines is not established.

The complete vendor specifications and generated SDKs live in ignored `.cache/`. The checked-in fixtures preserve selected operations plus their transitive local references. They do not simplify unions or otherwise repair source schemas. `extract-fixtures.py` can recreate them from the pinned source URLs in `fixtures/provenance.json`; obtain those full files in `.cache/{cloudflare,github}.json` first. License notices accompany the fixture extracts. The experiments send requests only to local mock servers or injected Fetch handlers, never live vendor accounts.

`core-probes.mjs`, `runtime-probes.mjs` and the importer corpus record failed invariants as observations and exit successfully when the probe completes. Inspect the JSON statuses; a zero process exit is **not** a compatibility pass. `bindings.test.mjs` is an asserting integration suite. `check-artifacts.py` asserts selected operation-map coverage and same-machine repeatability.

## Local Workers smoke check

```sh
WRANGLER_SEND_METRICS=false packages/runtime/node_modules/.bin/wrangler dev \
  --config research/cf-forge/wrangler.jsonc --local --port 8799
curl --fail http://127.0.0.1:8799
```

Compatibility date is pinned to `2026-09-25`, supported by the installed workerd. This exercises both generated clients with injected Fetch responses. It does not certify deployed Workers, AWS, live vendor authentication, or the full ForgeGraph runtime on Workers.

## What the research adapter proves

`binding.mjs` uses the generated operation map to choose a method, then delegates HTTP serialization to the SDK. Explicit application mappings still own input/output semantics. Tests cover local HTTP traffic, both providers, rotated credentials, connection tenant scope, omission/null, pagination headers, field validation, error classification, disconnected writes without retry, real ForgeGraph function invocation and a synthetic SDK rename.

It is deliberately **not production-ready**: it is untyped JavaScript, accepts trusted endpoint/map configuration, does not implement cancellation or webhook verification, does not persist uncertain outcomes, and does not provide a full vendor-specific error taxonomy. A credential provider and domain decoder remain handwritten. The payment callable used in one runtime test is only an existing dependency-enforcement fixture; creating a GitHub issue is not a payment implementation.

## Evidence

- `results/*generation*.log`: build timings and generator operation coverage.
- `results/*sdk-map.json`: operation-to-SDK joins, including request-body wrapping.
- `results/import-probes.json`, `schema-corpus.json`: real importer results and minimized failures.
- `results/core-probes.json`: overlays, instance isolation and envelope behavior.
- `results/runtime-probes.json`: failed-handler redelivery and documentation metadata compatibility.
- `results/binding-tests.log`: asserting integration results.
- `results/reproducibility.json`: byte comparison of two GitHub generations.
- `results/workerd-response.json`: local Workers smoke output.
- `results/generated-typecheck.log`: Node+DOM typecheck (empty means no diagnostics); browser-only diagnostics are separate.
- `results/decision.json`: bounded recommendation and outstanding gates.

These results justify continued isolated connector work, not automatic vendor import, production migration or replacement of existing clients.

## Issue closeout (2026-09-30)

Research PR #190 is merged. Importer #187 is fixed in PR #191; the unchanged
vendor fixtures now both import and pass `forgec check`. New evidence is in
`results/importer-fix-187.json`. Delivery #188 is addressed in PR #192, with
cross-adapter fault tests and [recovery/upgrade guidance](../../docs/subscription-delivery.md).

The original results and `run.sh` hash checks intentionally describe the pinned
pre-fix baseline. Run that historical pipeline at the research revision; do not
replace its hashes to imply the same experiment ran on different source. The new
importer tests and delivery fault scenarios qualify the fixes separately.

The maintainer authorized a disposable Cloudflare Worker for #189. The [live pilot](pilot/README.md) records a typed deployment-verification capability, live API read/write reconciliation, a pinned runtime/SDK snapshot matrix, and cleanup. Its bounded Node host and distribution scope are explicit; production adoption and a distinct future generator release remain unqualified.
