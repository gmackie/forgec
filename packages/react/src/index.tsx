/**
 * Generic management workspace (plan §23). Renders from the UI descriptor and a
 * ForgeClient-shaped `call`; never touches storage. Lifecycle fields are not
 * editable cells; permitted transitions are actions. Every write goes through
 * an explicit edit buffer -> changeset preview -> commit.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { EditBuffer, buildChangeset, type Row } from "./buffer.js";
import type { UiAction, UiDescriptor, UiField, UiResource } from "./descriptor.js";

export type { UiDescriptor, UiResource, UiField } from "./descriptor.js";
export { EditBuffer, buildChangeset } from "./buffer.js";

export type CallResult = { ok: true; value: any } | { ok: false; code: string; status: number; problem: { code: string; detail?: string; fields?: { path: string; code: string; message: string }[] } };
export type ForgeCall = (op: string, input: unknown, opts?: { idempotencyKey?: string }) => Promise<CallResult>;

export interface WorkspaceProps {
  descriptor: UiDescriptor;
  call: ForgeCall;
  initialRoute?: string;
  onDirtyChange?: (dirty: boolean) => void;
}

const pkgOf = (d: UiDescriptor) => d.package;

export function Workspace({ descriptor, call, initialRoute, onDirtyChange }: WorkspaceProps) {
  const [dirty, setDirty] = useState(false);
  const reportDirty = useCallback((value: boolean) => { setDirty(value); onDirtyChange?.(value); }, [onDirtyChange]);
  const [route, setRoute] = useState(initialRoute ?? descriptor.resources[0]?.route ?? "");
  const resource = descriptor.resources.find((r) => r.route === route) ?? descriptor.resources[0];
  return (
    <div className="forge-workspace" style={{ display: "grid", gridTemplateColumns: "200px 1fr", minHeight: "100vh", fontFamily: "system-ui, sans-serif" }}>
      <nav aria-label="Resources" style={{ borderRight: "1px solid #ddd", padding: 12 }}>
        <h2 style={{ fontSize: 14, margin: "0 0 8px" }}>{descriptor.package}</h2>
        <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
          {descriptor.resources.map((r) => (
            <li key={r.id}>
              <button disabled={dirty && r.route !== route} onClick={() => setRoute(r.route)} aria-current={r.route === route ? "page" : undefined} style={{ display: "block", width: "100%", textAlign: "left", background: r.route === route ? "#eef" : "transparent", border: 0, padding: "6px 8px", cursor: "pointer" }}>
                {r.plural}
              </button>
            </li>
          ))}
        </ul>
      </nav>
      <main style={{ padding: 16 }}>{resource ? <ResourceView key={resource.id} resource={resource} descriptor={descriptor} call={call} onDirtyChange={reportDirty} /> : null}</main>
    </div>
  );
}

// ------------------------------------------------------------------ resource view

interface ViewProps {
  onDirtyChange: (dirty: boolean) => void;
  resource: UiResource;
  descriptor: UiDescriptor;
  call: ForgeCall;
}

function ResourceView({ resource, descriptor, call, onDirtyChange }: ViewProps) {
  const [rows, setRows] = useState<Row[]>([]);
  const [tick, setTick] = useState(0);
  const buffer = useMemo(() => new EditBuffer(resource), [resource]);
  const [preview, setPreview] = useState<{ id: string; contentHash: string; items: any[]; budget: any } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [action, setAction] = useState<{ row: Row; action: UiAction } | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const [listSel, setListSel] = useState(0);
  const [params, setParams] = useState<Record<string, string>>({});
  const bump = () => setTick((t) => t + 1);

  const dirty = buffer.dirty().length > 0;
  const [busy, setBusy] = useState(false);
  useEffect(() => { onDirtyChange(dirty || busy || importOpen || !!action || !!preview); }, [dirty, busy, importOpen, action, preview, onDirtyChange]);
  useEffect(() => {
    if (!dirty && !busy) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty, busy]);
  const perform = async (task: () => Promise<void>) => {
    setBusy(true);
    try { await task(); } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };
  const list = resource.lists[listSel];

  const reload = useCallback(async () => {
    if (!list) return;
    if (list.params.some((p) => !params[p])) {
      setRows([]);
      buffer.load([]);
      bump();
      return;
    }
    const r = await call(list.op, { params: Object.fromEntries(list.params.map((p) => [p, params[p]])), limit: 100 });
    if (r.ok) {
      setRows(r.value.items);
      buffer.load(r.value.items);
      setError(null);
    } else setError(`${r.code}: ${r.problem.detail ?? ""}`);
    bump();
  }, [call, list, params, buffer]);

  useEffect(() => {
    void reload();
  }, [reload]);

  // Resources whose every list needs a parameter are browsed through a reference from another resource;
  // the first parameter-less list, if any, is the default.
  useEffect(() => {
    const i = resource.lists.findIndex((l) => l.params.length === 0);
    if (i >= 0) setListSel(i);
  }, [resource]);

  const doPreview = async () => {
    const issues = buffer.validate();
    if (issues.length) {
      setError(`Fill required fields: ${issues.map((i) => `${i.field} (${i.row})`).join(", ")}`);
      return;
    }
    const proposal = buildChangeset(buffer);
    if (proposal.operations.length === 0) return;
    const pkg = pkgOf(descriptor);
    const p = await call(`${pkg}/_/changesets.propose`, proposal);
    if (!p.ok) return setError(`${p.code}: ${p.problem.detail ?? ""}`);
    const pv = await call(`${pkg}/_/changesets.preview`, { id: p.value.id });
    if (!pv.ok) return setError(`${pv.code}: ${pv.problem.detail ?? ""}`);
    setPreview({ id: p.value.id, contentHash: pv.value.contentHash, items: pv.value.items, budget: pv.value.budget });
  };

  const doCommit = async () => {
    if (!preview) return;
    const pkg = pkgOf(descriptor);
    const a = await call(`${pkg}/_/changesets.approve`, { id: preview.id, contentHash: preview.contentHash });
    if (!a.ok) return setError(`${a.code}: ${a.problem.detail ?? ""}`);
    const c = await call(`${pkg}/_/changesets.commit`, { id: preview.id });
    setPreview(null);
    if (!c.ok) return setError(`${c.code}: ${c.problem.detail ?? ""}`);
    if (c.value.status !== "committed") setError(`Changeset ${c.value.status}: ${c.value.results.filter((r: any) => r.status === "error").map((r: any) => `${r.op.split(".").pop()} #${r.index}: ${r.error.code}`).join("; ")}`);
    buffer.revertAll();
    await reload();
  };

  const runAction = async (input: Row) => {
    if (!action) return;
    const r = await call(action.action.op, { id: action.row["id"], expectedVersion: action.row["version"], input });
    setAction(null);
    if (!r.ok) setError(`${r.code}: ${r.problem.detail ?? ""}`);
    await reload();
  };

  const editableFields = resource.fields.filter((f) => f.editableOnCreate || f.editableOnUpdate);
  const columns = resource.fields.filter((f) => resource.tableColumns.includes(f.name) || editableFields.includes(f));

  return (
    <fieldset disabled={busy} style={{border:0,padding:0,minWidth:0}}>
      {dirty && <p role="status">You have unsaved record changes. Review or revert them before changing collections or filters.</p>}
      <header style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 12 }}>
        <h1 style={{ fontSize: 20, margin: 0 }}>{resource.plural}</h1>
        {resource.lists.length > 1 && (
          <select aria-label="Query" value={listSel} disabled={dirty} onChange={(e) => setListSel(Number(e.target.value))}>
            {resource.lists.map((l, i) => (
              <option key={l.name} value={i}>{l.label}</option>
            ))}
          </select>
        )}
        {list?.params.map((p) => (
          <input key={p} aria-label={`filter ${p}`} placeholder={p} disabled={dirty} value={params[p] ?? ""} onChange={(e) => setParams({ ...params, [p]: e.target.value })} />
        ))}
        <span style={{ flex: 1 }} />
        <button onClick={() => { buffer.addNew(); bump(); }}>Add row</button>
        <button onClick={() => { buffer.revertAll(); bump(); }} disabled={buffer.dirty().length === 0}>Revert</button>
        <button onClick={() => void perform(doPreview)} disabled={buffer.dirty().length === 0}>Preview changes</button>
        <button disabled={dirty} onClick={() => setImportOpen(true)}>Import CSV</button>
      </header>
      {error && (
        <div role="alert" style={{ background: "#fee", border: "1px solid #c99", padding: 8, marginBottom: 8 }}>
          {error} <button onClick={() => setError(null)} aria-label="dismiss">×</button>
        </div>
      )}
      <fieldset disabled={!!preview} style={{border:0,padding:0,minWidth:0}}><table style={{ borderCollapse: "collapse", width: "100%" }}>
        <thead>
          <tr>
            {columns.map((f) => (
              <th key={f.name} style={{ textAlign: "left", borderBottom: "2px solid #ccc", padding: 4 }}>{f.label}</th>
            ))}
            {resource.actions.length > 0 && <th>Actions</th>}
          </tr>
        </thead>
        <tbody>
          {buffer.rows().map((id) => {
            const rec = buffer.record(id);
            const isNew = buffer.isNew(id);
            const dirty = buffer.dirty().includes(id);
            return (
              <tr key={id} data-testid={`row-${id}`} style={{ background: isNew ? "#efe" : dirty ? "#ffd" : undefined }}>
                {columns.map((f) => (
                  <td key={f.name} style={{ padding: 2, borderBottom: "1px solid #eee" }}>
                    <Cell rowId={id} field={f} buffer={buffer} call={call} onChange={bump} readOnly={isNew ? !f.editableOnCreate : !f.editableOnUpdate} />
                  </td>
                ))}
                {resource.actions.length > 0 && (
                  <td>
                    {rec && resource.actions.filter((a) => a.from.includes(String(rec["status"]))).map((a) => (
                      <button key={a.name} disabled={dirty} onClick={() => setAction({ row: rec, action: a })} style={{ marginRight: 4 }}>{a.label}</button>
                    ))}
                  </td>
                )}
              </tr>
            );
          })}
          {rows.length === 0 && buffer.rows().length === 0 && (
            <tr><td colSpan={columns.length + 1} style={{ padding: 12, color: "#666" }}>{list?.params.length ? `Enter ${list.params.join(", ")} to browse.` : "No records."}</td></tr>
          )}
        </tbody>
      </table></fieldset>

      {preview && (
        <dialog open role="dialog" aria-label="Changeset preview" style={{ position: "fixed", inset: "10% 20%", padding: 16, border: "1px solid #999", background: "white", maxHeight: "80vh", overflow: "auto" }}>
          <h2>Review record changes</h2>
          <p>Review {preview.items.length} record change(s) before saving to this environment.</p>
          <ol>
            {preview.items.map((it: any) => (
              <li key={it.index} style={{ marginBottom: 6 }}>
                <strong>{it.op.split(".").slice(-1)[0]} {resource.label}</strong>{" "}
                {it.status === "error" ? (
                  <span style={{ color: "#b00" }}>{it.error.code}{it.error.fields ? ": " + it.error.fields.map((f: any) => `${f.path} ${f.code}`).join(", ") : ""}</span>
                ) : (
                  <span>{(it.diff ?? []).map((d: any) => `${d.path}: ${fmt(d.before)} → ${fmt(d.after)}`).join("; ") || "(no visible changes)"}</span>
                )}
              </li>
            ))}
          </ol>
          <button onClick={() => void perform(doCommit)} disabled={preview.items.every((i: any) => i.status === "error")}>Save changes</button>{" "}
          <button onClick={() => setPreview(null)}>Back</button>
        </dialog>
      )}

      {action && (
        <ActionDialog action={action.action} row={action.row} resource={resource} onRun={input => perform(() => runAction(input))} onCancel={() => setAction(null)} />
      )}

      {importOpen && <ImportDialog resource={resource} descriptor={descriptor} call={call} onDone={async () => { setImportOpen(false); await reload(); }} onCancel={() => setImportOpen(false)} />}
    </fieldset>
  );
}

function fmt(v: unknown): string {
  return v === null || v === undefined ? "∅" : typeof v === "string" ? v : JSON.stringify(v);
}

// ------------------------------------------------------------------ cells

interface CellProps {
  rowId: string;
  field: UiField;
  buffer: EditBuffer;
  call: ForgeCall;
  onChange: () => void;
  readOnly: boolean;
}

function Cell({ rowId, field, buffer, call, onChange, readOnly }: CellProps) {
  const value = buffer.value(rowId, field.name);
  const label = `${field.name} of ${rowId}`;
  const set = (v: unknown) => {
    buffer.set(rowId, field.name, v);
    onChange();
  };
  const onPaste = (e: React.ClipboardEvent) => {
    const text = e.clipboardData.getData("text/plain");
    if (text.includes("\t") || text.includes("\n")) {
      e.preventDefault();
      buffer.paste(rowId, field.name, text);
      onChange();
    }
  };
  if (readOnly || field.widget === "readonly" || field.widget === "status") {
    const display = field.widget === "select" ? field.options?.find((o) => o.value === value)?.label ?? fmt(value) : fmt(value);
    return <span aria-label={label}>{display}</span>;
  }
  switch (field.widget) {
    case "select":
      return (
        <select aria-label={label} value={String(value ?? "")} onChange={(e) => set(e.target.value)}>
          <option value="">—</option>
          {field.options?.map((o) => (
            <option key={o.value} value={o.value}>{o.label}</option>
          ))}
        </select>
      );
    case "checkbox":
      return <input type="checkbox" aria-label={label} checked={Boolean(value)} onChange={(e) => set(e.target.checked)} />;
    case "reference":
      return <ReferencePicker rowId={rowId} field={field} value={value} call={call} onPick={set} />;
    case "textarea":
      return <textarea aria-label={label} value={String(value ?? "")} onChange={(e) => set(e.target.value)} onPaste={onPaste} rows={2} />;
    default:
      return <input aria-label={label} type={field.widget === "integer" ? "number" : field.widget === "date" ? "date" : "text"} value={String(value ?? "")} onChange={(e) => set(e.target.value)} onPaste={onPaste} />;
  }
}

function ReferencePicker({ rowId, field, value, call, onPick }: { rowId: string; field: UiField; value: unknown; call: ForgeCall; onPick: (id: string) => void }) {
  const ref = field.reference!;
  const [text, setText] = useState("");
  const [options, setOptions] = useState<Row[]>([]);
  const [open, setOpen] = useState(false);
  const [picked, setPicked] = useState<Row | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const label = `${field.name} of ${rowId}`;

  useEffect(() => {
    if (typeof value === "string" && value && !picked) {
      void call(`${ref.resource}.get`, { id: value }).then((r) => {
        if (r.ok) {
          setPicked(r.value);
          setText(String(r.value[ref.titleField] ?? value));
        }
      });
    }
  }, [value, picked, call, ref]);

  const pick = (o: Row) => {
    setPicked(o);
    setText(String(o[ref.titleField]));
    setOpen(false);
    onPick(String(o["id"]));
  };

  const search = (q: string) => {
    setText(q);
    setOpen(true);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(async () => {
      // The picker pages the referenced resource's first bounded list; a typed value fills its parameters
      // (e.g. Customer.list.byTier needs a tier). Bounded working set, never a scan.
      const params = Object.fromEntries(ref.lookupParams.map((p) => [p, q]));
      const r = await call(ref.lookup, { params, limit: 20 });
      setOptions(r.ok ? r.value.items : []);
    }, 50);
  };

  return (
    <span style={{ position: "relative" }}>
      <input aria-label={label} value={text} onChange={(e) => search(e.target.value)} onFocus={() => setOpen(true)} placeholder={ref.lookupParams.length ? `type ${ref.lookupParams.join("/")}` : "search"} />
      {picked && <small data-testid={`ref-${rowId}-${field.name}`} style={{ marginLeft: 4, color: "#666" }}>{String(picked["id"])}</small>}
      {open && options.length > 0 && (
        <ul role="listbox" style={{ position: "absolute", zIndex: 2, background: "white", border: "1px solid #999", listStyle: "none", margin: 0, padding: 0, maxHeight: 200, overflow: "auto" }}>
          {options.map((o) => (
            <li key={String(o["id"])} role="option" aria-selected={false} onMouseDown={(e) => { e.preventDefault(); pick(o); }} onClick={() => pick(o)} style={{ padding: "4px 8px", cursor: "pointer" }}>
              {String(o[ref.titleField])}
            </li>
          ))}
        </ul>
      )}
    </span>
  );
}

// ------------------------------------------------------------------ actions

function ActionDialog({ action, row, resource, onRun, onCancel }: { action: UiAction; row: Row; resource: UiResource; onRun: (input: Row) => void; onCancel: () => void }) {
  const [input, setInput] = useState<Row>({});
  return (
    <dialog open role="dialog" aria-label={`${action.label} ${resource.label}`} style={{ position: "fixed", inset: "20% 30%", padding: 16, border: "1px solid #999", background: "white" }}>
      <h2>{action.label} {String(row[resource.titleField] ?? row["id"])}</h2>
      <p>{action.from.join(" | ")} → {action.to}</p>
      {action.inputFields.map((f) => (
        <label key={f.name} style={{ display: "block", marginBottom: 8 }}>
          {f.label}
          <br />
          {f.widget === "textarea" ? (
            <textarea aria-label={f.label} value={String(input[f.name] ?? "")} onChange={(e) => setInput({ ...input, [f.name]: e.target.value })} />
          ) : (
            <input aria-label={f.label} value={String(input[f.name] ?? "")} onChange={(e) => setInput({ ...input, [f.name]: e.target.value })} />
          )}
        </label>
      ))}
      <button onClick={() => onRun(input)}>Run {action.name}</button> <button onClick={onCancel}>Cancel</button>
    </dialog>
  );
}

// ------------------------------------------------------------------ import

function ImportDialog({ resource, descriptor, call, onDone, onCancel }: { resource: UiResource; descriptor: UiDescriptor; call: ForgeCall; onDone: () => void; onCancel: () => void }) {
  const [csv, setCsv] = useState<string | null>(null);
  const [inspection, setInspection] = useState<any>(null);
  const [mapping, setMapping] = useState<Record<string, string>>({});
  const [upsertBy, setUpsertBy] = useState("");
  const [staged, setStaged] = useState<any>(null);
  const [preview, setPreview] = useState<any>(null);
  const [status, setStatus] = useState<string | null>(null);
  const pkg = pkgOf(descriptor);

  const onFile = async (file: File) => {
    const b64 = btoa(String.fromCharCode(...new Uint8Array(await file.arrayBuffer())));
    setCsv(b64);
    const r = await call(`${pkg}/_/imports.inspect`, { resource: resource.id, csv: b64 });
    if (r.ok) {
      setInspection(r.value);
      setMapping(r.value.suggestedMapping);
    } else setStatus(`${r.code}: ${r.problem.detail ?? ""}`);
  };
  const stage = async () => {
    const r = await call(`${pkg}/_/imports.stage`, { resource: resource.id, csv, mapping, ...(upsertBy ? { upsertBy } : {}) });
    if (!r.ok) return setStatus(`${r.code}: ${r.problem.detail ?? ""}`);
    setStaged(r.value);
    const pv = await call(`${pkg}/_/changesets.preview`, { id: r.value.changeset });
    if (pv.ok) setPreview(pv.value);
  };
  const commit = async () => {
    await call(`${pkg}/_/changesets.approve`, { id: staged.changeset, contentHash: preview.contentHash });
    const c = await call(`${pkg}/_/changesets.commit`, { id: staged.changeset });
    setStatus(c.ok ? `Import ${c.value.status}` : `${c.code}`);
    onDone();
  };
  const writable = resource.fields.filter((f) => f.editableOnCreate).map((f) => f.name);

  return (
    <dialog open role="dialog" aria-label={`Import ${resource.plural}`} style={{ position: "fixed", inset: "10% 20%", padding: 16, border: "1px solid #999", background: "white", maxHeight: "80vh", overflow: "auto" }}>
      <h2>Import {resource.plural} from CSV</h2>
      <input type="file" accept=".csv,text/csv" aria-label="CSV file" onChange={(e) => e.target.files?.[0] && void onFile(e.target.files[0])} />
      {inspection && (
        <div>
          <p>{inspection.rows} row(s); columns: {inspection.header.join(", ")}</p>
          {inspection.errors.length > 0 && <p role="alert">{inspection.errors.map((e: any) => `line ${e.line}: ${e.code}`).join("; ")}</p>}
          <table>
            <tbody>
              {inspection.header.map((h: string) => (
                <tr key={h}>
                  <td>{h}</td>
                  <td>
                    <select aria-label={`map ${h}`} value={mapping[h] ?? ""} onChange={(e) => setMapping({ ...mapping, [h]: e.target.value })}>
                      <option value="">(skip)</option>
                      {writable.map((f) => (
                        <option key={f} value={f}>{f}</option>
                      ))}
                    </select>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <label>
            Upsert by <input aria-label="Upsert by" value={upsertBy} onChange={(e) => setUpsertBy(e.target.value)} placeholder="unique key (optional)" />
          </label>{" "}
          <button onClick={stage}>Stage</button>
        </div>
      )}
      {staged && preview && (
        <div>
          <p>{staged.staged} of {staged.rows} row(s) staged{staged.rowErrors.length ? `; ${staged.rowErrors.length} row error(s)` : ""}.</p>
          <ol>
            {preview.items.map((it: any) => (
              <li key={it.index}>{it.op.split(".").pop()} — {it.status === "error" ? it.error.code : (it.diff ?? []).map((d: any) => `${d.path}: ${fmt(d.before)} → ${fmt(d.after)}`).join("; ") || "ok"}</li>
            ))}
          </ol>
          <button onClick={commit}>Commit import</button>
        </div>
      )}
      {status && <p role="status">{status}</p>}
      <button onClick={onCancel}>Close</button>
    </dialog>
  );
}
