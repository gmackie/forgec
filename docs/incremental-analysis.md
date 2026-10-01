# Incremental editor analysis

The LSP uses `AnalysisCache` for full-buffer and UTF-16 incremental document
updates. `compile` remains the uncached correctness oracle.

The bounded cache retains parse trees by content hash, whole-package results,
and declaration lowering results. A local declaration edit invalidates its
transitive syntax dependency closure: any identifier matching a local symbol
creates a conservative edge. Source HTTP binding changes invalidate their target
resource/function. External dependency hashes, imports, manifest changes, symbol
additions/deletions and file layout changes invalidate broadly. Spans participate
in keys so moving text cannot retain stale editor locations. Shared workflow type
and origin state also participates: removing an earlier producer must not discard
metadata required by a later cached consumer. These conservative dependencies can
cause extra misses; they do not claim minimal invalidation.

Symbol collection, source exposure collection, subscriptions and package-wide
validation still execute for changed packages. Errors are not cached at declaration
level. Deleted entries are pruned; package eviction drops their declaration caches.
The source-map index is reused only for the exact immutable compilation it describes.

`forge/analysisStats` exposes `parseHits`, `parseMisses`, `packageHits`,
`packageMisses`, `declarationHits`, `declarationMisses`, and `evictions`.

Run the development latency benchmark with:

```sh
cargo test -p forgegraph-semantic --test analysis large_package_latency -- --ignored --nocapture
```

A local debug-build observation on 500 independent resource files: cold analysis
76.7 ms, unchanged package lookup 0.117 ms, one declaration edit 39.3 ms versus
54.7 ms clean compilation. That edit reused 499 declarations and lowered one.
These are single-machine observations, not a CI performance threshold or an
end-to-end editor transport benchmark. Shared or densely connected declarations
may invalidate more broadly.

The regression suite compares IR, diagnostics, source indexes, references,
workflow metadata and semantic source maps with clean compilation after facet,
transitive type, workflow, source-route, imported dependency, rename, deletion,
file move, span shift and error-recovery edits.
