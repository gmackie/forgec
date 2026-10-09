import React, { useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@cloudflare/kumo/components/button";
import { Input, Textarea } from "@cloudflare/kumo/components/input";
import { Select } from "@cloudflare/kumo/components/select";
import { Dialog } from "@cloudflare/kumo/components/dialog";
import { Badge } from "@cloudflare/kumo/components/badge";
import { ArrowClockwiseIcon, GraphIcon, PaperPlaneTiltIcon, PlugsConnectedIcon } from "@phosphor-icons/react";
import type { IntegrationResult, IntegrationSummary } from "../src/integrations.js";
import type { OpenApiOperation } from "../src/contract-openapi.js";
import "./operations.css";

type Api = <T>(path: string, method?: string, body?: unknown) => Promise<T>;
type Values = Record<string, string>;
type Sample = { path: Record<string, unknown>; query: Record<string, unknown>; headers: Record<string, unknown>; body?: unknown };
type Operation = OpenApiOperation & { sample: Sample };
interface Described {
  integration: IntegrationSummary;
  contract: { fingerprint: string; serviceId: string; operationCount: number };
  operations: Operation[];
}
interface Draft {
  path: Values;
  query: Values;
  headers: Values;
  body: string;
}
interface HistoryEntry extends IntegrationResult {
  integration: string;
  operationId: string;
  method: string;
  at: string;
}

/** Per-operation drafts survive reloads; responses are never stored. */
export const integrationDraftsKey = "forge.integrations.v1";
function readDrafts(): Record<string, Draft> {
  try {
    const value = JSON.parse(localStorage.getItem(integrationDraftsKey) || "{}");
    return value && typeof value === "object" ? value : {};
  } catch {
    return {};
  }
}
function writeDraft(key: string, draft: Draft) {
  const all = readDrafts();
  all[key] = draft;
  // Keep the most recent 200 drafts.
  const keys = Object.keys(all);
  for (const old of keys.slice(0, Math.max(0, keys.length - 200))) delete all[old];
  try {
    localStorage.setItem(integrationDraftsKey, JSON.stringify(all));
  } catch {
    // Storage full or disabled: drafts are a convenience.
  }
}
const text = (values: Record<string, unknown>): Values =>
  Object.fromEntries(Object.entries(values).map(([k, v]) => [k, typeof v === "string" ? v : JSON.stringify(v)]));
function sampleDraft(op: Operation): Draft {
  return {
    path: text(op.sample.path),
    query: text(op.sample.query),
    headers: text(op.sample.headers),
    body: op.requestBody ? JSON.stringify(op.sample.body ?? {}, null, 2) : "",
  };
}
const isWrite = (op: Operation) => !["get", "head"].includes(op.method);
/** Drop empty optional values so they are not sent as empty strings. */
function filled(values: Values, op: Operation, where: "query" | "header") {
  return Object.fromEntries(
    Object.entries(values).filter(
      ([name, value]) => value !== "" || op.parameters.some((p) => p.in === where && p.name === name && p.required),
    ),
  );
}

function ErrorNote({ error }: { error: string }) {
  return error ? (
    <p className="ops-error" role="alert">
      {error}
    </p>
  ) : null;
}

function Fields({
  title,
  where,
  op,
  values,
  disabled,
  onChange,
}: {
  title: string;
  where: "path" | "query" | "header";
  op: Operation;
  values: Values;
  disabled: boolean;
  onChange: (next: Values) => void;
}) {
  const params = op.parameters.filter((p) => p.in === where);
  if (!params.length) return null;
  return (
    <fieldset className="integration-fields">
      <legend>{title}</legend>
      {params.map((p) => (
        <label key={p.name}>
          <span>
            {p.name}
            {p.required ? " *" : ""}
          </span>
          <Input
            aria-label={`${title} ${p.name}`}
            value={values[p.name] ?? ""}
            disabled={disabled}
            onChange={(e) => onChange({ ...values, [p.name]: e.target.value })}
          />
        </label>
      ))}
    </fieldset>
  );
}

export function IntegrationsExplorer({
  api,
  onUseInGraph,
}: {
  api: Api;
  /** Hand a trimmed OpenAPI document to the Graph tab's importer. */
  onUseInGraph?: ((spec: { text: string; packageName: string; host: string | null }) => void) | undefined;
}) {
  const [configured, setConfigured] = useState<boolean | null>(null);
  const [forgegraph, setForgegraph] = useState(false);
  const [integrations, setIntegrations] = useState<IntegrationSummary[]>([]);
  const [selected, setSelected] = useState("");
  const [described, setDescribed] = useState<Described | null>(null);
  const [operationId, setOperationId] = useState("");
  const [filter, setFilter] = useState("");
  const [draft, setDraft] = useState<Draft>({ path: {}, query: {}, headers: {}, body: "" });
  const [result, setResult] = useState<HistoryEntry | null>(null);
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const epoch = useRef(0);

  useEffect(() => {
    let alive = true;
    api<{ configured: boolean; forgegraph?: boolean; integrations: IntegrationSummary[] }>("/integrations")
      .then((r) => {
        if (!alive) return;
        setConfigured(r.configured);
        setForgegraph(r.forgegraph === true);
        setIntegrations(r.integrations);
        // Presets sort beside apps by name. Open a workspace app when one exists
        // so a pinned catalog does not hide the app the instance was connected for.
        const first = r.integrations.find((item) => item.source === "app") ?? r.integrations[0];
        setSelected((s) => s || first?.id || "");
      })
      .catch((e) => alive && setError((e as Error).message));
    return () => {
      alive = false;
      epoch.current++;
    };
  }, [api]);

  const draftKey = (op: string) => JSON.stringify([selected, op]);
  function selectOperation(op: Operation | undefined) {
    setOperationId(op?.operationId ?? "");
    setDraft(op ? readDrafts()[draftKey(op.operationId)] ?? sampleDraft(op) : { path: {}, query: {}, headers: {}, body: "" });
    setResult(null);
    setError("");
  }
  async function load(id: string) {
    const ticket = ++epoch.current;
    setLoading(true);
    setDescribed(null);
    setError("");
    setResult(null);
    try {
      const next = await api<Described>(`/integrations/${id}`);
      if (ticket !== epoch.current) return;
      setDescribed(next);
      setOperationId("");
    } catch (e) {
      if (ticket === epoch.current) setError((e as Error).message);
    } finally {
      if (ticket === epoch.current) setLoading(false);
    }
  }
  useEffect(() => {
    if (selected) void load(selected);
  }, [selected]);

  const op = described?.operations.find((o) => o.operationId === operationId);
  const visible = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    const ops = (described?.operations ?? []).filter(
      (o) => !needle || `${o.operationId} ${o.method} ${o.path}`.toLowerCase().includes(needle),
    );
    const groups = new Map<string, Operation[]>();
    for (const o of ops) groups.set(o.tags[0] ?? "", [...(groups.get(o.tags[0] ?? "") ?? []), o]);
    return [...groups.entries()];
  }, [described, filter]);
  function update(next: Draft) {
    setDraft(next);
    if (op) writeDraft(draftKey(op.operationId), next);
  }

  async function send() {
    if (!op || !described) return;
    setConfirming(false);
    let body: unknown;
    if (op.requestBody) {
      try {
        body = JSON.parse(draft.body || "null");
      } catch {
        setError("The request body is not valid JSON.");
        return;
      }
    }
    setBusy(true);
    setError("");
    const ticket = epoch.current;
    try {
      const reply = await api<IntegrationResult>(`/integrations/${selected}/call`, "POST", {
        operationId: op.operationId,
        path: draft.path,
        query: filled(draft.query, op, "query"),
        headers: filled(draft.headers, op, "header"),
        ...(op.requestBody ? { body } : {}),
        ...(isWrite(op) ? { confirmWrite: true } : {}),
      });
      if (ticket !== epoch.current) return;
      const entry = { ...reply, integration: described.integration.name, operationId: op.operationId, method: op.method, at: new Date().toISOString() };
      setResult(entry);
      setHistory((h) => [entry, ...h].slice(0, 10));
    } catch (e) {
      if (ticket === epoch.current) setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function useInGraph() {
    if (!op || !described || !onUseInGraph) return;
    try {
      const spec = await api<unknown>(`/integrations/${selected}/openapi?operation=${encodeURIComponent(op.operationId)}`);
      const host = described.integration.baseUrl ? new URL(described.integration.baseUrl).hostname : null;
      onUseInGraph({ text: JSON.stringify(spec, null, 2), packageName: `@external/${selected}`, host });
    } catch (e) {
      setError((e as Error).message);
    }
  }

  const integration = described?.integration;
  const writeBlocked = !!op && isWrite(op) && !integration?.writes;
  return (
    <div className="ops-workspace">
      <header className="heading">
        <div>
          <p className="eyebrow">INTEGRATIONS</p>
          <h1>Integrations</h1>
          <p className="muted">
            Browse and call ForgeGraph apps and pinned third-party APIs. Requests go through this console, which
            adds the credentials.
          </p>
        </div>
        <PlugsConnectedIcon size={34} />
      </header>
      {configured === false && (
        <section className="panel ops-empty">
          <h2>Connect ForgeGraph</h2>
          <p>
            Set <code>FORGEGRAPH_URL</code> and a read-scope <code>FORGEGRAPH_TOKEN</code> on this instance to list
            its apps. Each app appears here once it publishes a contract with <code>fg contract publish</code>.
          </p>
        </section>
      )}
      {configured && !forgegraph && (
        <p className="muted">
          Presets are available now. ForgeGraph apps join this list once <code>FORGEGRAPH_URL</code> and a
          read-scope <code>FORGEGRAPH_TOKEN</code> are set, and each app publishes a contract.
        </p>
      )}
      {configured && (
        <div className="ops-toolbar">
          <Select
            aria-label="Integration"
            value={selected}
            items={Object.fromEntries(integrations.map((i) => [i.id, i.name]))}
            placeholder="Choose an integration"
            disabled={busy || loading}
            onValueChange={(v) => setSelected(String(v))}
          />
          <Button icon={<ArrowClockwiseIcon />} disabled={!selected || busy || loading} onClick={() => void load(selected)}>
            Reload contract
          </Button>
        </div>
      )}
      <ErrorNote error={error} />
      {loading && <p role="status">Loading the published contract…</p>}
      {described && integration && (
        <>
          <div className="ops-build">
            <span className={`ops-status ${integration.baseUrl ? "status-healthy" : "status-unknown"}`}>
              {integration.baseUrl ? "Callable" : "No base URL"}
            </span>
            <code>{integration.baseUrl ?? "Set baseUrl in INTEGRATIONS_JSON"}</code>
            <small>
              {described.operations.length} operations · {integration.source === "preset" ? "preset" : "ForgeGraph app"} ·{" "}
              contract {described.contract.fingerprint.slice(7, 19)} ·{" "}
              {integration.writes ? "writes allowed with confirmation" : "read-only"}
            </small>
          </div>
          <div className="playground-grid">
            <aside className="ops-functions integration-operations">
              <Input aria-label="Filter operations" placeholder="Filter operations" value={filter} onChange={(e) => setFilter(e.target.value)} />
              {visible.map(([group, ops]) => (
                <div key={group} role="group" aria-label={group}>
                  <h3 className="eyebrow">{group}</h3>
                  {ops.map((o) => (
                    <button
                      key={o.operationId}
                      className={o.operationId === operationId ? "selected" : ""}
                      disabled={busy}
                      onClick={() => selectOperation(o)}
                    >
                      <span>{o.summary}</span>
                      <small>
                        {o.method.toUpperCase()} {o.path}
                      </small>
                    </button>
                  ))}
                </div>
              ))}
              {!visible.length && <p className="muted">No operations match.</p>}
            </aside>
            <div className="playground-main">
              {!op ? (
                <section className="panel ops-empty">
                  <h2>Choose an operation</h2>
                  <p>Pick one from the list to build a request.</p>
                </section>
              ) : (
                <section className="panel">
                  <header className="ops-section">
                    <div>
                      <span className="eyebrow">REQUEST</span>
                      <h2>{op.summary}</h2>
                    </div>
                    <Badge variant={isWrite(op) ? "destructive" : "outline"}>{op.method.toUpperCase()}</Badge>
                  </header>
                  <code className="ops-route">{op.path}</code>
                  <p className="muted">
                    {op.public ? "Public" : "Private"} · authentication: {op.authentication}
                    {op.schemes.length ? ` (${op.schemes.join(", ")})` : ""}
                  </p>
                  <Fields title="Path" where="path" op={op} values={draft.path} disabled={busy} onChange={(path) => update({ ...draft, path })} />
                  <Fields title="Query" where="query" op={op} values={draft.query} disabled={busy} onChange={(query) => update({ ...draft, query })} />
                  <Fields title="Header" where="header" op={op} values={draft.headers} disabled={busy} onChange={(headers) => update({ ...draft, headers })} />
                  {op.requestBody && (
                    <>
                      <div className="ops-section">
                        <label htmlFor="integration-body">Body JSON</label>
                        <Button size="sm" variant="ghost" disabled={busy} onClick={() => update({ ...draft, body: sampleDraft(op).body })}>
                          Generate sample
                        </Button>
                      </div>
                      <Textarea id="integration-body" aria-label="Request body" value={draft.body} disabled={busy} onChange={(e) => update({ ...draft, body: e.target.value })} />
                    </>
                  )}
                  {writeBlocked && (
                    <p className="ops-error" role="note">
                      Writes are not enabled for this integration. An administrator can allow them with
                      <code> "writes": true</code> in <code>INTEGRATIONS_JSON</code>.
                    </p>
                  )}
                  <div className="ops-actions">
                    <Button
                      variant={isWrite(op) ? "destructive" : "primary"}
                      icon={<PaperPlaneTiltIcon />}
                      disabled={busy || !integration.baseUrl || writeBlocked}
                      onClick={() => (isWrite(op) ? setConfirming(true) : void send())}
                    >
                      {busy ? "Sending…" : "Send request"}
                    </Button>
                    {onUseInGraph && (
                      <Button variant="ghost" icon={<GraphIcon />} disabled={busy} onClick={() => void useInGraph()}>
                        Use in graph
                      </Button>
                    )}
                  </div>
                </section>
              )}
              {result && (
                <section className="panel" aria-label="Response">
                  <header className="ops-section">
                    <div>
                      <span className="eyebrow">RESPONSE</span>
                      <h2>
                        {result.status} · {result.durationMs} ms
                      </h2>
                    </div>
                    <Badge variant={result.ok ? "outline" : "destructive"}>{result.ok ? "OK" : "Error"}</Badge>
                  </header>
                  {Object.keys(result.headers).length > 0 && (
                    <dl className="integration-headers">
                      {Object.entries(result.headers).map(([k, v]) => (
                        <React.Fragment key={k}>
                          <dt>{k}</dt>
                          <dd>{v}</dd>
                        </React.Fragment>
                      ))}
                    </dl>
                  )}
                  <pre className="ops-result">
                    {result.bodyKind === "json"
                      ? JSON.stringify(result.body, null, 2)
                      : result.bodyKind === "text"
                        ? String(result.body)
                        : result.bodyKind === "binary"
                          ? "(binary response not shown)"
                          : "(empty response)"}
                  </pre>
                </section>
              )}
              {history.length > 0 && (
                <section className="panel" aria-label="History">
                  <span className="eyebrow">THIS SESSION</span>
                  <ol className="integration-history">
                    {history.map((h) => (
                      <li key={h.at}>
                        <code>
                          {h.method.toUpperCase()} {h.operationId}
                        </code>{" "}
                        → {h.status} ({h.durationMs} ms) · {h.integration}
                      </li>
                    ))}
                  </ol>
                </section>
              )}
            </div>
          </div>
        </>
      )}
      <Dialog.Root open={confirming} onOpenChange={setConfirming}>
        <Dialog>
          <Dialog.Title className="dialog-title">Send this write?</Dialog.Title>
          <Dialog.Description>
            {op?.method.toUpperCase()} {op?.path} on {integration?.name} changes data in that app. It is recorded in the
            audit log under your name.
          </Dialog.Description>
          <footer className="dialog-footer">
            <Button variant="ghost" onClick={() => setConfirming(false)}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={() => void send()}>
              Send write
            </Button>
          </footer>
        </Dialog>
      </Dialog.Root>
    </div>
  );
}
