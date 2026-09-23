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

/** Stable object-key order used to compare normalized set members. */
function canonicalCollectionValue(value:unknown):string {
  if (Array.isArray(value)) return `[${value.map(canonicalCollectionValue).join(",")}]`;
  if (value && typeof value==="object") return `{${Object.entries(value).sort(([a],[b])=>a<b?-1:a>b?1:0).map(([k,v])=>`${JSON.stringify(k)}:${canonicalCollectionValue(v)}`).join(",")}}`;
  return JSON.stringify(value);
}

/** Decode one wire value of a declared type into its canonical form. */
export function decodeValue(model: Model, t: TypeSpec, input: unknown, depth = 0): unknown {
  if (depth > 12) throw new CodecError("NestingTooDeep");
  if (input === null && t.optional) return null;
  const b = t.base;
  if (b.kind === "collection") {
    const max = Math.min(...t.constraints.filter(c=>c.kind==="length" && c.max!==undefined).map(c=>c.kind==="length"?c.max!:Infinity));
    const min = Math.max(0,...t.constraints.filter(c=>c.kind==="length").map(c=>c.kind==="length"?c.min ?? 0:0));
    if (!Number.isFinite(max) || max>1024) throw new CodecError("UnboundedCollection");
    const map = b.collection === "map";
    if (map ? input===null || typeof input!=="object" || Array.isArray(input) : !Array.isArray(input)) throw new CodecError("InvalidCollection");
    const count = map ? Object.keys(input as object).length : (input as unknown[]).length;
    if (count<min || count>max) throw new CodecError("LengthOutOfRange");
    let result: unknown;
    if (map) {
      result=Object.fromEntries(Object.entries(input as Wire).sort(([a],[b])=>a<b?-1:a>b?1:0).map(([key,value])=>{
        if (new TextEncoder().encode(key).length>256) throw new CodecError("MapKeyTooLong");
        return [key,decodeValue(model,b.element,value,depth+1)];
      }));
    } else {
      const items=(input as unknown[]).map(value=>decodeValue(model,b.element,value,depth+1));
      if (b.collection==="set") {
        const pairs=items.map(value=>[canonicalCollectionValue(value),value] as const).sort(([a],[b])=>a<b?-1:a>b?1:0);
        if (pairs.some(([key],i)=>i>0&&pairs[i-1]![0]===key)) throw new CodecError("DuplicateSetValue");
        result=pairs.map(([,value])=>value);
      } else result=items;
    }
    if (new TextEncoder().encode(JSON.stringify(result)).length>256*1024) throw new CodecError("CollectionTooLarge");
    return result;
  }
  if (b.kind === "shape") {
    const shape=model.bundle.ir.modules.flatMap(m=>m.shapes ?? []).find(s=>s.id===b.id);
    if (!shape || input===null || typeof input!=="object" || Array.isArray(input)) throw new CodecError("InvalidShape");
    const values=input as Wire;
    if (Object.keys(values).some(key=>!shape.fields.some(f=>f.name===key))) throw new CodecError("UnknownField");
    return Object.fromEntries([...shape.fields].sort((a,b)=>a.name<b.name?-1:1).map(f=>{
      const value=Object.hasOwn(values,f.name)?values[f.name]:defaultOf(model,f);
      if (value===undefined || value===null&&!f.type.optional) throw new CodecError("Required");
      return [f.name,decodeValue(model,f.type,value,depth+1)];
    }));
  }
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
        if (b.name === "timezone") {
          try {
            if (/^[+-]/.test(s)) throw new RangeError("Expected named timezone");
            new Intl.DateTimeFormat("en-US", { timeZone: s });
          } catch { throw new CodecError("InvalidTimezone"); }
        }
        if (b.name === "email" && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s)) throw new CodecError("InvalidEmail");
        if (b.name === "countryCode" && !/^[A-Z]{2}$/.test(s)) throw new CodecError("InvalidCountryCode");
        if (b.name === "id" && !/^[A-Za-z0-9_-]{1,64}$/.test(s)) throw new CodecError("InvalidId");
        for (const c of t.constraints) if (c.kind === "pattern" && !new RegExp(c.value, "u").test(s)) throw new CodecError("PatternMismatch");
        return s;
      }
      case "integer": {
        const value = decodeInteger(input, { min: bounds.min as number | undefined, max: bounds.max as number | undefined });
        if (bounds.xmin !== undefined && value <= Number(bounds.xmin) || bounds.xmax !== undefined && value >= Number(bounds.xmax)) throw new CodecError("OutOfRange");
        return value;
      }
      case "decimal":
      case "money": {
        const value = decodeDecimal(input, { ...(b.name === "money" ? { currency: b.args[0] ?? "USD" } : { scale: scaleOf(t) }), min: bounds.min === undefined ? undefined : String(bounds.min), max: bounds.max === undefined ? undefined : String(bounds.max) });
        const minor = toMinor(value, scaleOf(t));
        if (bounds.xmin !== undefined && minor <= toMinor(String(bounds.xmin), scaleOf(t)) || bounds.xmax !== undefined && minor >= toMinor(String(bounds.xmax), scaleOf(t))) throw new CodecError("OutOfRange");
        return value;
      }
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
    if (f.secret) {out[`${f.name}Present`]=stored[f.name]!==null && stored[f.name]!==undefined;continue;}
    if (f.hidden) continue;
    if (f.derived) {
      out[f.name] = evalExpr(model, r, f.derived, stored, f.type);
    } else {
      out[f.name] = stored[f.name] === undefined ? null : stored[f.name];
    }
  }
  return out;
}

/** Infer decimal scales from declared fields, never from numeric-looking text. */
function expressionDecimalScale(model: Model, resource: Resource, expr: import("./model.js").Expr): number | null {
  if (expr.kind === "literal") return expr.literal.type === "decimal" ? (expr.literal.value.split(".")[1]?.length ?? 0) : null;
  if (expr.kind === "unary") return expr.op === "!" ? null : expressionDecimalScale(model, resource, expr.operand);
  if (expr.kind === "binary") {
    if (!["+", "-", "*", "/"].includes(expr.op)) return null;
    const left = expressionDecimalScale(model, resource, expr.lhs), right = expressionDecimalScale(model, resource, expr.rhs);
    return left === null ? right : right === null ? left : Math.max(left, right);
  }
  if (expr.kind !== "name") return null;
  let current = resource;
  for (let i = 0; i < expr.path.length; i++) {
    const field = current.fields.find(f => f.name === expr.path[i]);
    if (!field) return null;
    if (i === expr.path.length - 1) return field.type.base.kind === "scalar" && ["decimal", "money"].includes(field.type.base.name) ? scaleOf(field.type) : null;
    if (field.type.base.kind !== "reference") return null;
    current = model.resource(field.type.base.resource);
  }
  return null;
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
      if (e.op === "&&" && !l) return false;
      if (e.op === "||" && l) return true;
      const rr = evalExpr(model, r, e.rhs, rec, hint, refs);
      if (["==", "!=", "<", "<=", ">", ">="].includes(e.op) && l != null && rr != null) {
        const ls = expressionDecimalScale(model, r, e.lhs), rs = expressionDecimalScale(model, r, e.rhs);
        if (ls !== null || rs !== null) {
          const scale = Math.max(ls ?? 0, rs ?? 0), a = toMinor(String(l), scale), b = toMinor(String(rr), scale);
          return e.op === "==" ? a === b : e.op === "!=" ? a !== b : e.op === "<" ? a < b : e.op === "<=" ? a <= b : e.op === ">" ? a > b : a >= b;
        }
      }
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
