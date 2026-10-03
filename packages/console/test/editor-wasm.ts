import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { language } from "../web/editor/language.js";

function wasmPath() {
  try {
    if (import.meta.url.startsWith("file:")) {
      return fileURLToPath(new URL("../generated/editor.wasm", import.meta.url));
    }
  } catch {
    // A jsdom test worker rewrites import.meta.url so Node cannot read it.
  }
  return resolve(process.cwd(), "generated/editor.wasm");
}

export const inspect = await language(readFileSync(wasmPath()));
