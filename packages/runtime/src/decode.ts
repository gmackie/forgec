/**
 * The common write pipeline's decode/normalize/validate stages (plan §6):
 * strict decode -> normalizers -> field constraints -> candidate record.
 */
import { CodecError, checkLength, decodeDate, decodeDatetime, decodeDecimal, decodeDuration, decodeEnum, decodeInteger, decodeLocalTime, decodeText, formatMinor, toMinor } from "./codecs.js";
import { err, type ForgeError, type ProblemField } from "./errors.js";
import { scaleOf, type Field, type Literal, type Model, type Resource, type TypeSpec } from "./model.js";

export type Wire = Record<string, unknown>;

function literalValue(l: Literal): unknown {
  switch (l.type) {
    case "int":
      return Number(l.value);
    case "bool":
      return l.value;
    case "null":
      return null;
    case "enumMember":
      return l.value.member; // member name; resolved to wire value below
    default:
      return l.value;
  }
}

function boundsOf(t: TypeSpec): { min?: number | string; max?: number | string; xmin?: number | string; xmax?: number | string } {
  const b: { min?: number | string; max?: number | string; xmin?: number | string; xmax?: number | string } = {};
  for (const c of t.constraints) {
    if (c.kind !== "compare") continue;
    const v = literalValue(c.value) as number | string;
    if (c.op === ">=") b.min = v;
    else if (c.op === "<=") b.max = v;
    else if (c.op === ">") b.xmin = v;
    else if (c.op === "<") b.xmax = v;
  }
  return b;
}

/** Decode one wire value of a declared type into its canonical form. */
export function decodeValue(model: Model, t: TypeSpec, input: unknown): unknown {
  const b = t.base;
  if (b.kind === "scalar") {
    const bounds = boundsOf(t);
    switch (b.name) {
      case "id":
      case "text":
      case "email":
      case "url":
      case "timezone":
      case "countryCode": {
        let s = decodeText(input, t.normalizers);
        const len = t.constraints.find((c) => c.kind === "length");
        if (len && len.kind === "length") s = checkLength(s, len.min, len.max);
        if (b.name === "email" && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s)) throw new CodecError("InvalidEmail");
        if (b.name === "countryCode" && !/^[A-Z]{2}$/.test(s)) throw new CodecError("InvalidCountryCode");
        if (b.name === "id" && !/^[A-Za-z0-9_-]{1,64}$/.test(s)) throw new CodecError("InvalidId");
        for (const c of t.constraints) if (c.kind === "pattern" && !new RegExp(c.value, "u").test(s)) throw new CodecError("PatternMismatch");
        return s;
      }
      case "integer":
        return decodeInteger(input, { min: bounds.min as number | undefined, max: bounds.max as number | undefined });
      case "decimal":
        return decodeDecimal(input, { scale: scaleOf(t), min: bounds.min as string | undefined, max: bounds.max as string | undefined });
      case "money":
        return decodeDecimal(input, { currency: b.args[0] ?? "USD", min: bounds.min !== undefined ? String(bounds.min) : undefined, max: bounds.max !== undefined ? String(bounds.max) : undefined });
      case "boolean":
        if (typeof input !== "boolean") throw new CodecError("InvalidBoolean");
        return input;
      case "date":
        return decodeDate(input);
      case "datetime":
        return decodeDatetime(input);
      case "localTime":
        return decodeLocalTime(input);
      case "duration":
        return decodeDuration(input);
      case "json":
        return input;
      default:
        return decodeText(input);
    }
  }
  if (b.kind === "enum") return decodeEnum(input, model.enumValues(b.id));
  if (b.kind === "status") {
    const r = model.resource(b.resource);
    return decodeEnum(input, r.lifecycle?.states ?? []);
  }
  if (b.kind === "reference" || b.kind === "identity") {
    const s = decodeText(input);
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(s)) throw new CodecError("InvalidId");
    return s;
  }
  return input; // shapes/records/messages: structural validation is M3
}

export function defaultOf(model: Model, f: Field): unknown {
  if (!f.default) return f.type.optional ? null : undefined;
  if (f.default.type === "enumMember") {
    const member = f.default.value.member;
    return model.enums.get(f.default.value.enum)?.members.find((m) => m.name === member)?.value ?? member;
  }
  return literalValue(f.default);
}

export interface DecodeOptions {
  /** create: apply defaults, require required fields; patch: absent = unchanged, null clears optionals */
  mode: "create" | "patch" | "input";
  fields: Field[];
}

