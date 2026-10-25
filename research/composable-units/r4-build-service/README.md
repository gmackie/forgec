# R4: the build service, forgec in a Worker emitting units and closure bundles

[FORG-50](https://tasks.gmac.io/gmacko/issue/FORG-50), part of the composable-units epic
(`docs/plans/2026-10-23-composable-units.html`). T1 (FORG-27) ran `forgec build` in a Worker. This
spike adds the rest of the units path to that Worker. One Worker takes a source snapshot (a file map,
or a commit in a Cloudflare Artifacts repository) and returns three things:

- `units/plan.json` (and the `units/wit/*.wit` worlds next to it);
- the Closure Manifest;
- the per-unit modules that each entry point's closure is made of.

All of them are content-addressed. Loom (LOOM-19) is the intended caller: when a Session changes, it
builds, then pushes the changed closures to linker C's dynamic tier.

**Results (2026-10-25):**

- **Byte-identical output.** For `examples/acme`, the Worker writes the same bytes as native
  `forgec build --units` followed by `forge-units` at the same commit. That holds for all 10 files and
  the manifest `sha256:60d3da69…`, in four places: locally in workerd, in CI's Miniflare, deployed, and
  through the Artifacts source. It is the same `manifestHash` that FORG-38 sealed on the Mac and on
  hetzner-master.
- **It fits Workers Paid.** Deployed, a warm build costs about **170 ms CPU** (median 168, n=16).
  - The Worker uploads **5.6 MB gzip**, against Paid's 10 MB limit.
  - The wasm linear memory is about 24 MiB.
  - No invocation ended in `exceededMemory`.
- **It does not fit Workers Free.** The 3 MB size limit and 10 ms CPU limit both rule it out.

Numbers are in `results.json`, and raw data is in `results/`.

## Architecture: where each output is made, and how it runs in a Worker

| output | made by, natively | in the Worker |
| --- | --- | --- |
| `units/plan.json`, `units/wit/*.wit` | Rust: `pipeline::units_plan` and `pipeline::unit_wit_files` (the WIT naming moved there out of the CLI) | the same Rust, in `forgegraph-wasm` (wasm32, the T1 ABI) with `{"units": true, "artifacts": false}` |
| Closure Manifest, `modules/<sha256>.js` | TypeScript: `packages/units` `seal()`. It locates `impl/` bodies with the TypeScript parser, bundles each js-module unit with esbuild, then hashes the units and resolves closures | the same TypeScript, bundled into the Worker as JS (`sealWith` + `memoryHost`), with esbuild-wasm 0.27.7 standing in for native esbuild 0.27.7 |

**Choice.** No part of the path was ported. The Rust and the TypeScript run unchanged in one isolate,
and three seams make that possible:

1. **`forgegraph-wasm` takes a snapshot that can be incomplete.** Its `Snapshot` `SourceTree` reads the
   request's `files`, plus optional `dirs` listings. Every response lists `missing`: the paths the
   compiler looked up and did not find. With no listings, it behaves exactly like `MemoryTree`.
2. **`@forgegraph/units` seals over a `SealHost`.** A host supplies four things: the files, the bundler,
   the shared libraries' versions, and WASM component verification.
   - `seal()` is `sealWith(nodeHost)`, with unchanged output.
   - `memoryHost()` needs no filesystem. An esbuild plugin answers esbuild's lookups from the snapshot,
     in esbuild's own order: the path as written, the extensions, then the `.js`→`.ts` rewrite and
     `index`.
   - The app's `tsconfig.json` chain goes in as `tsconfigRaw`.
   - The `effect` and `@forgegraph/runtime` versions come from `pnpm-lock.yaml` (`lockedLibraries`),
     which is what a frozen install puts in `node_modules`.
   - `bundle-core.ts` holds the esbuild options and the result-to-module step. Both bundlers share it,
     so they cannot drift.
3. **A Worker bundle that leaves out the Node-only parts.** `build.mjs` bundles `worker.mjs` and the
   host-agnostic units modules. It leaves out native esbuild, jco and `node:fs`. TypeScript is
   bundled with `process.browser` defined, which keeps it off its Node `require("fs")` path.
   `build.mjs` refuses to build if esbuild-wasm's version is not native esbuild's version.

Alternatives considered:

- **Porting sealing to Rust.** It needs TypeScript's parser byte ranges and esbuild's output byte for
  byte. Reimplementing those would diverge.
- **Shelling out to native esbuild.** That needs a Container or a build host. It is the fallback below.
- **Splitting forgec and sealing across two Workers.** This would only make sense if size forced it. It
  does not: 5.6 MB gzip against 10 MB.

Wasm components (`--component`) are not supported in the Worker: `memoryHost` has no jco, and refuses
them with an error.

## API

`POST /v1/builds` (with `Authorization: Bearer <BUILD_SERVICE_TOKEN>` when that secret is set):

```jsonc
{
  "root": "examples/acme",                       // app root, repository-relative
  "source": { "files": { "<path>": "<utf-8>" }, "encoding": "utf8" | "base64" }
         // or { "artifacts": { "namespace": "...", "repo": "...", "commit": "<40-hex>" | "ref": "main" } },
  "libraries": { "effect": "4.0.3", ... },       // optional; default: from pnpm-lock.yaml in the snapshot
  "output": "bytes" | "refs"                     // default bytes
}
```

`200`:

```jsonc
{
  "api": "forge-build/1", "ok": true,
  "request": "sha256:…",          // digest of (root, source identity, libraries override)
  "source": { "kind": "files", "files": 51, "digest": "sha256:…" }   // or { kind: artifacts, namespace, repo, commit, tree }
  "package": { "name": "@acme/commerce", "version": "…" }, "libraries": { … },
  "plan": "sha256:…", "manifestHash": "sha256:60d3…", "manifest": { … },
  "files": { "units/plan.json": { "digest": "sha256:…", "bytes": 529171 }, "units/manifest.json": …,
             "units/modules/<hex>.js": …, "units/wit/<unit>.wit": … },   // paths as forgec + forge-units write them
  "closures": [ { "kind", "id", "root", "closureHash", "units": [unit hashes], "modules": [module digests], "bytes" } ],
  "warnings": [],
  "blobs": { "sha256:…": "<base64>" }   // output=bytes; with output=refs the blobs are put in R2 instead
}
```

- **Fetching blobs.** `GET /v1/blobs/sha256:<hex>` serves a stored blob (immutable, with `ETag` set to
  the digest) when the `BLOBS` R2 bucket is bound. The key is the content hash, so writes are
  idempotent. "Per-closure bundles" are each closure's module digests, plus `units` and `closureHash`.
  For acme, 4 of the 91 entry points carry modules (up to 1,855 B). Forge-native closures need none.
- **Errors.**
  - `400 invalid_request`.
  - `422 compile_failed`, with forgec's `rendered` diagnostics.
  - `422 seal_failed`, for example `missing unit: … has no implementation under impl/`.
  - `422 no_lockfile`/`no_library`.
  - `501 not_configured`, when there are no Artifacts credentials or no R2 for `refs`.
- **Determinism.** The body is a function of the request: every series in `results/` returned
  byte-identical bodies. Timings go only in `Server-Timing`, and counts only in `x-forge-build-stats`
  (`rounds`, `subrequests`, `snapshotFiles`, the forgec and esbuild linear memory).
- **Caching.** The service keeps no state, so the caller can cache on `request`.

## Source

- **File map:** the caller sends the files. `request.mjs` builds acme's map: the tracked files under
  `examples/acme` and `examples/payments`, plus `pnpm-lock.yaml`, `packages/runtime/package.json`,
  `tsconfig.base.json` and the two pinned capability manifests. That is 51 files and 355 KB of JSON.
  For Loom, this is the Session snapshot.
- **Cloudflare Artifacts** (`artifacts.mjs`) uses the REST object routes that Loom's
  `src/loom/backends/artifacts.mjs` reads: `/log?ref`, `/commit/<h>`, `/tree/<h>` and `/blob/<h>`.
  - Each tree object is fetched once and cached. Symlinks and submodules read as absent, as they do
    in `MemoryTree`.
  - The Worker runs forgec, fetches the paths it reports `missing`, and repeats until nothing new
    turns up.
  - Listing a directory also lists its subdirectories and fetches the `.forge`, `forge.toml` and
    `forge.lock` files in them. That is an optimization only: without it, acme takes 25 rounds
    (`a_lazy_host_converges_on_the_missing_paths` in `crates/forgegraph-wasm`).
  - With it, acme converges in **6 rounds and 51 subrequests**. That includes `impl/`, the tsconfig
    chain, the lockfile and the runtime's `package.json`, which sealing reads.
  - Every object is fixed by the commit hash.
- **Not tested against real Artifacts.** No Artifacts repository holds forgec, and creating one meant
  pushing the repository to a new Cloudflare resource. The Artifacts series ran instead against
  `fake-artifacts.mjs`, which serves the same routes and envelopes from this checkout's git objects.
  The deployed Worker therefore ran only the file-map and `refs` series.

## Byte-identity evidence

Each check compares the service's outputs file by file against native `forgec build examples/acme --units`
followed by `forge-units` (native esbuild 0.27.7):

1. `packages/units/test/memory.test.ts` (in `pnpm --filter @forgegraph/units test`). It seals from the
   tracked files alone, with no `node_modules`, using both native esbuild and esbuild-wasm under Node.
   The output is identical, and so are the library versions from the lockfile and from `node_modules`.
2. `crates/forgegraph-wasm` tests:
   - its plan equals `pipeline::units_plan` from disk;
   - a lazy host converges on the same files.
3. `parity.mjs` runs in CI (the units job), in workerd via wrangler's Miniflare. Both the file map and
   the Artifacts source produce 10/10 identical files and the same manifest.
4. `results/local.json` (`run.sh`, wrangler dev) and `results/deployed.json` record `parity.byFile` per
   file, with digests. Every file is `identical: true`: the file map and Artifacts locally, the file
   map deployed, and the `refs` blobs fetched back from R2 locally and deployed.

## Measurements

Acme yields 65 units (61 forge-native, 4 js-module), 4 modules and 91 entry points. Its outputs are:

| output | size |
| --- | --- |
| plan | 529,171 B |
| manifest | 467,549 B |
| modules | 2,232 B |
| WIT | 7,911 B |
| bytes response | 1.74 MB (185 KB gzip) |

**Size** (`results/size.json`, `results/wrangler-dry-run.log`):

| part | raw | gzip |
| --- | --- | --- |
| worker.mjs: worker, @forgegraph/units and TypeScript, minified (TypeScript is 3.56 MB of it) | 3,660,338 B | 1,052,175 B |
| forgec.wasm (forgegraph-wasm, release) | 4,168,656 B | 978,845 B |
| esbuild.wasm (esbuild-wasm 0.27.7) | 13,545,901 B | 3,644,827 B |
| **total**; wrangler `deploy --dry-run` reports 20,873.92 KiB / gzip 5,578.91 KiB | 21,374,895 B | **5,675,847 B** |

**Deployed** on Workers Paid account `c07a7e70…`, workers.dev, compatibility date 2026-09-25,
`nodejs_compat`. The client was this Mac, and there were 20 warm runs. CPU and wall time come from
`wrangler tail` (`results/deployed-tail.json`):

| | value |
| --- | --- |
| CPU per build (n=16 delivered by tail) | median **168 ms**, min 131, p90 215, max 612 |
| Worker wall per build | median 196 ms, p90 645 |
| client wall, first request after deploy / warm median | 1,993 ms / 478 ms (p90 804) |
| `GET /v1/blobs/…` | 0–2 ms CPU |
| outcomes | all `ok`; no `exceededMemory`, no exceptions |
| wasm linear memory | forgec 7.2 MiB; esbuild 12–16 MiB |
| isolate memory | not reported by the platform (as FORG-38 found) |

Notes on the deployed numbers:

- `Server-Timing` reads about 0 for compute when deployed, because clocks advance only across I/O.
- Tail delivered 26 of the run's roughly 45 invocations. The isolate's first build was not among them.
  The 612 ms and 951 ms readings were probably isolate warm-up (esbuild-wasm init and V8 tier-up), not
  steady state.

**Local** (`results/local.json`): `wrangler dev --local` (workerd 1.20260918), Apple M2 Max, 20 runs.
Other agents were building on the same machine, so medians are noisy; minimums are the cleaner figure.

| | file map | Artifacts (fake, loopback) |
| --- | --- | --- |
| first request, in-isolate total | 3,000 ms (forgec 870, esbuild init 408, seal 1,645) | — (same isolate, warm) |
| first request, workerd process CPU | 2,060 ms | |
| warm, in-isolate total, median (min) | 617 (299) ms | 602 (407) ms |
| warm, forgec / seal, median (min) | 163 (31) / 246 (66) ms | 110 (23) / 241 (73) ms |
| warm, workerd process CPU (ps), median | 160 ms | 130 ms |
| rounds / subrequests | 1 / 0 | 6 / 51 |
| workerd RSS, before / max | 188 MiB / 680 MiB (whole process: compiled wasm for every isolate, all services) | |

The in-isolate wall time is well above CPU because esbuild-wasm's Go runtime and JS hand calls back
and forth through timers. Deployed, wall time ran close to CPU (196 ms against 168 ms).

### Against Workers limits, and the fallback

- **Paid:**
  - Size: 5.6 MB against 10 MB.
  - CPU: about 170 ms warm, and an estimated 1–2 s cold, against the 30 s default.
  - Memory: about 24 MiB of wasm linear memory against 128 MB, and nothing went over.
  - Subrequests: 51 for Artifacts.
- **Free:** fails on size (3 MB) and on CPU (10 ms).
- **What gets bigger with app size:** the per-unit esbuild calls, which run in sequence, and the plan
  and manifest JSON.

**Fallback.** If an app outgrows the limits, run the same `POST /v1/builds` contract in a Container or
on a build host. The work is native `forgec build --units` followed by `forge-units` over the same
snapshot; `seal()` is the host-agnostic `sealWith(nodeHost)`, so the output is what this Worker
returns. The Worker can then forward to that host, unchanged, once a request trips a size threshold.
This fallback was not built.

## Deploy and teardown record (UTC, 2026-10-25)

The deploy went through ForgeGraph, to app `forge-console`, stage `staging` (sortOrder 90), as FORG-38
did:

- A new target `build-service` (`388cfe12`), pinned to hetzner-master.
- The stage is shared with another lab running at the same time (`r5-loader-miss`, targets `miss-*`).
  None of its targets or secrets were touched.
- The production target `worker` was compared before and after: unchanged.
- `forge.gmac.io/healthz` answered 200 after teardown.

hetzner-master has no wasm32 target, and its shared toolchain was left alone. Instead, the
`buildCommand` installed rustup 1.97.1 minimal plus wasm32 into
`/mnt/master-apps/cache/forg50-lab-rustup`, with `CARGO_TARGET_DIR=/mnt/master-apps/cache/forg50-lab-cargo`.

| when | what |
| --- | --- |
| 18:21:16–18:21:31 | `wrangler r2 bucket create forge-lab-build-service-blobs` |
| 18:21:39 | `forge secret set BUILD_SERVICE_TOKEN --stage staging` (a random value, kept outside the repository) |
| 18:22:00 | `forge target add build-service --stage staging` (`syncSecretsInclude: [BUILD_SERVICE_TOKEN]`) |
| 18:22:12 | `forge deploy create staging --ref FORG-50-build-service --break-glass --target build-service`: deployment `622fc9fa` **failed**, because `build.mjs` ignored `CARGO_TARGET_DIR` (fixed in `6bc1e56`) |
| 18:24:16–18:27:12 | the same command: deployment **`717c52ad` active** (commit `6bc1e56`), Worker `forge-lab-build-service` |
| 18:27:53–18:28:13 | measurements (`results/deployed.json`, `results/deployed-tail.json`) |
| 18:28:57–18:29:06 | `wrangler delete forge-lab-build-service` |
| 18:29:06–18:30:11 | the 10 R2 objects deleted, then `wrangler r2 bucket delete forge-lab-build-service-blobs` |
| 18:30:22 | `forge secret rm BUILD_SERVICE_TOKEN --stage staging` |
| 18:30:30 | `forge target update build-service`: retired (`buildCommand` echoes "FORG-50 lab retired" and exits 1, `deployCommand` is `exit 1`, `syncSecrets` is false). As FORG-38 found, a target with deployments cannot be removed. |
| 18:30:55 | checked: the lab Worker answers 404, no `forge-lab-build-service*` bucket exists, production's target config is unchanged, and `forge.gmac.io/healthz` answers 200 |
| 18:31:02 | removed the lab toolchain (685 MB) and cargo cache (170 MB) from hetzner-master |

## Reproduce

Requires Rust 1.97+ with `wasm32-unknown-unknown`, Node 24+, and `pnpm install --frozen-lockfile`.
Run from the repository root, with examples and the lockfile committed:

```sh
node research/composable-units/r4-build-service/parity.mjs        # CI's check (Miniflare)
RUNS=20 bash research/composable-units/r4-build-service/run.sh     # results/local.json, size.json
# By hand:
node research/composable-units/r4-build-service/build.mjs
packages/runtime/node_modules/.bin/wrangler dev --config research/composable-units/r4-build-service/wrangler.jsonc --local
```

Measuring a deployed Worker uses
`BUILD_SERVICE_TOKEN=… HOST=… node measure.mjs <url> <native-generated-dir> 20 deployed`, with
`wrangler tail <name> --format json` running alongside it.

## Not established

- Real Cloudflare Artifacts: the tests used the fake API only. Cold-start CPU on the edge: tail did not
  deliver the isolate's first build.
- Apps other than acme.
- Bundles that import non-shared npm packages. There is no `node_modules` in the Worker, so these fail
  with `Could not resolve`. Supporting them needs the packages in the snapshot, or the fallback.
- Nested `tsconfig.json` files below the app root. `memoryHost` applies the app root's chain only.
- WASM-component units in the Worker.
- The Container or build-host fallback.
