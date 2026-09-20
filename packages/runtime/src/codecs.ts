/**
 * Boundary codecs, normalizers, constraints, and key codecs. Normative
 * behaviour lives in specs/codecs/README.md; every vector file there runs
 * against this module.
 */

export class CodecError extends Error {
  constructor(public readonly code: string, message?: string) {
    super(message ?? code);
  }
}

const fail = (code: string, message?: string): never => {
  throw new CodecError(code, message);
};

// ------------------------------------------------------------------ text

const c = String.fromCharCode;
// C0 controls except \t \n \r, plus DEL.
const CONTROL = new RegExp(`[${c(0)}-${c(8)}${c(11)}${c(12)}${c(14)}-${c(31)}${c(127)}]`);

export function decodeText(input: unknown, normalizers: string[] = []): string {
  if (typeof input !== "string") return fail("InvalidText", "expected a string");
  if (!input.isWellFormed()) return fail("InvalidText", "lone surrogate");
  if (CONTROL.test(input)) return fail("InvalidText", "control character");
  let s = input.normalize("NFC");
  for (const n of normalizers) {
    switch (n) {
      case "trim":
        s = s.trim();
        break;
      case "uppercase":
        s = s.toUpperCase();
        break;
      case "lowercase":
        s = s.toLowerCase();
        break;
      default:
        return fail("UnknownNormalizer", n);
    }
  }
  return s;
}

/** Length in Unicode scalar values of NFC-normalized text. */
export function codePointLength(s: string): number {
  let n = 0;
  for (const _ of s) n++;
  return n;
}

export function checkLength(s: string, min?: number, max?: number): string {
  const len = codePointLength(s);
  if ((min !== undefined && len < min) || (max !== undefined && len > max)) return fail("LengthOutOfRange", `length ${len} not in [${min ?? 0}, ${max ?? "inf"}]`);
  return s;
}

// --------------------------------------------------------------- integer

const MAX_SAFE = Number.MAX_SAFE_INTEGER;
const INT_LITERAL = /^-?(0|[1-9][0-9]*)$/;

export function decodeInteger(input: unknown, opts: { min?: number | undefined; max?: number | undefined; rawJson?: string | undefined } = {}): number {
  if (typeof input !== "number") return fail("InvalidInteger", "expected a number");
  if (opts.rawJson !== undefined) {
    // `1.0` and `1e3` are rejected even though JSON.parse would accept them.
    if (!INT_LITERAL.test(opts.rawJson.trim())) return fail("InvalidInteger", "not an integer literal");
    if (BigInt(opts.rawJson.trim()) > BigInt(MAX_SAFE) || BigInt(opts.rawJson.trim()) < -BigInt(MAX_SAFE)) return fail("OutOfRange", "beyond the safe integer range");
  }
  if (!Number.isInteger(input)) return fail("InvalidInteger", "not an integer");
  if (Math.abs(input) > MAX_SAFE) return fail("OutOfRange", "beyond the safe integer range");
  if (opts.min !== undefined && input < opts.min) return fail("OutOfRange", `less than ${opts.min}`);
  if (opts.max !== undefined && input > opts.max) return fail("OutOfRange", `greater than ${opts.max}`);
  return input;
}

// --------------------------------------------------------------- decimal

const CURRENCY_SCALE: Record<string, number> = { USD: 2, EUR: 2, GBP: 2, CAD: 2, AUD: 2, CHF: 2, JPY: 0, KWD: 3, BHD: 3, CLP: 0, KRW: 0 };

export function currencyScale(currency: string): number {
  const s = CURRENCY_SCALE[currency];
  if (s === undefined) return fail("UnknownCurrency", currency);
  return s;
}

const DECIMAL = /^(-?)([0-9]+)(?:\.([0-9]+))?$/;

/** Exact fixed-point decoding to minor units (bigint), then canonical string at the declared scale. */
export function decodeDecimal(input: unknown, opts: { scale?: number | undefined; currency?: string | undefined; min?: string | undefined; max?: string | undefined }): string {
  const scale = opts.currency !== undefined ? currencyScale(opts.currency) : (opts.scale ?? 2);
  if (typeof input !== "string") return fail("InvalidDecimal", "decimals are strings on the wire");
  const m = DECIMAL.exec(input);
  if (!m) return fail("InvalidDecimal", "not a canonical decimal");
  const [, sign, intPart, frac = ""] = m;
  if (frac.length > scale) return fail("PrecisionExceeded", `more than ${scale} fractional digits`);
  const minor = BigInt(intPart! + frac.padEnd(scale, "0")) * (sign === "-" ? -1n : 1n);
  if (minor > BigInt(MAX_SAFE) || minor < -BigInt(MAX_SAFE)) return fail("OutOfRange", "beyond the exact minor-unit range");
  if (opts.min !== undefined && minor < toMinor(opts.min, scale)) return fail("OutOfRange", `less than ${opts.min}`);
  if (opts.max !== undefined && minor > toMinor(opts.max, scale)) return fail("OutOfRange", `greater than ${opts.max}`);
  return formatMinor(minor, scale);
}

