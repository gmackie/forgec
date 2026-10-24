#!/usr/bin/env node
// Builds impl/quote-order.wasm, the QuoteOrder WASM component (FORG-31), from impl/quote-order-rs.
//
//   node examples/pricing/build-component.mjs           # rebuild and write impl/quote-order.wasm
//   node examples/pricing/build-component.mjs --check   # rebuild elsewhere, compare with the committed bytes
//
// Pinned toolchain: Rust 1.97.1 (rust-toolchain.toml, target wasm32-unknown-unknown), wit-bindgen
// 0.63.0 (Cargo.lock), wasm-tools 1.262.0 (`cargo install --locked wasm-tools@1.262.0`).
// wasm32-unknown-unknown keeps WASI out of the component: the unit imports only what its world
// declares.
//
// The bytes are identical on every host (checked on macOS arm64 and Linux x86_64):
// - Paths are remapped, so the checkout, CARGO_HOME, sysroot and target dir do not leak in.
// - Cargo's `-C metadata` is replaced for the wasm32 crates (see METADATA_WRAPPER). Cargo hashes
//   `rustc -vV` into every host crate's metadata, `host:` line included, and folds dependency
//   metadata into dependents, so via the wit-bindgen proc macro the wasm32 crates' metadata and
//   StableCrateId differ per host. That changes every v0 symbol hash in quote_order and wit_bindgen,
//   which changes the order LTO and wasm-ld lay out functions. `strip` drops the names but keeps
//   the order, so the same code came out permuted (FORG-35: macOS and Linux CI disagreed).
import { execFileSync } from "node:child_process";
import { chmodSync, cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";

export const TOOLCHAIN = { rustc: "1.97.1", "wit-bindgen": "0.63.0", "wasm-tools": "1.262.0" };

const here = import.meta.dirname;
const crate = join(here, "impl/quote-order-rs");
const committed = join(here, "impl/quote-order.wasm");

function run(cmd, args, opts = {}) {
  return execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"], ...opts }).trim();
}

// RUSTC_WRAPPER (cargo runs `wrapper rustc args...`). For rustc invocations targeting wasm32 it
// replaces `-C metadata=<cargo hash>` with `-C metadata=<package>@<version>`, which is unique in this
// lockfile and the same on every host. Host crates (build scripts, proc macros) keep cargo's value:
// they never reach the component. POSIX sh and `exec`, so cargo's jobserver fds pass through.
const METADATA_WRAPPER = `#!/bin/sh
rustc=$1; shift
wasm=
for a do [ "$a" = wasm32-unknown-unknown ] && wasm=1; done
[ -n "$wasm" ] || exec "$rustc" "$@"
n=$#
for a do
  case $a in metadata=*)
    [ -n "$CARGO_PKG_NAME" ] && [ -n "$CARGO_PKG_VERSION" ] || { echo "rustc wrapper: CARGO_PKG_NAME/VERSION unset" >&2; exit 1; }
    a="metadata=$CARGO_PKG_NAME@$CARGO_PKG_VERSION" ;;
  esac
  set -- "$@" "$a"
done
shift "$n"
exec "$rustc" "$@"
`;

function requireVersion(name, actual, expected) {
  if (!actual.includes(expected)) throw new Error(`${name} ${expected} required, found: ${actual}`);
}

export function buildComponent(src = crate) {
  requireVersion("rustc", run("rustc", ["--version"], { cwd: src }), TOOLCHAIN.rustc);
  requireVersion("wasm-tools", run("wasm-tools", ["--version"]), TOOLCHAIN["wasm-tools"]);
  const target = mkdtempSync(join(tmpdir(), "quote-order-target-"));
  try {
    const cargoHome = process.env.CARGO_HOME ?? join(homedir(), ".cargo");
    const sysroot = run("rustc", ["--print", "sysroot"], { cwd: src });
    const remap = [`${resolve(src)}=quote-order-rs`, `${cargoHome}=cargo`, `${sysroot}=rust`, `${target}=target`];
    const wrapper = join(target, "rustc-metadata-wrapper.sh");
    writeFileSync(wrapper, METADATA_WRAPPER);
    chmodSync(wrapper, 0o755);
    run("cargo", ["build", "--locked", "--release", "--target", "wasm32-unknown-unknown", "--target-dir", target], {
      cwd: src,
      // RUSTC_WRAPPER overrides any caller's (sccache would not see a cache hit across hosts anyway).
      env: {
        ...process.env,
        RUSTC_WRAPPER: wrapper,
        RUSTC_WORKSPACE_WRAPPER: "",
        RUSTFLAGS: remap.map((r) => `--remap-path-prefix=${r}`).join(" "),
      },
    });
    const core = join(target, "wasm32-unknown-unknown/release/quote_order.wasm");
    const out = join(target, "quote-order.wasm");
    run("wasm-tools", ["component", "new", core, "-o", out]);
    run("wasm-tools", ["validate", "--features", "component-model", out]);
    return readFileSync(out);
  } finally {
    rmSync(target, { recursive: true, force: true });
  }
}

const sha = (b) => `sha256:${createHash("sha256").update(b).digest("hex")}`;

if (import.meta.url === `file://${process.argv[1]}`) {
  if (process.argv.includes("--check")) {
    // Build from a copy in another directory: the bytes must not depend on the checkout path.
    const dir = mkdtempSync(join(tmpdir(), "quote-order-src-"));
    try {
      cpSync(crate, dir, { recursive: true });
      const fresh = buildComponent(dir);
      const want = readFileSync(committed);
      if (Buffer.compare(fresh, want) !== 0) {
        console.error(`impl/quote-order.wasm is stale: committed ${sha(want)}, rebuilt ${sha(fresh)}`);
        process.exit(1);
      }
      console.log(`impl/quote-order.wasm reproduces: ${sha(want)} (${want.byteLength} bytes)`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  } else {
    const bytes = buildComponent();
    writeFileSync(committed, bytes);
    console.log(`wrote impl/quote-order.wasm ${sha(bytes)} (${bytes.byteLength} bytes)`);
  }
}
