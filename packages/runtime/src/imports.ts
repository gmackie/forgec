/**
 * CSV import (plan §13). A file becomes a changeset proposal through a
 * mapping profile: every row is a normal create/update operation, so preview,
 * approval, atomic/resumable commit and per-row results are the changeset's.
 * Import-profile decoding (empty cell = absent, trimming) happens here; the
 * strict API codecs still run on every row.
 */
import { Effect } from "effect";
import { decodeIdentity, encodeIdentity } from "./codecs.js";
import { parseCsv, type CsvError } from "./csv.js";
import type { Wire } from "./decode.js";
import type { CallContext, Engine } from "./engine.js";
import { err, type ForgeError } from "./errors.js";
import type { Resource } from "./model.js";
import { Storage, type RuntimeServices } from "./services.js";

export interface RowError {
  line: number;
  code: string;
  path?: string;
  message: string;
}

function decodeBase64(s: string): Uint8Array {
  return Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
}

export class Imports {
  constructor(private readonly engine: Engine) {}

  handle(action: string, body: Wire, ctx: CallContext): Effect.Effect<any, ForgeError, RuntimeServices> {
    switch (action) {
      case "inspect":
        return this.inspect(body);
      case "stage":
        return this.stage(body, ctx);
      default:
        return Effect.fail(err("MethodNotAllowed", `unknown import action ${action}`));
    }
  }

  private resource(body: Wire): Effect.Effect<Resource, ForgeError> {
    const id = String(body["resource"] ?? "");
    const r = this.engine.model.resources.find((x) => x.id === id);
    if(r?.fields.some(f=>f.secret)) return Effect.fail(err("ValidationFailed","credential resources cannot be staged from CSV"));
    return r ? Effect.succeed(r) : Effect.fail(err("ValidationFailed", `unknown resource ${id}`, { fields: [{ path: "resource", code: "Unknown", message: "not a declared resource" }] }));
  }

  private bytes(body: Wire): Effect.Effect<Uint8Array, ForgeError> {
    if (typeof body["csv"] !== "string") return Effect.fail(err("ValidationFailed", "csv (base64) is required", { fields: [{ path: "csv", code: "Required", message: "base64-encoded file content" }] }));
    try {
      return Effect.succeed(decodeBase64(body["csv"]));
    } catch {
      return Effect.fail(err("MalformedRequest", "csv is not valid base64"));
    }
  }

  private writable(r: Resource): string[] {
    return r.fields.filter((f) => !f.serverOwned && !f.synthesized && !f.derived).map((f) => f.name);
  }

  /** Header -> field suggestion: exact, then case-insensitive, then snake/kebab-insensitive. */
  private suggest(header: string[], r: Resource): Record<string, string> {
    const fields = this.writable(r);
    const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
    const out: Record<string, string> = {};
    for (const h of header) {
      const f = fields.find((x) => x === h) ?? fields.find((x) => norm(x) === norm(h));
      if (f) out[h] = f;
    }
    return out;
  }

  private inspect(body: Wire): Effect.Effect<Wire, ForgeError> {
    const self = this;
    return Effect.gen(function* () {
      const r = yield* self.resource(body);
      const bytes = yield* self.bytes(body);
      const parsed = parseCsv(bytes, { maxRows: 100_000 });
      const rows = [...parsed.rows];
      return { header: parsed.header, rows: rows.length, sample: rows.slice(0, 5).map((x) => x.values), suggestedMapping: self.suggest(parsed.header, r), errors: parsed.errors.map(csvErr) };
    });
  }

