import { useEffect, useRef, useState } from "react";
import type { ForgeCall } from "./workspace.js";
import type { UiDescriptor, UiField, UiResource } from "./descriptor.js";

type Row = Record<string, unknown>;
export function displayValue(value: unknown, field?: UiField): string {
  if (value === null || value === undefined || value === "") return "—";
  const option = field?.options?.find((o) => o.value === String(value));
  if (option) return option.label;
  if (typeof value === "boolean") return value ? "Yes" : "No";
  return typeof value === "object" ? JSON.stringify(value) : String(value);
}
export function resourcePackage(resource: UiResource): string {
  return resource.id.split("/").slice(0, -2).join("/") || "Application";
}

/** Read operations are taken exclusively from the compiled descriptor. */
export function RecordBrowser({ descriptor, call, initialRoute, onRouteChange }: {
  descriptor: UiDescriptor; call: ForgeCall; initialRoute?: string; onRouteChange?: (route: string) => void;
}) {
  const [route, setRoute] = useState(initialRoute ?? descriptor.resources[0]?.route ?? "");
  const [query, setQuery] = useState("");
  const selected = descriptor.resources.find((r) => r.route === route) ?? descriptor.resources[0];
  const visible = descriptor.resources.filter((r) => `${r.label} ${r.plural} ${resourcePackage(r)}`.toLowerCase().includes(query.toLowerCase()));
  const groups = [...new Set(visible.map(resourcePackage))];
  return <div className="forge-record-browser">
    <nav aria-label="Record collections">
      <label>Find a collection<input type="search" value={query} onChange={(e) => setQuery(e.target.value)} /></label>
      {groups.map((group) => <section key={group}><h3>{group.split("/").pop()?.replaceAll("-", " ").replace(/^./, (s) => s.toUpperCase())}</h3>{visible.filter((r) => resourcePackage(r) === group).map((r) => <button type="button" key={r.id} aria-current={r.id === selected?.id ? "page" : undefined} onClick={() => {setRoute(r.route);onRouteChange?.(r.route);}}>{r.plural}</button>)}</section>)}
      {!visible.length && <p>No matching collections.</p>}
    </nav>
    <main>{selected ? <BrowseCollection key={selected.id} resource={selected} call={call} /> : <p>No record collections are exposed by this application.</p>}</main>
  </div>;
}

function BrowseCollection({ resource, call }: { resource: UiResource; call: ForgeCall }) {
  const [queryIndex, setQueryIndex] = useState(() => Math.max(0, resource.lists.findIndex((l) => !l.params.length)));
  const list = resource.lists[queryIndex];
  const [params, setParams] = useState<Record<string, string>>({});
  const [rows, setRows] = useState<Row[]>([]);
  const [next, setNext] = useState<string | null>(null);
  const [history, setHistory] = useState<(string | undefined)[]>([undefined]);
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState("");
  const [selected, setSelected] = useState<Row | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const epoch = useRef(0);
  const cursor = history[history.length - 1];
  const ready = !!list && list.params.every((p) => params[p]?.trim());
  useEffect(() => {
    const ticket = ++epoch.current;
    setRows([]); setNext(null); setSelected(null); setError("");
    if (!ready || !list) { setLoading(false); return; }
    setLoading(true);
    void call(list.op, { params: Object.fromEntries(list.params.map((p) => [p, params[p]])), limit: 50, ...(cursor ? { cursor } : {}) }).then((result) => {
      if (ticket !== epoch.current) return;
      if (!result.ok) throw Error(result.problem.detail || result.code);
      if (!Array.isArray(result.value?.items)) throw Error("The record response was incomplete. Try again.");
      setRows(result.value.items);
      setNext(typeof result.value.next === "string" && result.value.next !== cursor ? result.value.next : null);
    }).catch((e: unknown) => { if (ticket === epoch.current) setError(e instanceof Error ? e.message : "Unable to load records."); })
      .finally(() => { if (ticket === epoch.current) setLoading(false); });
    return () => { ++epoch.current; };
  }, [call, list, params, cursor, ready, refresh]);
  const columns = resource.fields.filter((f) => resource.tableColumns.includes(f.name));
  const visibleColumns = columns.length ? columns : resource.fields.slice(0, 5);
  const filtered = rows.filter((row) => resource.fields.some((f) => displayValue(row[f.name], f).toLowerCase().includes(search.toLowerCase())));
  const sorted = sort ? [...filtered].sort((a,b) => displayValue(a[sort]).localeCompare(displayValue(b[sort]), undefined, { numeric: true })) : filtered;
  return <section aria-label={resource.plural} className="forge-browse-collection" aria-busy={loading}>
    <header><div><p>RECORDS · BROWSE</p><h2>{resource.plural}</h2></div><button type="button" disabled={!ready || loading} onClick={() => setRefresh((v) => v + 1)}>Refresh records</button></header>
    <div className="forge-browse-controls">
      {resource.lists.length > 1 && <label>View<select value={queryIndex} onChange={(e) => { setQueryIndex(Number(e.target.value)); setParams({}); setHistory([undefined]); setSearch(""); }}>
        {resource.lists.map((l,i) => <option key={l.op} value={i}>{l.label}</option>)}
      </select></label>}
      {list?.params.map((p) => <label key={p}>{p}<input value={params[p] ?? ""} onChange={(e) => { setParams({ ...params, [p]: e.target.value }); setHistory([undefined]); }} /></label>)}
      <label>Search this page<input type="search" value={search} onChange={(e) => setSearch(e.target.value)} /></label>
      <label>Sort this page<select value={sort} onChange={(e) => setSort(e.target.value)}><option value="">Original order</option>{visibleColumns.map((f) => <option key={f.name} value={f.name}>{f.label}</option>)}</select></label>
    </div>
    {error && <p role="alert">{error}</p>}
    <p role="status">{loading ? "Loading records…" : !list ? "No browse query is exposed for this collection." : !ready ? `Enter ${list.params.join(", ")} to browse.` : error ? "Records could not be loaded. Refresh to retry." : `${filtered.length} of ${rows.length} records on this page`}</p>
    {!loading && ready && !error && <div className="forge-browse-table"><table><thead><tr>{visibleColumns.map((f) => <th key={f.name} scope="col">{f.label}</th>)}<th scope="col">Details</th></tr></thead><tbody>
      {sorted.map((row,index) => <tr key={String(row.id ?? index)}>{visibleColumns.map((f) => <td key={f.name}>{displayValue(row[f.name],f)}</td>)}<td><button type="button" onClick={() => setSelected(row)} aria-label={`View ${displayValue(row[resource.titleField] ?? row.id)}`}>View record</button></td></tr>)}
    </tbody></table>{!sorted.length && <p>{rows.length ? "No matching records on this page." : "No records found."}</p>}</div>}
    <div className="forge-browse-pages"><button type="button" disabled={loading || history.length === 1} onClick={() => setHistory((h) => h.slice(0,-1))}>Previous page</button><span>Page {history.length}</span><button type="button" disabled={loading || !next} onClick={() => { if (next) setHistory((h) => [...h,next]); }}>Next page</button></div>
    {selected && <section className="forge-record-detail" aria-label="Record details"><header><h3>{displayValue(selected[resource.titleField] ?? selected.id)}</h3><button type="button" onClick={() => setSelected(null)}>Close details</button></header><dl>{resource.fields.map((f) => <div key={f.name}><dt>{f.label}{f.reference && <small> · {f.reference.resource}</small>}</dt><dd>{displayValue(selected[f.name],f)}</dd></div>)}</dl><p>Showing the fields returned for your current access and purpose.</p></section>}
  </section>;
}
