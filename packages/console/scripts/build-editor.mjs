import { execFileSync } from "node:child_process";
import { mkdirSync, copyFileSync } from "node:fs";
import { resolve } from "node:path";
const root = resolve(import.meta.dirname, "../../..");
if (!process.env.FORGE_EDITOR_WASM)
  execFileSync(
    "cargo",
    [
      "build",
      "--manifest-path",
      resolve(root, "Cargo.toml"),
      "-p",
      "forgegraph-editor",
      "--target",
      "wasm32-unknown-unknown",
      "--release",
    ],
    { stdio: "inherit" },
  );
mkdirSync(resolve(import.meta.dirname, "../generated"), { recursive: true });
copyFileSync(
  process.env.FORGE_EDITOR_WASM ||
    resolve(
      root,
      "target/wasm32-unknown-unknown/release/forgegraph_editor.wasm",
    ),
  resolve(import.meta.dirname, "../generated/editor.wasm"),
);