export function toMinor(text: string, scale: number): bigint {
  const m = DECIMAL.exec(text);
  if (!m) return fail("InvalidDecimal");
  const [, sign, intPart, frac = ""] = m;
  if (frac.length > scale) return fail("PrecisionExceeded");
  return BigInt(intPart! + frac.padEnd(scale, "0")) * (sign === "-" ? -1n : 1n);
}

export function formatMinor(minor: bigint, scale: number): string {
  const neg = minor < 0n;
  const digits = (neg ? -minor : minor).toString().padStart(scale + 1, "0");
  const int = digits.slice(0, digits.length - scale);
  const frac = digits.slice(digits.length - scale);
  const body = scale > 0 ? `${int}.${frac}` : int;
  return neg && minor !== 0n ? `-${body}` : body;
}

// -------------------------------------------------------------- temporal

const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const DATETIME = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?(Z|[+-]\d{2}:\d{2})$/;
const LOCALTIME = /^(\d{2}):(\d{2})(?::(\d{2}))?$/;
const DURATION = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/;

function validYmd(y: number, m: number, d: number): boolean {
  if (m < 1 || m > 12 || d < 1) return false;
  const leap = (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
  const dim = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m - 1]!;
  return d <= dim;
}

export function decodeDate(input: unknown): string {
  if (typeof input !== "string") return fail("InvalidDate");
  const m = DATE.exec(input);
  if (!m) return fail("InvalidDate", "expected YYYY-MM-DD");
  if (!validYmd(+m[1]!, +m[2]!, +m[3]!)) return fail("InvalidDate", "no such calendar date");
  return input;
}

export function decodeDatetime(input: unknown, precision: "ms" | "s" = "ms"): string {
  if (typeof input !== "string") return fail("InvalidDatetime");
  const m = DATETIME.exec(input);
  if (!m) return fail("InvalidDatetime", "expected RFC 3339 with an offset");
  const [, y, mo, d, h, mi, s, frac, off] = m;
  if (!validYmd(+y!, +mo!, +d!) || +h! > 23 || +mi! > 59 || +s! > 59) return fail("InvalidDatetime", "invalid date or time component");
  const maxFrac = precision === "ms" ? 3 : 0;
  if ((frac ?? "").length > maxFrac) return fail("PrecisionExceeded", `finer than ${precision}`);
  const ms = Date.UTC(+y!, +mo! - 1, +d!, +h!, +mi!, +s!, frac ? Number(frac.padEnd(3, "0")) : 0);
  let offsetMs = 0;
  if (off !== "Z") {
    const sign = off!.startsWith("-") ? -1 : 1;
    offsetMs = sign * (Number(off!.slice(1, 3)) * 60 + Number(off!.slice(4, 6))) * 60_000;
  }
  const iso = new Date(ms - offsetMs).toISOString();
  return precision === "ms" ? iso : iso.slice(0, 19) + "Z";
}

export function decodeLocalTime(input: unknown): string {
  if (typeof input !== "string") return fail("InvalidLocalTime");
  const m = LOCALTIME.exec(input);
  if (!m || +m[1]! > 23 || +m[2]! > 59 || (m[3] !== undefined && +m[3] > 59)) return fail("InvalidLocalTime");
  return `${m[1]}:${m[2]}:${m[3] ?? "00"}`;
}

export function decodeDuration(input: unknown): string {
  if (typeof input !== "string") return fail("InvalidDuration");
  const m = DURATION.exec(input);
  if (!m || input === "P" || input === "PT") return fail("InvalidDuration", "fixed units only (D, H, M, S)");
  return input;
}

// ------------------------------------------------------------------ enum

export function decodeEnum(input: unknown, values: string[]): string {
  if (typeof input !== "string" || !values.includes(input)) return fail("InvalidEnumValue", `expected one of ${values.join(", ")}`);
  return input;
}

// -------------------------------------------------------------- sort key

const OFFSET = 1n << 63n;

