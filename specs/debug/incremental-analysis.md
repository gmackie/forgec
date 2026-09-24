# Cached analysis

`AnalysisCache` in the semantic crate reuses Rowan parses by SHA-256 of source bytes and package compilations by full package inputs plus hashes of declared dependency IRs. Package keys identify checkout roots rather than package names. Manifest changes, file additions/deletions/moves, text edits and dependency changes invalidate package results. Unchanged dependencies and unrelated packages reuse their compilation. Missing dependencies have an explicit fingerprint.

The LSP loads/overlays files on each request, so changes on disk are still observed. It accepts sequential incremental UTF-16 edits and full replacement edits. Invalid ranges leave the previous buffer intact. Source-map construction reuses the compilation's retained parse trees.

The cache is bounded to 64 package entries and 2,048 document entries by default, with least-recently-used eviction. Compilation uses shared ownership; eviction cannot invalidate an in-progress reader. `clear` provides a clean-cache path, while public `compile` remains a completely uncached reference implementation.

`forge/analysisStats` returns parse/package hits, misses, eviction counts and a direct package dependency graph. These are development counters, not runtime application telemetry.

Regression tests compare IR, diagnostics, source index, references and source maps with a clean compile after facet edits, workflow edits, file moves/deletions, invalid code, repair, imported dependency changes and eviction. Run the synthetic compiler benchmark with:

```sh
cargo test -p forgegraph-semantic --test analysis large_package_latency -- --ignored --nocapture
```

A local debug run with 500 resource files measured approximately 47 ms cold and 0.11 ms per warm compiler-cache call. These are not end-to-end LSP timings; file loading, source-map indexing and JSON transport add work.

This implements document and package caching, not declaration-level incremental elaboration. Any local semantic edit still rebuilds its package, which safely invalidates facet consumers and workflows but also rechecks unrelated local declarations. Fine-grained symbol/dependency invalidation, interface-only planning reuse and end-to-end LSP benchmarks remain outstanding under #23.

The LSP also caches derived editor source maps alongside each cached compilation. These maps are evicted/invalidate with their owning package entry; callers holding an older compilation cannot receive another revision's map. Compiler/build/revision metadata for non-editor source maps remains per-call.

Run the end-to-end framed-stdio benchmark after `cargo build -p forgegraph-cli`:

```sh
node scripts/bench-lsp.mjs
# Optional: FORGEC=/path/to/forgec FORGE_BENCH_FILES=500 FORGE_BENCH_SAMPLES=30
```

It creates a temporary 500-file package, measures cold open + hover, repeated warm hovers, and alternating semantic edits followed by hover, then reports p50/p95/max and cache counters. The edit measurement includes diagnostic analysis/publication before the ordered hover response. Temporary files and the server are cleaned up. It does not simulate typing/network/render latency or assert machine-dependent timing thresholds.

On one local debug build (500 files, 30 samples), caching editor maps reduced median warm hover from 71.8 ms to 26.0 ms, and median edit + hover from 182.8 ms to 127.4 ms. Package hits/misses stayed 61/31 and parse hits/misses stayed 14,999/501, isolating derived-index reuse from changes in compiler invalidation. Declaration-level elaboration remains outstanding.