  private stage(body: Wire, ctx: CallContext): Effect.Effect<Wire, ForgeError, RuntimeServices> {
    const self = this;
    return Effect.gen(function* () {
      const r = yield* self.resource(body);
      const bytes = yield* self.bytes(body);
      const mapping = (body["mapping"] ?? {}) as Record<string, string>;
      const writable = self.writable(r);
      const bad = Object.entries(mapping).filter(([, f]) => !writable.includes(f));
      if (bad.length) return yield* Effect.fail(err("ValidationFailed", "mapping targets unknown or read-only fields", { fields: bad.map(([h, f]) => ({ path: `mapping.${h}`, code: "Unknown", message: `${f} is not a writable field of ${r.name}` })) }));
      const upsertBy = typeof body["upsertBy"] === "string" ? body["upsertBy"] : null;
      const unique = upsertBy ? r.uniques.find((u) => u.name === upsertBy || (u.fields.length === 1 && u.fields[0] === upsertBy && u.within.length === 0)) : null;
      if (upsertBy && !unique) return yield* Effect.fail(err("ValidationFailed", `upsertBy must name a unique key of ${r.name}`, { fields: [{ path: "upsertBy", code: "Unknown", message: `uniques: ${r.uniques.map((u) => u.name).join(", ")}` }] }));

      const parsed = parseCsv(bytes);
      const rowErrors: RowError[] = parsed.errors.map(csvErr);
      const errorLines = new Set(rowErrors.map((e) => e.line));
      const col = new Map(parsed.header.map((h, i) => [h, i] as const));
      const storage = yield* Storage;
      const seenKeys = new Map<string, number>(); // whole-file uniqueness per unique constraint
      const operations: { op: string; input: Wire; line: number }[] = [];

      for (const row of parsed.rows) {
        if (errorLines.has(row.line)) continue;
        const input: Wire = {};
        for (const [h, f] of Object.entries(mapping)) {
          const i = col.get(h);
          if (i === undefined) continue;
          const raw = row.values[i] ?? "";
          // Import profile: an empty cell is absent (defaults apply); other cells are trimmed text.
          if (raw.trim() === "") continue;
          input[f] = self.coerce(r, f, raw.trim());
        }
        // whole-file duplicates on any unique constraint whose fields are all mapped
        let dup = false;
        for (const u of r.uniques) {
          const keyFields = [...u.within, ...u.fields];
          if (!keyFields.every((k) => input[k] !== undefined)) continue;
          const canonical = keyFields.map((k) => self.canonicalKeyPart(r, k, input[k]));
          const key = encodeIdentity([u.name, ...canonical]);
          const first = seenKeys.get(key);
          if (first !== undefined) {
            rowErrors.push({ line: row.line, code: "DuplicateInFile", path: u.fields[0]!, message: `duplicates ${keyFields.join("+")} of line ${first}` });
            dup = true;
            break;
          }
          seenKeys.set(key, row.line);
        }
        if (dup) continue;
        if (unique) {
          const keyFields = [...unique.within, ...unique.fields];
          if (keyFields.every((k) => input[k] !== undefined)) {
            const values = Object.fromEntries(keyFields.map((k) => [k, self.canonicalKeyPart(r, k, input[k])]));
            const existing = yield* storage.findUnique(ctx.tenant, r, unique, self.engine.claimKey(r, unique, values) ?? "", values);
            if (existing && !existing["deletedAt"]) {
              const patch: Wire = {};
              for (const [k, v] of Object.entries(input)) if (!keyFields.includes(k)) patch[k] = v;
              operations.push({ op: `${r.id}.update`, input: { id: existing["id"], expectedVersion: existing["version"], patch }, line: row.line });
              continue;
            }
          }
        }
        operations.push({ op: `${r.id}.create`, input, line: row.line });
      }
      void decodeIdentity;
      if (operations.length === 0) return yield* Effect.fail(err("ValidationFailed", "no importable rows", { fields: rowErrors.map((e) => ({ path: `line ${e.line}`, code: e.code, message: e.message })) }));
      const cs = yield* self.engine.changesets.handle("propose", { mode: body["mode"] === "atomic" ? "atomic" : "resumable", operations: operations.map(({ op, input }) => ({ op, input })), source: { kind: "csv", lines: operations.map((o) => o.line) } }, ctx);
      return { changeset: cs["id"], rows: [...parsed.rows].length, staged: operations.length, rowErrors };
    });
  }

  /** Import-profile coercion for typed columns; strict API codecs still validate the result. */
  private coerce(r: Resource, field: string, text: string): unknown {
    const f = r.fields.find((x) => x.name === field)!;
    const b = f.type.base;
    if (b.kind === "scalar") {
      if (b.name === "boolean") return /^(true|yes|1)$/i.test(text) ? true : /^(false|no|0)$/i.test(text) ? false : text;
      if (b.name === "integer") return /^-?\d+$/.test(text) ? Number(text) : text;
    }
    return text;
  }

  /** Apply the field's declared normalizers so in-file uniqueness matches the engine's claims. */
  private canonicalKeyPart(r: Resource, field: string, value: unknown): string {
    const f = r.fields.find((x) => x.name === field)!;
    let s = String(value);
    for (const n of f.type.normalizers) {
      if (n === "trim") s = s.trim();
      else if (n === "uppercase") s = s.toUpperCase();
      else if (n === "lowercase") s = s.toLowerCase();
    }
    return s;
  }
}

function csvErr(e: CsvError): RowError {
  return { line: e.line, code: e.code, message: e.message };
}
