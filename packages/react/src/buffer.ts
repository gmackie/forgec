/**
 * Explicit edit buffer (plan §23): edits never write directly; they accumulate
 * against loaded records and become a changeset proposal. Server-owned and
 * immutable fields are not editable, whatever the grid does.
 */
import type { UiField, UiResource } from "./descriptor.js";

export type Row = Record<string, unknown>;
export interface RowIssue { row: string; field: string; code: string }

export class EditBuffer {
  private records = new Map<string, Row>();
  private edits = new Map<string, Row>();
  private order: string[] = [];
  private seq = 0;
  private deleted = new Set<string>();

  constructor(readonly resource: UiResource) {}

  load(rows: Row[]): void {
    this.deleted.clear();
    this.records.clear();
    this.edits.clear();
    this.order = [];
    for (const r of rows) {
      const id = String(r["id"]);
      this.records.set(id, r);
      this.order.push(id);
    }
  }

  rows(): string[] {
    return [...this.order];
  }
  isNew(id: string): boolean {
    return id.startsWith("new:");
  }
  record(id: string): Row | undefined {
    return this.records.get(id);
  }
  value(id: string, field: string): unknown {
    const e = this.edits.get(id);
    if (e && field in e) return e[field];
    return this.records.get(id)?.[field] ?? null;
  }

  private field(name: string): UiField | undefined {
    return this.resource.fields.find((f) => f.name === name);
  }
  private editable(id: string, name: string): boolean {
    const f = this.field(name);
    if (!f) return false;
    return this.isNew(id) ? f.editableOnCreate : f.editableOnUpdate;
  }

  /** Empty text on an optional field means "clear" (null); on a required field it is left to validation. */
  private coerce(name: string, raw: unknown): unknown {
    const f = this.field(name)!;
    if (raw === "" || raw === undefined) return f.required ? "" : null;
    if (f.widget === "integer" && typeof raw === "string") return /^-?\d+$/.test(raw) ? Number(raw) : raw;
    if (f.widget === "checkbox" && typeof raw === "string") return raw === "true";
    return raw;
  }

  set(id: string, field: string, raw: unknown): void {
    if (this.isDeleted(id) || !this.editable(id, field)) return;
    const value = this.coerce(field, raw);
    const e = this.edits.get(id) ?? {};
    const original = this.records.get(id)?.[field] ?? null;
    if (!this.isNew(id) && value === original) delete e[field];
    else e[field] = value;
    if (Object.keys(e).length === 0 && !this.isNew(id)) this.edits.delete(id);
    else this.edits.set(id, e);
  }

  addNew(): string {
    const id = `new:${++this.seq}`;
    this.order.push(id);
    this.edits.set(id, {});
    return id;
  }
  remove(id: string): void {
    if (this.isNew(id)) {
      this.order = this.order.filter((x) => x !== id);
      this.edits.delete(id);
    }
  }
  isDeleted(id: string): boolean { return this.deleted.has(id); }
  stageDelete(id: string): void {
    if (this.isNew(id)) this.remove(id);
    else if (this.records.has(id)) this.deleted.add(id);
  }
  restorePending(id: string): void { this.deleted.delete(id); }
  revert(id: string): void {
    this.deleted.delete(id);
    if (this.isNew(id)) this.remove(id);
    else this.edits.delete(id);
  }
  revertAll(): void {
    for (const id of new Set([...this.edits.keys(), ...this.deleted])) this.revert(id);
  }

  dirty(): string[] {
    return this.order.filter((id) => this.deleted.has(id) || (this.edits.has(id) && (this.isNew(id) || Object.keys(this.edits.get(id)!).length > 0)));
  }
  patchFor(id: string): Row {
    return { ...(this.edits.get(id) ?? {}) };
  }
  createFor(id: string): Row {
    const e = this.edits.get(id) ?? {};
    const out: Row = {};
    for (const [k, v] of Object.entries(e)) if (v !== "" && v !== null && v !== undefined) out[k] = v;
    return out;
  }

  validate(): RowIssue[] {
    const issues: RowIssue[] = [];
    for (const id of this.dirty()) {
      if (this.isDeleted(id)) continue;
      for (const f of this.resource.fields) {
        if (!f.required) continue;
        if (!this.isNew(id) && !(f.name in (this.edits.get(id) ?? {}))) continue;
        const v = this.value(id, f.name);
        if (v === "" || v === null || v === undefined) issues.push({ row: id, field: f.name, code: "Required" });
      }
    }
    return issues;
  }

  /** Spreadsheet-style paste: rows by newline, cells by tab, anchored at (row, field). */
  paste(startRow: string, startField: string, text: string): void {
    const editableFields = this.resource.fields.filter((f) => f.editableOnCreate || f.editableOnUpdate).map((f) => f.name);
    const startCol = editableFields.indexOf(startField);
    if (startCol < 0) return;
    const lines = text.replace(/\r\n?/g, "\n").split("\n").filter((l, i, a) => !(i === a.length - 1 && l === ""));
    let rowIdx = this.order.indexOf(startRow);
    for (const line of lines) {
      let id = this.order[rowIdx];
      if (id === undefined) id = this.addNew();
      const cells = line.split("\t");
      cells.forEach((cell, i) => {
        const field = editableFields[startCol + i];
        if (field) this.set(id!, field, cell);
      });
      rowIdx++;
    }
  }
}

export interface ChangesetProposal {
  mode: "atomic" | "resumable";
  operations: { op: string; input: Row }[];
}

export function buildChangeset(b: EditBuffer, mode: "atomic" | "resumable" = "resumable"): ChangesetProposal {
  const operations: { op: string; input: Row }[] = [];
  for (const id of b.dirty()) {
    if (b.isNew(id)) {
      operations.push({ op: `${b.resource.id}.create`, input: b.createFor(id) });
    } else {
      const rec = b.record(id)!;
      const input: Row = b.isDeleted(id) ? { id } : { id, patch: b.patchFor(id) };
      if (b.resource.versioned) input["expectedVersion"] = rec["version"];
      operations.push({ op: `${b.resource.id}.${b.isDeleted(id) ? "delete" : "update"}`, input });
    }
  }
  return { mode, operations };
}
