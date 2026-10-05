import React, { useEffect, useRef, useState } from "react";
import type {
  GizmoDefinition,
  GizmoProps,
  UiDescriptor,
} from "@forgegraph/react";

type RecordRow = Record<string, unknown>;
// A deliberately narrow example: this UI knows about people, not every resource.
const customerResource = (descriptor: UiDescriptor) =>
  descriptor.resources.find(
    (r) =>
      ["Customer", "Contact"].includes(r.name) &&
      r.fields.some((f) => f.name === r.titleField) &&
      r.lists.some((l) => !l.params.length),
  );
function CustomerDirectory({ descriptor, call, openForms }: GizmoProps) {
  const resource = customerResource(descriptor)!;
  const list = resource.lists.find((l) => !l.params.length)!;
  const [rows, setRows] = useState<RecordRow[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const epoch = useRef(0);
  async function load(next?: string) {
    const ticket = ++epoch.current;
    setLoading(true);
    setError("");
    try {
      const result = await call(list.op, {
        params: {},
        limit: 50,
        ...(next ? { cursor: next } : {}),
      });
      if (ticket !== epoch.current) return;
      if (!result.ok) {
        setError(result.problem.detail || "Unable to load the directory.");
        return;
      }
      if (!Array.isArray(result.value?.items))
        throw Error("The directory response was incomplete. Try again.");
      setRows(result.value.items);
      setCursor(
        typeof result.value.next === "string" ? result.value.next : null,
      );
    } catch (e) {
      if (ticket === epoch.current) setError((e as Error).message);
    } finally {
      if (ticket === epoch.current) setLoading(false);
    }
  }
  useEffect(() => {
    void load();
    return () => {
      epoch.current++;
    };
  }, [call, list.op]);
  const fields = resource.fields.filter((f) =>
    ["email", "code", "tier"].includes(f.name),
  );
  const visible = rows.filter((row) =>
    [row[resource.titleField], ...fields.map((f) => row[f.name])].some((v) =>
      String(v ?? "")
        .toLowerCase()
        .includes(search.toLowerCase()),
    ),
  );
  return (
    <div className="customer-directory">
      <div className="directory-tools">
        <label>
          Find someone on this page
          <input
            aria-label="Search directory page"
            placeholder="Name, email, or customer code"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </label>
        <button type="button" onClick={() => openForms(resource.route)}>
          Manage {resource.plural.toLowerCase()} in forms
        </button>
      </div>
      {error && (
        <div role="alert">
          <p>{error}</p>
          <button type="button" disabled={loading} onClick={() => void load()}>
            Try again
          </button>
        </div>
      )}
      <div aria-busy={loading}>
        {loading ? (
          <p role="status">Loading the directory…</p>
        ) : error ? null : (
          <>
            <p className="directory-count">
              {visible.length} of {rows.length} records on this page
            </p>
            <div className="directory-grid">
              {visible.map((row) => (
                <article key={String(row.id)}>
                  <div className="directory-avatar" aria-hidden>
                    {String(row[resource.titleField] || "?")
                      .slice(0, 1)
                      .toUpperCase()}
                  </div>
                  <h4>
                    {String(row[resource.titleField] || "Unnamed record")}
                  </h4>
                  <dl>
                    {fields.map((f) => (
                      <React.Fragment key={f.name}>
                        <dt>{f.label}</dt>
                        <dd>{String(row[f.name] ?? "—")}</dd>
                      </React.Fragment>
                    ))}
                  </dl>
                </article>
              ))}
            </div>
            {!visible.length && (
              <p>
                {rows.length
                  ? "No matching people on this page. Try another search."
                  : "No people yet. Add the first record in Data & forms."}
              </p>
            )}
          </>
        )}
      </div>
      <footer>
        <button type="button" disabled={loading} onClick={() => void load()}>
          Refresh from start
        </button>
        {cursor && !error && (
          <button
            type="button"
            disabled={loading}
            onClick={() => void load(cursor)}
          >
            Next page
          </button>
        )}
      </footer>
    </div>
  );
}

export const customerDirectory: GizmoDefinition = {
  id: "customer-directory",
  title: "Customer directory",
  description: "Find people and customer details in a focused card view.",
  supports: (descriptor) => !!customerResource(descriptor),
  component: CustomerDirectory,
};
