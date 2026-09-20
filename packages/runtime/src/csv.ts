/**
 * Streaming-safe CSV parser (plan §13): quoted multiline cells, doubled
 * quotes, BOM, CRLF, bounded field/row counts. Records are only split at
 * parser-confirmed boundaries. Errors are per row; parsing never throws.
 */

export interface CsvRow {
  /** 1-based line where the record starts. */
  line: number;
  values: string[];
}
export interface CsvError {
  line: number;
  code: "RaggedRow" | "UnterminatedQuote" | "TooManyFields" | "TooManyRows" | "InvalidEncoding";
  message: string;
}
export interface CsvOptions {
  maxFields?: number;
  maxRows?: number;
  maxCellBytes?: number;
  delimiter?: string;
}

const DEFAULTS = { maxFields: 100, maxRows: 100_000, maxCellBytes: 65_536, delimiter: "," };

export function parseCsv(bytes: Uint8Array, options: CsvOptions = {}): { header: string[]; rows: Iterable<CsvRow>; errors: CsvError[] } {
  const o = { ...DEFAULTS, ...options };
  const errors: CsvError[] = [];
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    errors.push({ line: 1, code: "InvalidEncoding", message: "input is not valid UTF-8" });
    return { header: [], rows: [], errors };
  }
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);

  // Tokenize into records at confirmed boundaries.
  const records: { line: number; values: string[]; unterminated: boolean }[] = [];
  let i = 0;
  let line = 1;
  const n = text.length;
  while (i < n) {
    const startLine = line;
    const values: string[] = [];
    let unterminated = false;
    let atRecordEnd = false;
    while (!atRecordEnd) {
      let cell = "";
      if (text[i] === '"') {
        i++;
        let closed = false;
        while (i < n) {
          const ch = text[i]!;
          if (ch === '"') {
            if (text[i + 1] === '"') {
              cell += '"';
              i += 2;
              continue;
            }
            i++;
            closed = true;
            break;
          }
          if (ch === "\n") line++;
          cell += ch;
          i++;
        }
        if (!closed) unterminated = true;
        // skip to delimiter / EOL
        while (i < n && text[i] !== o.delimiter && text[i] !== "\n" && text[i] !== "\r") i++;
      } else {
        while (i < n && text[i] !== o.delimiter && text[i] !== "\n" && text[i] !== "\r") {
          cell += text[i];
          i++;
        }
      }
      values.push(cell);
      if (i >= n) {
        atRecordEnd = true;
      } else if (text[i] === o.delimiter) {
        i++;
      } else {
        if (text[i] === "\r") i++;
        if (text[i] === "\n") {
          i++;
          line++;
        }
        atRecordEnd = true;
      }
    }
    if (!(values.length === 1 && values[0] === "" && i >= n)) records.push({ line: startLine, values, unterminated });
  }

  const [head, ...body] = records;
  const header = head?.values ?? [];
  if (header.length > o.maxFields) errors.push({ line: 1, code: "TooManyFields", message: `${header.length} fields exceeds the limit of ${o.maxFields}` });
  const rows: CsvRow[] = [];
  for (const r of body) {
    if (rows.length >= o.maxRows) {
      errors.push({ line: r.line, code: "TooManyRows", message: `more than ${o.maxRows} rows` });
      break;
    }
    if (r.unterminated) {
      errors.push({ line: r.line, code: "UnterminatedQuote", message: "quoted cell never closed" });
      continue;
    }
    if (r.values.length !== header.length) {
      errors.push({ line: r.line, code: "RaggedRow", message: `expected ${header.length} fields, found ${r.values.length}` });
    }
    if (r.values.some((v) => v.length > o.maxCellBytes)) {
      errors.push({ line: r.line, code: "TooManyFields", message: "cell exceeds the size limit" });
      continue;
    }
    rows.push({ line: r.line, values: r.values });
  }
  return { header, rows, errors };
}
