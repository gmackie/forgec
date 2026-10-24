// WASM-component units (FORG-31), the Node side: check that a component implements the world
// forgec generated for its unit, and transpile it into what a Worker can load. Workers run core
// WebAssembly but not the component model, so a component becomes core module(s) plus JS glue
// (jco). The glue is instantiated with precompiled modules: a Worker cannot compile WASM bytes at
// runtime, so the linker ships the core modules as module imports.
import { componentEmbed, componentNew, componentWit, transpile } from "@bytecodealliance/jco";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const jco = JSON.parse(readFileSync(join(import.meta.dirname, "../node_modules/@bytecodealliance/jco/package.json"), "utf8")) as { version: string };

/** The transpiler a linker must use to reproduce the glue byte for byte. */
export const TRANSPILER = `@bytecodealliance/jco@${jco.version}`;

/**
 * What a component's world looks like from JS: the root world as WIT plus the type declarations
 * jco derives for every interface it reaches. `componentWit` prints only the root world, not the
 * records, variants and enums of the interfaces it uses, so it alone cannot tell two worlds apart.
 */
async function fingerprint(component: Uint8Array): Promise<string> {
  const { files } = await transpile(component, { name: "unit", instantiation: "async", wasiShim: false, quiet: true });
  const dts = Object.keys(files)
    .filter((n) => n.endsWith(".d.ts"))
    .sort()
    .map((n) => `// ${n}\n${new TextDecoder().decode(files[n])}`);
  return [await componentWit(component), ...dts].join("\n");
}

/** The world of the generated WIT, as a component built against it would present it. */
export async function normalizedWorld(wit: string, world = "unit"): Promise<string> {
  return fingerprint(await componentNew(await componentEmbed({ witSource: wit, dummy: true, world })));
}

/** The world a component's type section declares. */
export async function componentWorld(component: Uint8Array): Promise<string> {
  return fingerprint(component);
}

/**
 * Refuses a component whose world is not the one generated from the unit's interface: a
 * component built against a stale or hand-edited WIT fails here, at seal time, not on a call.
 */
export async function verifyComponent(component: Uint8Array, wit: string, label: string): Promise<void> {
  let actual: string;
  try {
    actual = await componentWorld(component);
  } catch (e) {
    throw new Error(`${label}: not a WebAssembly component (${(e as Error).message})`);
  }
  const expected = await normalizedWorld(wit);
  if (actual === expected) return;
  const a = actual.split("\n");
  const b = expected.split("\n");
  const first = a.findIndex((line, i) => line !== b[i]);
  const at = first < 0 ? a.length : first;
  throw new Error(`${label}: the component's world differs from the WIT forgec generated for this unit (first difference at line ${at + 1}: component \`${a[at]?.trim()}\`, generated \`${b[at]?.trim() ?? ""}\`); rebuild it against \`forgec wit\``);
}

export interface TranspileOptions {
  /** Minify the glue (default true). */
  minify?: boolean;
  /** Run wasm-opt over the core module(s) (default false). */
  optimize?: boolean;
}

export interface Transpiled {
  /** ES module exporting `instantiate(getCoreModule, imports)`. */
  glue: Uint8Array;
  /** Core modules by the name the glue asks `getCoreModule` for. */
  core: Record<string, Uint8Array>;
  transpiler: string;
}

export async function transpileComponent(component: Uint8Array, options: TranspileOptions = {}): Promise<Transpiled> {
  const out = await transpile(component, {
    name: "unit",
    instantiation: "async",
    noTypescript: true,
    wasiShim: false,
    quiet: true,
    minify: options.minify ?? true,
    optimize: options.optimize ?? false,
  });
  const glue = out.files["unit.js"];
  if (!glue) throw new Error("jco produced no unit.js");
  const core = Object.fromEntries(Object.entries(out.files).filter(([n]) => n.endsWith(".wasm")));
  return { glue, core, transpiler: TRANSPILER };
}
