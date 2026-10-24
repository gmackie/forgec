#!/usr/bin/env node
// Builds the WASM components of @acme/pricing from their Rust crates:
//   impl/quote-order.wasm  QuoteOrder (FORG-31), pure, from impl/quote-order-rs
//   impl/price-cart.wasm   PriceCart (FORG-36), imports `Product read`, from impl/price-cart-rs
//
//   node examples/pricing/build-component.mjs [name]           # rebuild and write impl/<name>.wasm (default: all)
//   node examples/pricing/build-component.mjs --check [name]   # rebuild elsewhere, compare with the committed bytes
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
//   StableCrateId differ per host. That changes every v0 symbol hash in the unit crate and wit_bindgen,
//   which changes the order LTO and wasm-ld lay out functions. `strip` drops the names but keeps
//   the order, so the same code came out permuted (FORG-35: macOS and Linux CI disagreed).
import { execFileSync } from "node:child_process";
import { chmodSync, cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";

export const TOOLCHAIN = { rustc: "1.97.1", "wit-bindgen": "0.63.0", "wasm-tools": "1.262.0" };

const here = import.meta.dirname;
export const COMPONENTS = ["quote-order", "price-cart"];
const crateOf = (name) => join(here, `impl/${name}-rs`);
const committedOf = (name) => join(here, `impl/${name}.wasm`);

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

export function buildComponent(name, src = crateOf(name)) {
  requireVersion("rustc", run("rustc", ["--version"], { cwd: src }), TOOLCHAIN.rustc);
  requireVersion("wasm-tools", run("wasm-tools", ["--version"]), TOOLCHAIN["wasm-tools"]);
  const target = mkdtempSync(join(tmpdir(), `${name}-target-`));
  try {
    const cargoHome = process.env.CARGO_HOME ?? join(homedir(), ".cargo");
    const sysroot = run("rustc", ["--print", "sysroot"], { cwd: src });
    const remap = [`${resolve(src)}=${name}-rs`, `${cargoHome}=cargo`, `${sysroot}=rust`, `${target}=target`];
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
    const core = join(target, `wasm32-unknown-unknown/release/${name.replaceAll("-", "_")}.wasm`);
    const out = join(target, `${name}.wasm`);
    run("wasm-tools", ["component", "new", core, "-o", out]);
    run("wasm-tools", ["validate", "--features", "component-model", out]);
    return readFileSync(out);
  } finally {
    rmSync(target, { recursive: true, force: true });
  }
}

const sha = (b) => `sha256:${createHash("sha256").update(b).digest("hex")}`;

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const check = args.includes("--check");
  const names = args.filter((a) => a !== "--check");
  for (const n of names) if (!COMPONENTS.includes(n)) throw new Error(`unknown component ${n}; expected one of ${COMPONENTS.join(", ")}`);
  let stale = false;
  for (const name of names.length ? names : COMPONENTS) {
    if (check) {
      // Build from a copy in another directory: the bytes must not depend on the checkout path.
      const dir = mkdtempSync(join(tmpdir(), `${name}-src-`));
      try {
        cpSync(crateOf(name), dir, { recursive: true });
        const fresh = buildComponent(name, dir);
        const want = readFileSync(committedOf(name));
        if (Buffer.compare(fresh, want) !== 0) {
          console.error(`impl/${name}.wasm is stale: committed ${sha(want)}, rebuilt ${sha(fresh)}`);
          stale = true;
        } else {
          console.log(`impl/${name}.wasm reproduces: ${sha(want)} (${want.byteLength} bytes)`);
        }
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    } else {
      const bytes = buildComponent(name);
      writeFileSync(committedOf(name), bytes);
      console.log(`wrote impl/${name}.wasm ${sha(bytes)} (${bytes.byteLength} bytes)`);
    }
  }
  if (stale) process.exit(1);
}
