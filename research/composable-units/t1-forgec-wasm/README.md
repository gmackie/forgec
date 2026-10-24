# T1: forgec check/build as WASM in a Worker

Research spike T1 of the composable-units epic ([FORG-26](https://tasks.gmac.io/gmacko/issue/FORG-26), this task [FORG-27](https://tasks.gmac.io/gmacko/issue/FORG-27)). Step 1 toward linking units onto Worker isolates is to run forgec in one. This spike runs `check` and `build` of `examples/acme` in workerd (`wrangler dev --local`) from a wasm32 build of the library crates. It also checks that the Worker's build output is byte-identical to the native CLI's.

## What changed in the compiler

- `forgegraph-semantic`: `SourceTree` trait with two implementations. `OsTree` reads `std::fs`. `MemoryTree` is an in-memory `path -> bytes` map whose paths are resolved lexically. `load_package(root)` is unchanged and delegates to `load_package_in(&OsTree, root)`.
- `forgegraph-codegen::pipeline`: the CLI's host logic, moved out of `forgegraph-cli/src/main.rs` over a `SourceTree`. That covers dependency tree loading, the lock and extension checks, the build hash, and artifact rendering. `forgec` now calls the same functions. It keeps its messages, exit codes and output files (the existing CLI tests pass, and `forgec build examples/acme` matches its pre-change output byte for byte).
- `crates/forgegraph-wasm` (`publish = false`): `check(json)` and `build(json)` over a `MemoryTree`. It is exported as `forgec_check` / `forgec_build` / `forgec_alloc` / `forgec_free`, with the same owned-buffer ABI as `forgegraph-editor`: no wasm-bindgen, no JS glue, and the module imports nothing. Native tests compare its acme build with the `OsTree` pipeline's.

The request is `{"root": "examples/acme", "files": {"<path>": "<utf-8>"}, "serviceId"?, "sourceRevision"?}`. `files` must hold everything the CLI would read: manifests, `forge.lock`, sources, path dependencies and pinned extension manifests. `build` returns every artifact keyed by its path relative to the output directory. The brief's `build(files, target)` has no direct analogue: `forgec build` has no target switch and always emits D1 and Postgres SQL, the client, OpenAPI, Smithy and the contract. So `root` names the package to build instead.

## Reproduce

Requires Rust 1.97+ with `wasm32-unknown-unknown`, Node 24+, and `pnpm install --frozen-lockfile --filter @forgegraph/runtime` (for wrangler). From the repository root:

```sh
RUNS=20 bash research/composable-units/t1-forgec-wasm/run.sh
```

The runner:

1. builds the native CLI and writes the reference `forgec build examples/acme` into a temp dir;
2. runs `bundle.mjs`, which builds `forgegraph-wasm` and collects acme's 17 input files into the ignored `generated/`;
3. records sizes, including a size-tuned build through env profile overrides;
4. serves `worker.mjs` with `wrangler dev --local`;
5. runs `measure.mjs`, which records timings, parity and Node CPU.

To try the Worker by hand: `wrangler dev --config research/composable-units/t1-forgec-wasm/wrangler.jsonc --local`, then `curl localhost:8787/check` (also `/build`, and `/` for both). A `POST` with a request body compiles that request instead of acme.

The compatibility date is pinned to `2026-09-25`, like `research/cf-forge`. Measured with wrangler 4.135.0 on an Apple M2 Max.

## Results (2026-10-23)

| | value |
|---|---|
| `.wasm` raw / gzip -9 (release, workspace profile) | 3,635,765 B / 851,083 B |
| same, `opt-level=z lto codegen-units=1 panic=abort` (env override, not committed) | 3,135,218 B / 620,611 B |
| wrangler `deploy --dry-run` total upload | 3567.56 KiB / gzip 838.54 KiB |
| `wasm-opt` | not measured (binaryen not installed) |
| wasm linear memory after 21 check + 21 build calls | 10,092,544 B (9.6 MiB) |
| check, first request: in-isolate / client wall | 44 ms / 76.0 ms |
| check, warm (n=20) in-isolate median (min-max) / client wall median | 3 ms (3-4) / 5.3 ms |
| build, first request: in-isolate / client wall | 78 ms / 92.1 ms |
| build, warm (n=20) in-isolate median (min-max) / client wall median | 30 ms (29-36) / 42.7 ms |
| workerd CPU ms per check/build | **missing**: local workerd does not report CPU time |
| Node V8 process CPU, same module (proxy, n=20 median) | check 3.9 ms, build 40.9 ms |
| native `forgec` whole process (for scale, `time -p`) | check <10 ms, build ~30 ms |
| build output vs native CLI | **byte-identical**, all 9 files ([parity.json](results/parity.json)) |

"In-isolate" is a `performance.now()` delta around the synchronous wasm call. Local workerd advanced its clock during the call. Deployed Workers advance clocks only across I/O, so this number cannot be read there the same way. Without CPU accounting, it is the closest local stand-in for CPU time. The first request is slower because V8 compiles and tiers up wasm functions lazily. Client wall time adds loopback HTTP and JSON: the build response carries about 1.1 MB of artifacts.

### Against Workers limits

The figures below come from the Cloudflare Workers limits page (developers.cloudflare.com/workers/platform/limits/) as I recall it. **They were not re-fetched for this run, so confirm them before relying on them:**

- Compressed Worker size: 3 MB on Free, 10 MB on Paid.
- Memory: 128 MB per isolate.
- CPU per request: 10 ms on Free; 30 s by default on Paid, configurable higher.
- Startup: about 1 s.

Against those figures:

- **Size:** the 0.84 MB gzip upload fits Free (3 MB) and Paid (10 MB), with room for the size-tuned build (0.62 MB).
- **Memory:** about 10 MB of linear memory is far below 128 MB.
- **CPU:**
  - A warm `check` of acme (about 3-4 ms) fits the Free 10 ms budget.
  - A warm `build` (about 30 ms) and any cold first call (44-78 ms) do not.
  - All of these fit Paid.
  - These are local M2 numbers, not deployed-edge numbers.
- **Startup:** the module is instantiated at global scope. Startup time was not measured.

## WASM blockers

See [results/blockers.json](results/blockers.json). In short: nothing failed to compile, because `forgegraph-editor` already proved that the library crates build for wasm32. The blockers were the runtime filesystem, env and exit calls on the check/build path:

- `load_package`'s `std::fs` reads, plus the CLI's `canonicalize`, lock and extension reads, and artifact writes. These now go through `SourceTree` and return artifacts as data.
- `FORGE_SOURCE_REVISION`. It is now a parameter.

Not handled:

- the OpenAPI importer's `--pin` file reads (not on this path);
- panics, which trap without a hook;
- symlink-aware canonicalization in `MemoryTree`.

There are no threads, clocks or native-only dependencies.

## Evidence

- `results/size.json`, `results/size-variants.json`, `results/wrangler-dry-run.log`: sizes and the limits relied on.
- `results/workerd-timings.json`: per-op first and warm statistics from workerd.
- `results/node-v8-cpu.json`: process CPU of the same module under Node, labelled as a proxy.
- `results/parity.json`: per-file byte comparison with the native CLI.
- `results/workerd-response.json`: the Worker's last check result, with build artifacts reduced to size and sha256.
- `results/workerd.log`: wrangler dev output for the measured run.

## Not established

- Deployed-edge CPU and startup time.
- Free-plan feasibility of `build`.
- Packages other than acme.
- Error-path parity beyond the native unit tests (missing dependency, tampered pin, stale lock).
- Linking units onto isolates, which is the later tasks in FORG-26.