/** Order-preserving encoding (sort.v1). */
export function sortKey(value: unknown, type: string, opts: { scale?: number | undefined } = {}): string {
  if (value === null || value === undefined) return "";
  switch (type) {
    case "integer":
      return (BigInt(value as number) + OFFSET).toString(16).padStart(16, "0");
    case "decimal":
    case "money":
      return (toMinor(String(value), opts.scale ?? 2) + OFFSET).toString(16).padStart(16, "0");
    case "boolean":
      return value ? "1" : "0";
    default:
      return String(value).normalize("NFC");
  }
}

/** Compare two encoded sort keys by UTF-8 byte order (what D1 BINARY and DynamoDB use). */
export function compareBytes(a: string, b: string): number {
  const enc = new TextEncoder();
  const [x, y] = [enc.encode(a), enc.encode(b)];
  const n = Math.min(x.length, y.length);
  for (let i = 0; i < n; i++) {
    if (x[i] !== y[i]) return x[i]! < y[i]! ? -1 : 1;
  }
  return x.length - y.length;
}

// -------------------------------------------------------------- identity

const BS = String.fromCharCode(92);

export function encodeIdentity(components: string[]): string {
  return components.map((p) => p.split(BS).join(BS + BS).split("#").join(BS + "#")).join("#");
}

export function decodeIdentity(key: string): string[] {
  const out: string[] = [];
  let cur = "";
  for (let i = 0; i < key.length; i++) {
    const ch = key[i]!;
    if (ch === BS) {
      cur += key[++i] ?? "";
    } else if (ch === "#") {
      out.push(cur);
      cur = "";
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out;
}

// --------------------------------------------------------- vector runner

export interface VectorCase {
  name: string;
  params: Record<string, unknown>;
  input?: unknown;
  input_json?: string;
  input_list?: unknown[];
  expect?: unknown;
  error?: string;
  expect_order?: unknown[];
  expect_distinct?: boolean;
}

type Outcome = { value: unknown } | { error: string } | { order: unknown[] } | { distinct: boolean };

function inputOf(v: VectorCase): { value: unknown; raw?: string } {
  if (v.input_json !== undefined) {
    try {
      return { value: JSON.parse(v.input_json), raw: v.input_json };
    } catch {
      return { value: Symbol("unparseable"), raw: v.input_json };
    }
  }
  return { value: v.input };
}

export function runVector(codec: string, v: VectorCase): Outcome {
  const p = v.params;
  try {
    if (v.input_list !== undefined) {
      if (codec === "identity.v1") {
        const encoded = (v.input_list as string[][]).map(encodeIdentity);
        if (v.expect_distinct !== undefined) return { distinct: new Set(encoded).size === encoded.length };
        const order = [...(v.input_list as string[][])].sort((a, b) => compareBytes(encodeIdentity(a), encodeIdentity(b)));
        return { order };
      }
      const type = String(p["type"]);
      const keyed = v.input_list.map((x) => ({ x, k: sortKey(x, type, { scale: p["scale"] as number | undefined }) }));
      keyed.sort((a, b) => compareBytes(a.k, b.k));
      return { order: keyed.map((e) => (type === "text" && e.x !== null ? String(e.x).normalize("NFC") : e.x)) };
    }
    const { value, raw } = inputOf(v);
    if (typeof value === "symbol") return { error: "InvalidText" };
    switch (codec) {
      case "text.normalize":
        return { value: decodeText(value, (p["normalizers"] as string[]) ?? []) };
      case "text.length":
        return { value: checkLength(decodeText(value), p["min"] as number | undefined, p["max"] as number | undefined) };
      case "integer":
        return { value: decodeInteger(value, { min: p["min"] as number | undefined, max: p["max"] as number | undefined, ...(raw !== undefined ? { rawJson: raw } : {}) }) };
      case "decimal":
        return { value: decodeDecimal(value, { scale: p["scale"] as number | undefined, currency: p["currency"] as string | undefined, min: p["min"] as string | undefined, max: p["max"] as string | undefined }) };
      case "temporal":
        switch (p["kind"]) {
          case "date":
            return { value: decodeDate(value) };
          case "datetime":
            return { value: decodeDatetime(value, (p["precision"] as "ms" | "s") ?? "ms") };
          case "localTime":
            return { value: decodeLocalTime(value) };
          case "duration":
            return { value: decodeDuration(value) };
        }
        break;
      case "enum":
        return { value: decodeEnum(value, Object.values(p["members"] as Record<string, string>)) };
      case "sort.v1":
        return { value: sortKey(value, String(p["type"]), { scale: p["scale"] as number | undefined }) };
      case "identity.v1":
        return { value: encodeIdentity(value as string[]) };
    }
    throw new Error(`unknown codec ${codec}`);
  } catch (e) {
    if (e instanceof CodecError) return { error: e.code };
    throw e;
  }
}
