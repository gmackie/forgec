// Adapts a transpiled WASM component (jco glue) to the call shape JS units use, driven by the
// lowering forgec emits next to the WIT world (`forge-wit-lowering/1`, crates/forgegraph-planner/src/wit.rs).
// Wire values in, wire values out: field names, enum wire values, integers as numbers, optional
// fields as null. A caller cannot tell a WASM unit from a JS unit with the same interface.
//
// No Node or platform imports: this module runs inside the Worker, next to the glue.

export type WitType =
  | { t: "string" | "s64" | "bool" }
  | { t: "option" | "list" | "map"; of: WitType }
  | { t: "ref"; name: string };

export type WitTypeDef =
  | { kind: "record"; fields: Array<{ wire: string; wit: string; js: string; type: WitType }> }
  | { kind: "enum"; cases: Array<{ case: string; wire: string }> }
  | { kind: "failure"; cases: Array<{ case: string; wire: string }>; fault: boolean };

export interface WitFunction {
  name: string;
  js: string;
  params: Array<{ name: string; type: WitType }>;
  result: WitType | null;
  error: string | null;
}

export interface Lowering {
  version: "forge-wit-lowering/1";
  package: string;
  world: string;
  export: WitFunction;
  types: Record<string, WitTypeDef>;
  imports: Array<{ capability: string; interface: string; functions: WitFunction[] }>;
}

/** What every unit returns to its caller, whatever its kind (the ExternalResult shape). */
export type UnitResult = { ok: true; value: unknown } | { ok: false; code: string; detail?: string };

export class LoweringError extends Error {}

function def(l: Lowering, name: string): WitTypeDef {
  const d = l.types[name];
  if (!d) throw new LoweringError(`lowering has no type ${name}`);
  return d;
}

/** Wire value -> the JS value jco lowers into the component. */
export function lower(l: Lowering, t: WitType, v: unknown, path = "input"): unknown {
  switch (t.t) {
    case "string":
      if (typeof v !== "string") throw new LoweringError(`${path}: expected a string`);
      return v;
    case "bool":
      if (typeof v !== "boolean") throw new LoweringError(`${path}: expected a boolean`);
      return v;
    case "s64":
      if (typeof v !== "number" || !Number.isSafeInteger(v)) throw new LoweringError(`${path}: expected a safe integer`);
      return BigInt(v);
    case "option":
      return v === null || v === undefined ? undefined : lower(l, t.of, v, path);
    case "list":
      if (!Array.isArray(v)) throw new LoweringError(`${path}: expected a list`);
      return v.map((x, i) => lower(l, t.of, x, `${path}[${i}]`));
    case "map":
      if (!v || typeof v !== "object" || Array.isArray(v)) throw new LoweringError(`${path}: expected a map`);
      return Object.keys(v)
        .sort()
        .map((k) => [k, lower(l, t.of, (v as Record<string, unknown>)[k], `${path}.${k}`)]);
    case "ref": {
      const d = def(l, t.name);
      if (d.kind === "enum") {
        const c = d.cases.find((x) => x.wire === v);
        if (!c) throw new LoweringError(`${path}: ${JSON.stringify(v)} is not a member of ${t.name}`);
        return c.case;
      }
      if (d.kind === "record") {
        if (!v || typeof v !== "object" || Array.isArray(v)) throw new LoweringError(`${path}: expected an object`);
        const o = v as Record<string, unknown>;
        const out: Record<string, unknown> = {};
        for (const f of d.fields) out[f.js] = lower(l, f.type, o[f.wire], `${path}.${f.wire}`);
        return out;
      }
      throw new LoweringError(`${path}: a failure is not an input`);
    }
  }
}

/** The JS value jco lifts out of the component -> wire value. */
export function lift(l: Lowering, t: WitType, v: unknown, path = "output"): unknown {
  switch (t.t) {
    case "string":
    case "bool":
      return v;
    case "s64": {
      const n = Number(v as bigint);
      if (!Number.isSafeInteger(n)) throw new LoweringError(`${path}: ${String(v)} exceeds the wire's safe integer range`);
      return n;
    }
    case "option":
      return v === null || v === undefined ? null : lift(l, t.of, v, path);
    case "list":
      return (v as unknown[]).map((x, i) => lift(l, t.of, x, `${path}[${i}]`));
    case "map":
      return Object.fromEntries((v as Array<[string, unknown]>).map(([k, x]) => [k, lift(l, t.of, x, `${path}.${k}`)]));
    case "ref": {
      const d = def(l, t.name);
      if (d.kind === "enum") return d.cases.find((x) => x.case === v)?.wire ?? v;
      if (d.kind === "record") {
        const o = v as Record<string, unknown>;
        const out: Record<string, unknown> = {};
        for (const f of d.fields) out[f.wire] = lift(l, f.type, o[f.js], `${path}.${f.wire}`);
        return out;
      }
      throw new LoweringError(`${path}: a failure is not a value`);
    }
  }
}

/** A `failure` variant (`{ tag, val }`) -> the declared error and its detail. */
export function liftFailure(l: Lowering, name: string, payload: unknown): UnitResult {
  const d = def(l, name);
  if (d.kind !== "failure") throw new LoweringError(`${name} is not a failure variant`);
  const { tag, val } = payload as { tag: string; val: unknown };
  if (d.fault && tag === "fault") {
    const f = val as { code: string; detail?: string };
    return { ok: false, code: f.code, ...(f.detail === undefined ? {} : { detail: f.detail }) };
  }
  const c = d.cases.find((x) => x.case === tag);
  if (!c) throw new LoweringError(`${name}: unknown case ${tag}`);
  return { ok: false, code: c.wire, ...(val === undefined || val === null ? {} : { detail: val as string }) };
}

/** The exports of an instantiated component's world, as jco returns them. */
export type ComponentExports = Record<string, (...args: unknown[]) => unknown>;

/**
 * Binds a component instance's `run` export to the unit call shape. A declared error comes back
 * as `{ ok: false, code, detail }`; a trap or a lowering mismatch throws, as a JS unit's defect would.
 */
export function bindExport(l: Lowering, exports: ComponentExports): (input: unknown) => UnitResult {
  if (l.version !== "forge-wit-lowering/1") throw new LoweringError(`unsupported lowering ${String(l.version)}`);
  if (l.imports.length) throw new LoweringError(`capability imports (${l.imports.map((i) => i.capability).join(", ")}) are not wired for WASM units yet`);
  const e = l.export;
  const fn = exports[e.js];
  if (typeof fn !== "function") throw new LoweringError(`component does not export ${e.name}`);
  return (input) => {
    const args = e.params.map((p) => lower(l, p.type, input, p.name));
    try {
      const out = fn(...args);
      return { ok: true, value: e.result ? lift(l, e.result, out) : null };
    } catch (err) {
      // jco throws a ComponentError whose payload is the `err` value of the result.
      if (e.error && err instanceof Error && "payload" in err) return liftFailure(l, e.error, (err as { payload: unknown }).payload);
      throw err;
    }
  };
}
