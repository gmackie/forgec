import { describe, expect, it } from "vitest";
import { parseCsv, type CsvRow } from "../src/csv.js";

const rows = (text: string, opts = {}) => {
  const out: CsvRow[] = [];
  const r = parseCsv(new TextEncoder().encode(text), opts);
  for (const row of r.rows) out.push(row);
  return { header: r.header, rows: out, errors: r.errors };
};

describe("CSV parser (RFC 4180 subset with the plan's edge cases)", () => {
  it("parses header + rows with CRLF, quotes, embedded commas and doubled quotes", () => {
    const r = rows('code,name,notes\r\n"acme","Acme, Inc.","said ""hi"""\r\nbeta,Beta,\r\n');
    expect(r.header).toEqual(["code", "name", "notes"]);
    expect(r.rows.map((x) => x.values)).toEqual([["acme", "Acme, Inc.", 'said "hi"'], ["beta", "Beta", ""]]);
    expect(r.rows.map((x) => x.line)).toEqual([2, 3]);
  });

  it("handles quoted multiline cells and strips a UTF-8 BOM", () => {
    const r = rows('﻿code,notes\n"a","line1\nline2"\n"b","x"\n');
    expect(r.header).toEqual(["code", "notes"]);
    expect(r.rows.map((x) => x.values)).toEqual([["a", "line1\nline2"], ["b", "x"]]);
    expect(r.rows[1]!.line).toBe(4);
  });

  it("reports ragged rows and unterminated quotes as row errors, never throws", () => {
    const r = rows('a,b\n1,2,3\n"open,2\n');
    expect(r.rows.map((x) => x.values)).toEqual([["1", "2", "3"]]);
    expect(r.errors.map((e) => e.code)).toEqual(["RaggedRow", "UnterminatedQuote"]);
  });

  it("enforces bounded field and row counts", () => {
    const r = rows("a,b\n1,2\n3,4\n5,6\n", { maxRows: 2 });
    expect(r.rows).toHaveLength(2);
    expect(r.errors.map((e) => e.code)).toEqual(["TooManyRows"]);
    const wide = rows("a,b,c\n1,2,3\n", { maxFields: 2 });
    expect(wide.errors.map((e) => e.code)).toEqual(["TooManyFields"]);
  });
});