/** Decode a wire object against a field list. Collects every failure. */
export function decodeObject(model: Model, input: unknown, opts: DecodeOptions): { value: Wire; errors: ForgeError | null } {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    return { value: {}, errors: err("MalformedRequest", "expected a JSON object") };
  }
  const obj = input as Wire;
  const writable = opts.fields.filter((f) => !f.serverOwned && (!f.synthesized || ["parent", "effectiveFrom", "effectiveUntil"].includes(f.name)) && f.derived === undefined && (opts.mode !== "patch" || !f.immutable));
  const allowed = new Set(writable.map((f) => f.name));
  const unknown = Object.keys(obj).filter((k) => !allowed.has(k));
  if (unknown.length) {
    const fields: ProblemField[] = unknown.sort().map((k) => ({ path: k, code: opts.fields.some((f) => f.name === k) ? "ServerOwned" : "Unknown", message: opts.fields.some((f) => f.name === k) ? `${k} is not writable` : `${k} is not a declared field` }));
    return { value: {}, errors: err("UnknownField", `unknown or server-owned fields: ${unknown.join(", ")}`, { fields }) };
  }
  const out: Wire = {};
  const fields: ProblemField[] = [];
  for (const f of writable) {
    const present = Object.prototype.hasOwnProperty.call(obj, f.name);
    const raw = obj[f.name];
    if (!present) {
      if (opts.mode === "patch") continue;
      const d = defaultOf(model, f);
      if (d === undefined) fields.push({ path: f.name, code: "Required", message: `${f.name} is required` });
      else out[f.name] = d;
      continue;
    }
    if (raw === null) {
      if (f.type.optional) out[f.name] = null;
      else fields.push({ path: f.name, code: "Required", message: `${f.name} cannot be null` });
      continue;
    }
    try {
      out[f.name] = decodeValue(model, f.type, raw);
    } catch (e) {
      if (e instanceof CodecError) fields.push({ path: f.name, code: e.code, message: e.message });
      else throw e;
    }
  }
  return { value: out, errors: fields.length ? err("ValidationFailed", "one or more fields are invalid", { fields }) : null };
}

/** Wire-canonical output: every declared field present, derived fields computed. */
export function canonicalize(model: Model, r: Resource, stored: Wire): Wire {
  const out: Wire = {};
  const ordered = [r.fields.find((f) => f.name === "id"), ...r.fields.filter((f) => f.synthesized), ...r.fields.filter((f) => !f.synthesized && f.name !== "id")].filter((f): f is Field => !!f);
  for (const f of ordered) {
    if (f.hidden) continue;
    if (f.derived) {
      out[f.name] = evalExpr(model, r, f.derived, stored, f.type);
    } else {
      out[f.name] = stored[f.name] === undefined ? null : stored[f.name];
    }
  }
  return out;
}

/** Minimal expression evaluation for derived fields and rules. */
export function evalExpr(model: Model, r: Resource, e: import("./model.js").Expr, rec: Wire, hint?: TypeSpec, refs: Record<string, Wire | null> = {}): unknown {
  switch (e.kind) {
    case "literal":
      return literalValue(e.literal);
    case "name": {
      if (e.path.length === 1) return rec[e.path[0]!];
      // Enum.Member or path through a reference (resolved by the caller into `refs`).
      const [head, ...rest] = e.path;
      const enumName = e.path.slice(0, -1).join(".");
      const enumDecl = [...model.enums.values()].find((x) => x.name === enumName);
      if (enumDecl) return enumDecl.members.find((m) => m.name === e.path.at(-1))?.value;
      let cur: Wire | null | undefined = refs[head!];
      for (const seg of rest) cur = cur ? ((cur as Wire)[seg] as Wire | null) : null;
      return cur ?? null;
    }
    case "unary": {
      const v = evalExpr(model, r, e.operand, rec, hint, refs);
      return e.op === "!" ? !v : typeof v === "number" ? -v : v;
    }
    case "binary": {
      const l = evalExpr(model, r, e.lhs, rec, hint, refs);
      const rr = evalExpr(model, r, e.rhs, rec, hint, refs);
      switch (e.op) {
        case "==":
          return l === rr;
        case "!=":
          return l !== rr;
        case "&&":
          return Boolean(l) && Boolean(rr);
        case "||":
          return Boolean(l) || Boolean(rr);
        case "<":
          return (l as number) < (rr as number);
        case "<=":
          return (l as number) <= (rr as number);
        case ">":
          return (l as number) > (rr as number);
        case ">=":
          return (l as number) >= (rr as number);
        case "+":
        case "-":
        case "*":
        case "/": {
          if (typeof l === "number" && typeof rr === "number") {
            return e.op === "+" ? l + rr : e.op === "-" ? l - rr : e.op === "*" ? l * rr : Math.trunc(l / rr);
          }
          // exact decimal arithmetic in minor units at the field's scale
          const scale = hint ? scaleOf(hint) : 2;
          const a = toMinor(String(l), scale);
          const b = toMinor(String(rr), scale);
          if (e.op === "+") return formatMinor(a + b, scale);
          if (e.op === "-") return formatMinor(a - b, scale);
          throw new Error("decimal * and / are not portable in v1");
        }
      }
      return null;
    }
    case "call":
      throw new Error(`function calls are not supported in expressions: ${e.callee.join(".")}`);
  }
}
