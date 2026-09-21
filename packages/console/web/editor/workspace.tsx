import React, { useState, useEffect } from "react";
import { Button } from "@cloudflare/kumo/components/button";
import { Input, Textarea } from "@cloudflare/kumo/components/input";
import { Select } from "@cloudflare/kumo/components/select";
import { Dialog } from "@cloudflare/kumo/components/dialog";
import { Badge } from "@cloudflare/kumo/components/badge";
import {
  DatabaseIcon,
  ShieldCheckIcon,
  ArrowsLeftRightIcon,
  LightningIcon,
  ClockIcon,
  PlusIcon,
  ArrowRightIcon,
  MagnifyingGlassIcon,
} from "@phosphor-icons/react";
import type { Analysis, SyntaxNode } from "./language.js";
import type { Declaration } from "./app-model.js";
import {
  children,
  nameOf,
  textOf,
  named,
  patch,
  insertMember,
  setDecorator,
} from "./model.js";
import {
  classificationOptions,
  dependencyDraft,
  dependencyText,
  fieldNameTaken,
  fieldDraft,
  saveField,
  semanticsFor,
  shortClass,
  setClause,
  type FieldDraft,
} from "./composer-model.js";
import { Edit, VisualDocument } from "./document.js";
interface Props {
  entry: Declaration;
  analysis: Analysis;
  entries: Declaration[];
  editing: boolean;
  onChange: (source: string) => void;
  onError: (message: string) => void;
  onSelect: (id: string) => void;
}
const options = (values: string[]) =>
  Object.fromEntries([...new Set(values)].map((v) => [v, v]));
function Classification({
  value,
  handling,
  muted = false,
}: {
  value: string;
  handling?: string | undefined;
  muted?: boolean;
}) {
  return (
    <span
      className={`classification-chip handling-${handling || "unknown"} ${muted ? "classification-inferred" : ""}`}
    >
      <span aria-hidden>●</span>
      {shortClass(value)}
      {handling && <small>{handling}</small>}
    </span>
  );
}
function SectionHeading({
  icon,
  title,
  description,
  action,
}: {
  icon?: React.ReactNode;
  title: string;
  description?: string;
  action?: React.ReactNode;
}) {
  return (
    <header className="composer-section-heading">
      <div className="section-title">
        {icon}
        <div>
          <h3>{title}</h3>
          {description && <p>{description}</p>}
        </div>
      </div>
      {action}
    </header>
  );
}
function FieldForm({
  entry,
  field,
  analysis,
  onSave,
  onClose,
  onError,
}: {
  entry: Declaration;
  field: SyntaxNode | null;
  analysis: Analysis;
  onSave: (source: string) => void;
  onClose: () => void;
  onError: (error: string) => void;
}) {
  const [draft, setDraft] = useState<FieldDraft>(() =>
    field
      ? fieldDraft(entry.source, field)
      : {
          name: "",
          type: "text",
          value: "",
          classification: "",
          unique: false,
          immutable: false,
        },
  );
  const [query, setQuery] = useState("");
  const [error, setError] = useState("");
  const classes = classificationOptions(analysis, entry.module);
  const selected = classes.find((c) => c.value === draft.classification);
  const change = (key: keyof FieldDraft, value: string | boolean) =>
    setDraft((d) => ({ ...d, [key]: value }));
  return (
    <Dialog.Root
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <Dialog size="lg" className="field-dialog">
        <Dialog.Title className="dialog-title">
          {field ? `Edit ${draft.name || "field"}` : "Add a field"}
        </Dialog.Title>
        <Dialog.Description>
          Define its value and meaning. Changes stay in your draft until you
          commit.
        </Dialog.Description>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            try {
              if (fieldNameTaken(entry.source, entry.node, field, draft.name))
                throw Error("A field with this name already exists.");
              const next = field
                ? saveField(entry.source, field, draft)
                : insertMember(
                    entry.source,
                    entry.node,
                    `${draft.name} : ${draft.type}${draft.value ? ` = ${draft.value}` : ""}${draft.classification ? ` @data(${draft.classification})` : ""}${draft.unique ? " @unique" : ""}${draft.immutable ? " @immutable" : ""}`,
                  );
              if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(draft.name))
                throw Error("Enter a valid field name.");
              onSave(next);
              onClose();
            } catch (e) {
              setError(String(e));
              onError(String(e));
            }
          }}
        >
          <div className="field-form-grid">
            <Input
              label="Field name"
              value={draft.name}
              onChange={(e) => change("name", e.target.value)}
              required
              pattern="[A-Za-z_][A-Za-z0-9_]*"
            />
            {field && children(field, "DERIVED_VALUE").length ? (
              <div className="calculated-note">
                Calculated field<small>The type follows the expression.</small>
              </div>
            ) : (
              <Input
                label="Type and constraints"
                value={draft.type}
                list="forge-field-types"
                onChange={(e) => change("type", e.target.value)}
                required
              />
            )}
            <datalist id="forge-field-types">
              {[
                ...analysis.scalars,
                ...analysis.symbols
                  .filter((s) =>
                    ["TYPE_DECL", "ENUM_DECL", "RESOURCE_DECL"].includes(
                      s.kind,
                    ),
                  )
                  .map((s) => s.name),
              ].map((t) => (
                <option key={t} value={t} />
              ))}
            </datalist>
          </div>
          <Input
            label={
              field && children(field, "DERIVED_VALUE").length
                ? "Calculation"
                : "Default value"
            }
            placeholder="No default"
            value={draft.value}
            onChange={(e) => change("value", e.target.value)}
          />
          <div className="classification-picker">
            <SectionHeading
              icon={<ShieldCheckIcon />}
              title="Data classification"
              description="Describe what this field contains. Access is configured separately."
            />
            <div className="classification-current">
              {draft.classification ? (
                <Classification
                  value={draft.classification}
                  handling={selected?.handling}
                />
              ) : (
                <span>Use Forge’s type inference</span>
              )}
              <Button
                type="button"
                size="sm"
                variant="ghost"
                onClick={() => change("classification", "")}
              >
                Use inference
              </Button>
            </div>
            <Input
              aria-label="Find a data class"
              placeholder="Search identity, email, financial, health…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
            <div
              className="classification-options"
              role="group"
              aria-label="Data classifications"
            >
              {classes
                .filter((c) =>
                  c.value.toLowerCase().includes(query.toLowerCase()),
                )
                .map((c) => (
                  <button
                    key={c.id}
                    type="button"
                    aria-pressed={draft.classification === c.value}
                    onClick={() => change("classification", c.value)}
                  >
                    <span>{c.value}</span>
                    <small>
                      {c.handling}
                      {c.personal === "yes" ? " · Personal data" : ""}
                    </small>
                  </button>
                ))}
            </div>
          </div>
          {entry.node.kind === "RESOURCE_DECL" && (
            <div className="field-switches">
              {(["unique", "immutable"] as const).map((flag) => (
                <label key={flag}>
                  <input
                    type="checkbox"
                    checked={draft[flag]}
                    onChange={(e) => change(flag, e.target.checked)}
                  />
                  <span>
                    {flag === "unique"
                      ? "Unique value"
                      : "Cannot change after creation"}
                  </span>
                </label>
              ))}
            </div>
          )}
          {error && <p role="alert">{error}</p>}
          <footer className="dialog-footer">
            {field && (
              <Button
                type="button"
                variant="ghost"
                onClick={() => {
                  onSave(patch(entry.source, field, ""));
                  onClose();
                }}
              >
                Remove field
              </Button>
            )}
            <Button type="button" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" variant="primary">
              Save field
            </Button>
          </footer>
        </form>
      </Dialog>
    </Dialog.Root>
  );
}
export function ResourceWorkspace(props: Props) {
  const { entry, analysis, editing, onChange, onError } = props;
  const { source, node } = entry;
  const [section, setSection] = useState("Fields");
  const [selectedField, setSelectedField] = useState<
    SyntaxNode | null | undefined
  >();
  const [fieldQuery, setFieldQuery] = useState("");
  const [accessName, setAccessName] = useState("");
  const [purpose, setPurpose] = useState("");
  const [capability, setCapability] = useState("");
  const fields = children(node, "FIELD_DECL");
  const caps = children(node, "CAPABILITY_DECL");
  const bindings = children(node, "PURPOSE_BINDING");
  const classifications = fields.map((f) =>
    semanticsFor(analysis, entry, nameOf(source, f)),
  );
  const attention = classifications.filter(
    (s) => s?.completeness === "unclassified",
  ).length;
  const related = props.entries.filter(
    (e) =>
      e.node.kind === "FUNCTION_DECL" &&
      e.module === entry.module &&
      children(e.node, "USES_BLOCK").some((b) =>
        new RegExp(`\\b${entry.name}\\b`).test(textOf(e.source, b)),
      ),
  );
  const [activeCap, setActiveCap] = useState("");
  return (
    <div className="resource-composer">
      <div className="composer-stats">
        <div>
          <DatabaseIcon />
          <strong>{fields.length}</strong>
          <span>fields</span>
        </div>
        <div>
          <ShieldCheckIcon />
          <strong>
            {classifications.filter((s) => s?.evidence === "declared").length}
          </strong>
          <span>classified explicitly</span>
        </div>
        <div className={attention ? "needs-attention" : ""}>
          <strong>{attention}</strong>
          <span>need classification</span>
        </div>
        <div>
          <ArrowsLeftRightIcon />
          <strong>{bindings.length}</strong>
          <span>purposes bound</span>
        </div>
      </div>
      <nav className="composer-tabs" aria-label={`${entry.name} sections`}>
        {["Fields", "Access & purpose", "Behavior"].map((s) => (
          <Button
            key={s}
            size="sm"
            variant={section === s ? "secondary" : "ghost"}
            aria-pressed={section === s}
            onClick={() => setSection(s)}
          >
            {s}
          </Button>
        ))}
      </nav>
      {section === "Fields" && (
        <section className="composer-card">
          <SectionHeading
            title="Schema"
            description="The information this resource holds."
            action={
              editing ? (
                <Button
                  size="sm"
                  icon={<PlusIcon />}
                  onClick={() => setSelectedField(null)}
                >
                  Add field
                </Button>
              ) : undefined
            }
          />
          <Input
            aria-label="Find a field"
            placeholder="Find a field…"
            value={fieldQuery}
            onChange={(e) => setFieldQuery(e.target.value)}
          />
          <div className="table-scroll">
            <table className="schema-table">
              <thead>
                <tr>
                  <th>Field / type</th>
                  <th>Classification</th>
                  <th>Value / constraints</th>
                  {editing && <th aria-label="Edit" />}
                </tr>
              </thead>
              <tbody>
                {fields
                  .filter((f) =>
                    nameOf(source, f)
                      .toLowerCase()
                      .includes(fieldQuery.toLowerCase()),
                  )
                  .map((f) => {
                    const d = fieldDraft(source, f);
                    const semantic = semanticsFor(analysis, entry, d.name);
                    return (
                      <tr key={f.start}>
                        <th>
                          <strong>{d.name}</strong>
                          <span className="schema-type">
                            {d.type || "Calculated"}
                          </span>
                        </th>
                        <td>
                          {semantic ? (
                            <>
                              <Classification
                                value={semantic.class}
                                handling={semantic.handling}
                                muted={semantic.evidence !== "declared"}
                              />
                              <small className="field-evidence">
                                {semantic.completeness === "unclassified"
                                  ? "Needs classification"
                                  : semantic.evidence === "declared"
                                    ? "Explicit classification"
                                    : semantic.completeness === "structural"
                                      ? "Structural data"
                                      : "Inferred from type"}
                              </small>
                            </>
                          ) : (
                            <span className="muted">
                              {d.classification || "Classification unavailable"}
                            </span>
                          )}
                        </td>
                        <td>
                          {d.value && (
                            <code className="value-expression">{d.value}</code>
                          )}
                          <div className="field-flags">
                            {d.unique && <span>Unique</span>}
                            {d.immutable && <span>Immutable</span>}
                            {d.type.endsWith("?") && <span>Optional</span>}
                          </div>
                        </td>
                        {editing && (
                          <td>
                            <Button
                              size="sm"
                              variant="ghost"
                              aria-label={`Edit field ${d.name}`}
                              onClick={() => setSelectedField(f)}
                            >
                              Edit
                            </Button>
                          </td>
                        )}
                      </tr>
                    );
                  })}
              </tbody>
            </table>
          </div>
          {!fields.length && (
            <p className="composer-empty">
              Start with the information you need to store. Add a field to
              define its type and classification.
            </p>
          )}
          {related.length > 0 && (
            <div className="connected-strip">
              <span>Used by</span>
              {related.map((e) => (
                <Button
                  size="sm"
                  variant="ghost"
                  key={e.id}
                  onClick={() => props.onSelect(e.id)}
                >
                  {e.name}
                  <ArrowRightIcon />
                </Button>
              ))}
            </div>
          )}
        </section>
      )}
      {section === "Access & purpose" && (
        <div className="access-workspace">
          <section className="composer-card">
            <SectionHeading
              title="Purpose bindings"
              description="Classification describes data. A purpose binding explicitly grants a capability."
            />
            {bindings.map((b) => (
              <div className="purpose-access-row" key={b.start}>
                <ShieldCheckIcon />
                <strong>
                  {textOf(source, children(b, "QUALIFIED_NAME")[0]!)}
                </strong>
                <ArrowRightIcon />
                <div>
                  {children(b, "USE_PURPOSE").map((u) => (
                    <Badge key={u.start} variant="outline">
                      {textOf(source, u).replace(/^use\s+/, "")}
                    </Badge>
                  ))}
                </div>
                {editing && (
                  <Button
                    size="sm"
                    variant="ghost"
                    aria-label={`Remove purpose binding ${textOf(source, children(b, "QUALIFIED_NAME")[0]!)}`}
                    onClick={() => onChange(patch(source, b, ""))}
                  >
                    Remove
                  </Button>
                )}
              </div>
            ))}
            {!bindings.length && (
              <p className="composer-empty">
                No purposes are bound to this resource.
              </p>
            )}
            {editing && (
              <form
                className="inline-builder"
                onSubmit={(e) => {
                  e.preventDefault();
                  if (purpose && capability)
                    onChange(
                      insertMember(
                        source,
                        node,
                        `for ${purpose} { use ${capability} }`,
                      ),
                    );
                }}
              >
                <Select
                  aria-label="Purpose to bind"
                  value={purpose}
                  placeholder="Choose purpose"
                  items={options(
                    analysis.symbols
                      .filter((s) => s.kind === "PURPOSE_DECL")
                      .map((s) => s.name),
                  )}
                  onValueChange={(v) => setPurpose(String(v))}
                />
                <Select
                  aria-label="Capability to bind"
                  value={capability}
                  placeholder="Choose capability"
                  items={options(caps.map((c) => nameOf(source, c)))}
                  onValueChange={(v) => setCapability(String(v))}
                />
                <Button type="submit" disabled={!purpose || !capability}>
                  Bind purpose
                </Button>
              </form>
            )}
          </section>
          <section className="composer-card">
            <SectionHeading
              title="Capabilities"
              description="Reusable sets of allowed operations on this resource."
            />
            <div className="capability-cards">
              {caps.map((c) => (
                <div className="capability-card" key={c.start}>
                  <header>
                    <ShieldCheckIcon />
                    <h4>{nameOf(source, c)}</h4>
                    {editing && (
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() =>
                          setActiveCap(
                            activeCap === nameOf(source, c)
                              ? ""
                              : nameOf(source, c),
                          )
                        }
                      >
                        {activeCap === nameOf(source, c)
                          ? "Close controls"
                          : "Configure"}
                      </Button>
                    )}
                  </header>
                  {editing && activeCap === nameOf(source, c) ? (
                    <VisualDocument
                      key={source}
                      source={source}
                      analysis={analysis}
                      selection={{ node: c, owner: node }}
                      onChange={onChange}
                      onError={onError}
                    />
                  ) : (
                    <div className="permission-lines">
                      {children(c, "CAPABILITY_ITEM").map((i) => (
                        <p key={i.start}>
                          {textOf(source, i).replace(/[{}]/g, "").trim()}
                        </p>
                      ))}
                    </div>
                  )}
                </div>
              ))}
            </div>
            {editing && (
              <form
                className="inline-builder"
                onSubmit={(e) => {
                  e.preventDefault();
                  if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(accessName)) {
                    onChange(
                      insertMember(
                        source,
                        node,
                        `capability ${accessName} {\n read { }\n}`,
                      ),
                    );
                    setAccessName("");
                  }
                }}
              >
                <Input
                  aria-label="New capability name"
                  placeholder="Capability name"
                  value={accessName}
                  onChange={(e) => setAccessName(e.target.value)}
                  required
                />
                <Button type="submit">Add capability</Button>
              </form>
            )}
          </section>
        </div>
      )}
      {section === "Behavior" && (
        <div className="behavior-grid">
          <section className="composer-card">
            <SectionHeading
              title="Resource behavior"
              description="Storage and change tracking."
            />
            <div className="trait-grid">
              {[
                "tenant",
                "timestamps",
                "versioned",
                "audited",
                "softDelete",
                "purposeScoped",
              ].map((flag) => {
                const enabled = children(node, "DECORATOR").some(
                  (d) => textOf(source, d) === `@${flag}`,
                );
                return (
                  <label key={flag}>
                    <input
                      type="checkbox"
                      disabled={!editing}
                      checked={enabled}
                      onChange={() =>
                        onChange(setDecorator(source, node, flag, !enabled))
                      }
                    />
                    {
                      (
                        {
                          tenant: "Tenant isolation",
                          timestamps: "Created / updated timestamps",
                          versioned: "Optimistic versioning",
                          audited: "Audit trail",
                          softDelete: "Soft deletion",
                          purposeScoped: "Purpose-scoped access",
                        } as Record<string, string>
                      )[flag]
                    }
                  </label>
                );
              })}
            </div>
          </section>
          {children(node)
            .filter((n) =>
              [
                "LIFECYCLE_BLOCK",
                "RULES_BLOCK",
                "FIND_DECL",
                "LIST_DECL",
              ].includes(n.kind),
            )
            .map((n) => (
              <section className="composer-card" key={n.start}>
                <SectionHeading
                  title={
                    n.kind === "LIFECYCLE_BLOCK"
                      ? "Lifecycle"
                      : n.kind === "RULES_BLOCK"
                        ? "Validation rules"
                        : n.kind === "FIND_DECL"
                          ? "Lookup"
                          : "Collection query"
                  }
                />
                {n.kind === "LIFECYCLE_BLOCK" && !editing ? (
                  <div className="lifecycle-steps">
                    {children(n).map((t) => (
                      <div key={t.start}>{textOf(source, t)}</div>
                    ))}
                  </div>
                ) : editing ? (
                  <Edit
                    multiline
                    label={`${entry.name} ${n.kind.toLowerCase()}`}
                    value={textOf(source, n)}
                    onCommit={(v) => onChange(patch(source, n, v))}
                  />
                ) : (
                  <pre className="readable-rule">{textOf(source, n)}</pre>
                )}
              </section>
            ))}
        </div>
      )}
      {selectedField !== undefined && (
        <FieldForm
          key={selectedField?.start ?? "new"}
          entry={entry}
          field={selectedField}
          analysis={analysis}
          onSave={onChange}
          onClose={() => setSelectedField(undefined)}
          onError={onError}
        />
      )}
    </div>
  );
}
function RelationForm({
  kind,
  value = "",
  analysis,
  onSave,
  onCancel,
}: {
  kind: string;
  value?: string;
  analysis: Analysis;
  onSave: (v: string) => void;
  onCancel?: () => void;
}) {
  const dependency = kind === "USES_BLOCK";
  const parts = value.match(/^(.*?)\s+to\s+(.*)$/);
  const initial = dependencyDraft(value);
  const [target, setTarget] = useState(
    dependency ? initial.target : parts?.[1] || "",
  );
  const [operation, setOperation] = useState(
    dependency ? (value ? initial.operation : "read") : parts?.[2] || "",
  );
  const [purpose, setPurpose] = useState(initial.purpose);
  const symbols = analysis.symbols
    .filter((s) =>
      dependency
        ? ["RESOURCE_DECL", "FUNCTION_DECL"].includes(s.kind)
        : s.kind === "CHANNEL_DECL",
    )
    .map((s) => s.name);
  return (
    <form
      className="relation-form"
      onSubmit={(e) => {
        e.preventDefault();
        if (!target.trim() || (!dependency && !operation.trim())) return;
        onSave(
          dependency
            ? dependencyText({ target, operation, purpose })
            : `${target} to ${operation}`,
        );
        setTarget("");
        if (!dependency) setOperation("");
      }}
    >
      {dependency ? (
        <>
          <Input
            label="Dependency target"
            placeholder="Resource, function, or transition"
            value={target}
            list="forge-dependency-targets"
            onChange={(e) => setTarget(e.target.value)}
            required
          />
          <datalist id="forge-dependency-targets">
            {symbols.map((s) => (
              <option key={s} value={s} />
            ))}
          </datalist>
        </>
      ) : (
        <Input
          label="Message"
          value={target}
          placeholder="TicketEscalated"
          onChange={(e) => setTarget(e.target.value)}
          required
        />
      )}
      {dependency ? (
        <>
          <Select
            aria-label="Operation"
            value={operation || "__call"}
            items={{
              __call: "Call function / transition",
              read: "Read records",
              write: "Write records",
              create: "Create records",
              delete: "Delete records",
            }}
            onValueChange={(v) => setOperation(v === "__call" ? "" : String(v))}
          />
          <Select
            aria-label="Dependency purpose"
            value={purpose || "__none"}
            items={{
              __none: "Use function purpose",
              ...options([
                ...analysis.symbols
                  .filter((s) => s.kind === "PURPOSE_DECL")
                  .map((s) => s.name),
                ...(purpose ? [purpose] : []),
              ]),
            }}
            onValueChange={(v) => setPurpose(v === "__none" ? "" : String(v))}
          />
        </>
      ) : (
        <Select
          aria-label="Event channel"
          placeholder="Choose channel"
          value={operation}
          items={options([...symbols, ...(operation ? [operation] : [])])}
          onValueChange={(v) => setOperation(String(v))}
        />
      )}
      <div className="relation-actions">
        {onCancel && (
          <Button type="button" size="sm" onClick={onCancel}>
            Cancel
          </Button>
        )}
        <Button
          type="submit"
          size="sm"
          disabled={!target || (!dependency && !operation)}
        >
          {value ? "Save" : "Add"}
        </Button>
      </div>
    </form>
  );
}
export function FunctionWorkspace(props: Props) {
  const { entry, analysis, entries, editing, onChange, onSelect } = props;
  const { source, node } = entry;
  const [activeRelation, setActiveRelation] = useState<number | null>(null);
  const [newDependency, setNewDependency] = useState("");
  const [newEvent, setNewEvent] = useState("");
  const [newError, setNewError] = useState("");
  const linked = (name: string) =>
    entries.find(
      (e) => e.module === entry.module && e.name === name.split(/[.<]/)[0],
    );
  const contract = (
    kind: string,
    keyword: string,
    label: string,
    hint: string,
  ) => {
    const n = children(node, kind)[0];
    const value = n
      ? textOf(source, n)
          .replace(new RegExp(`^${keyword}\\s+`), "")
          .trim()
      : "";
    const target = linked(value);
    return (
      <section className="contract-card">
        <span className="editor-label">{label}</span>
        {editing ? (
          <Select
            aria-label={label}
            value={value || "__none"}
            items={{
              __none: hint,
              ...options([
                value,
                ...analysis.scalars,
                ...analysis.symbols
                  .filter((s) =>
                    ["SHAPE_DECL", "TYPE_DECL", "ENUM_DECL"].includes(s.kind),
                  )
                  .map((s) => s.name),
                ...entries
                  .filter((e) => e.category === "Resources")
                  .map((e) => `${e.name}.Record`),
              ]),
            }}
            onValueChange={(v) =>
              onChange(
                setClause(
                  source,
                  node,
                  kind,
                  keyword,
                  v === "__none" ? "" : String(v),
                ),
              )
            }
          />
        ) : (
          <strong>{value || hint}</strong>
        )}
        {target && (
          <Button size="sm" variant="ghost" onClick={() => onSelect(target.id)}>
            Explore {target.name}
            <ArrowRightIcon />
          </Button>
        )}
        {target?.node.kind === "SHAPE_DECL" && (
          <div className="contract-fields">
            {children(target.node, "FIELD_DECL").map((f) => (
              <div key={f.start}>
                <span>{nameOf(target.source, f)}</span>
                <code>
                  {textOf(target.source, children(f, "TYPE_EXPR")[0]!)}
                </code>
              </div>
            ))}
          </div>
        )}
      </section>
    );
  };
  const http = children(node, "DECORATOR").find((d) =>
    textOf(source, d).startsWith("@http("),
  );
  const endpoint = http
    ? textOf(source, http).match(/^@http\(\s*(\w+)\s*,\s*"([^"]*)"\s*\)$/)
    : null;
  const [method, setMethod] = useState(endpoint?.[1] || "POST");
  const [path, setPath] = useState(endpoint?.[2] || "");
  useEffect(() => {
    setMethod(endpoint?.[1] || "POST");
    setPath(endpoint?.[2] || "");
  }, [http ? textOf(source, http) : ""]);
  const saveHttp = (e: React.FormEvent) => {
    e.preventDefault();
    const value = path ? `@http(${method}, ${JSON.stringify(path)})` : "";
    const open = node.children.find((n) => n.kind === "L_BRACE")!;
    onChange(
      http
        ? patch(source, http, value)
        : patch(source, { start: open.start, end: open.start }, value + "\n"),
    );
  };
  const sources = entries.filter(
    (e) =>
      e.module === entry.module &&
      ["SOURCE_DECL", "SUBSCRIPTION_DECL"].includes(e.node.kind) &&
      new RegExp(`\\b${entry.name}\\b`).test(
        e.source.slice(e.node.start, e.node.end),
      ),
  );
  const add = (kind: string, keyword: string, value: string) => {
    const block = children(node, kind)[0];
    onChange(
      block
        ? insertMember(source, block, value)
        : insertMember(source, node, `${keyword} {\n ${value}\n}`),
    );
  };
  return (
    <div className="function-composer">
      <div className="function-route">
        <span className="function-icon">
          <LightningIcon size={25} />
        </span>
        <div>
          <span className="eyebrow">ENTRY POINT</span>
          {http ? (
            <p>
              <b>{endpoint?.[1] || "HTTP"}</b>
              <code>{endpoint?.[2] || textOf(source, http)}</code>
            </p>
          ) : (
            <p>Internal function</p>
          )}
        </div>
        <div className="route-purpose">
          <ShieldCheckIcon />
          {children(node, "FUNCTION_PURPOSE")[0]
            ? textOf(source, children(node, "FUNCTION_PURPOSE")[0]!).replace(
                /^purpose\s+/,
                "",
              )
            : "No purpose specified"}
        </div>
      </div>
      {editing && (
        <form className="inline-builder route-editor" onSubmit={saveHttp}>
          <Select
            aria-label="HTTP method"
            value={method}
            items={options(["GET", "POST", "PUT", "PATCH", "DELETE"])}
            onValueChange={(v) => setMethod(String(v))}
          />
          <Input
            aria-label="HTTP path"
            placeholder="/v1/operation (empty for internal)"
            value={path}
            onChange={(e) => setPath(e.target.value)}
          />
          <Button type="submit">Save endpoint</Button>
        </form>
      )}
      <div className="contract-flow">
        {contract("FUNCTION_INPUT", "input", "Input", "No input")}
        <ArrowRightIcon className="contract-arrow" />
        {contract("FUNCTION_OUTPUT", "output", "Output", "No output")}
      </div>
      <div className="function-grid">
        <section className="composer-card">
          <SectionHeading
            icon={<ShieldCheckIcon />}
            title="Purpose"
            description="The reason this function uses data."
          />
          {editing ? (
            <Select
              aria-label="Function purpose"
              value={
                children(node, "FUNCTION_PURPOSE")[0]
                  ? textOf(source, children(node, "FUNCTION_PURPOSE")[0]!)
                      .replace(/^purpose\s+/, "")
                      .trim()
                  : "__none"
              }
              items={{
                __none: "No purpose",
                ...options(
                  analysis.symbols
                    .filter((s) => s.kind === "PURPOSE_DECL")
                    .map((s) => s.name),
                ),
              }}
              onValueChange={(v) =>
                onChange(
                  setClause(
                    source,
                    node,
                    "FUNCTION_PURPOSE",
                    "purpose",
                    v === "__none" ? "" : String(v),
                  ),
                )
              }
            />
          ) : (
            <p className="purpose-callout">
              {children(node, "FUNCTION_PURPOSE")[0]
                ? textOf(
                    source,
                    children(node, "FUNCTION_PURPOSE")[0]!,
                  ).replace(/^purpose\s+/, "")
                : "No purpose declared"}
            </p>
          )}
        </section>
        <section className="composer-card">
          <SectionHeading
            icon={<ClockIcon />}
            title="Triggered by"
            description="Connected schedules and event subscriptions."
          />
          {sources.length ? (
            sources.map((s) => (
              <Button key={s.id} variant="ghost" onClick={() => onSelect(s.id)}>
                {s.name}
                <ArrowRightIcon />
              </Button>
            ))
          ) : (
            <p className="muted">
              {http
                ? "HTTP requests"
                : "Called by other application operations"}
            </p>
          )}
        </section>
      </div>
      <div className="function-grid">
        {[
          {
            kind: "USES_BLOCK",
            item: "USE_DECL",
            title: "Dependencies",
            description: "Resources and operations this function can use.",
            keyword: "uses",
            value: newDependency,
            set: setNewDependency,
            placeholder: "Ticket read",
            label: "New dependency",
          },
          {
            kind: "SENDS_BLOCK",
            item: "SEND_DECL",
            title: "Emitted events",
            description: "Messages this operation may publish.",
            keyword: "sends",
            value: newEvent,
            set: setNewEvent,
            placeholder: "TicketEscalated to SupportEvents",
            label: "New emitted event",
          },
          {
            kind: "ERRORS_BLOCK",
            item: "ERROR_DECL",
            title: "Expected errors",
            description: "Named outcomes a caller should handle.",
            keyword: "errors",
            value: newError,
            set: setNewError,
            placeholder: "NotFound",
            label: "New error",
          },
        ].map((group) => {
          const block = children(node, group.kind)[0];
          const items = block ? children(block, group.item) : [];
          return (
            <section className="composer-card" key={group.kind}>
              <SectionHeading
                title={group.title}
                description={group.description}
              />
              <div className="operation-list">
                {items.map((item, i) => {
                  const value = textOf(source, item).trim();
                  const target = linked(value.split(/\s/)[0]!);
                  return (
                    <div key={item.start}>
                      {editing ? (
                        <>
                          {group.kind === "ERRORS_BLOCK" ? (
                            <Edit
                              label={`${group.title} ${i + 1}`}
                              value={value}
                              onCommit={(v) => onChange(patch(source, item, v))}
                            />
                          ) : activeRelation === item.start ? (
                            <RelationForm
                              key={source + item.start}
                              kind={group.kind}
                              value={value}
                              analysis={analysis}
                              onSave={(v) => {
                                onChange(patch(source, item, v));
                                setActiveRelation(null);
                              }}
                              onCancel={() => setActiveRelation(null)}
                            />
                          ) : (
                            <Button
                              variant="ghost"
                              size="sm"
                              aria-label={`Edit ${value}`}
                              onClick={() => setActiveRelation(item.start)}
                            >
                              {value}
                              <span className="muted">Edit</span>
                            </Button>
                          )}
                          <Button
                            size="sm"
                            variant="ghost"
                            aria-label={`Remove ${value}`}
                            onClick={() => onChange(patch(source, item, ""))}
                          >
                            ×
                          </Button>
                        </>
                      ) : (
                        <>
                          <span className="operation-dot" />
                          <code>{value}</code>
                          {target && (
                            <Button
                              size="sm"
                              variant="ghost"
                              aria-label={`Explore ${value}`}
                              onClick={() => onSelect(target.id)}
                            >
                              <ArrowRightIcon />
                            </Button>
                          )}
                        </>
                      )}
                    </div>
                  );
                })}
              </div>
              {!items.length && (
                <p className="composer-empty">None declared.</p>
              )}
              {editing &&
                (group.kind !== "ERRORS_BLOCK" ? (
                  <RelationForm
                    kind={group.kind}
                    analysis={analysis}
                    onSave={(v) => add(group.kind, group.keyword, v)}
                  />
                ) : (
                  <form
                    className="inline-builder"
                    onSubmit={(e) => {
                      e.preventDefault();
                      if (group.value.trim()) {
                        add(group.kind, group.keyword, group.value.trim());
                        group.set("");
                      }
                    }}
                  >
                    <Input
                      aria-label={group.label}
                      placeholder={group.placeholder}
                      value={group.value}
                      onChange={(e) => group.set(e.target.value)}
                      required
                    />
                    <Button type="submit" size="sm">
                      Add
                    </Button>
                  </form>
                ))}
            </section>
          );
        })}
        <section className="composer-card">
          <SectionHeading
            title="Service objectives"
            description="Reliability and latency expectations."
          />
          {children(node, "SLO_BLOCK")
            .flatMap((b) => children(b, "SLO_ITEM"))
            .map((n, i) => (
              <div className="slo-row" key={n.start}>
                {editing ? (
                  <Edit
                    label={`Service objective ${i + 1}`}
                    value={textOf(source, n)}
                    onCommit={(v) => onChange(patch(source, n, v))}
                  />
                ) : (
                  <code>{textOf(source, n)}</code>
                )}
              </div>
            ))}
          {!children(node, "SLO_BLOCK").length && (
            <p className="composer-empty">No service objectives declared.</p>
          )}
        </section>
      </div>
    </div>
  );
}
export function SourceWorkspace({
  entry,
  analysis,
  entries,
  editing,
  onChange,
  onSelect,
}: Props) {
  const { source, node } = entry;
  const clause = (
    kind: string,
    keyword: string,
    label: string,
    quoted = false,
  ) => {
    const n = children(node, kind)[0];
    const raw = n
      ? textOf(source, n)
          .replace(new RegExp(`^${keyword === "->" ? "->" : keyword}\\s+`), "")
          .trim()
      : "";
    let value = raw;
    if (quoted) {
      try {
        value = JSON.parse(raw);
      } catch {}
    }
    return (
      <div className="source-setting">
        <span className="editor-label">{label}</span>
        {editing ? (
          <Edit
            label={label}
            value={value}
            onCommit={(v) =>
              onChange(
                setClause(
                  source,
                  node,
                  kind,
                  keyword,
                  quoted ? JSON.stringify(v) : v,
                ),
              )
            }
          />
        ) : (
          <strong>{value || "Not set"}</strong>
        )}
      </div>
    );
  };
  const targetNode = children(node, "TARGET_DECL")[0];
  const targetName = targetNode
    ? textOf(source, targetNode)
        .replace(/^->\s*/, "")
        .trim()
    : "";
  const target = entries.find(
    (e) =>
      e.module === entry.module &&
      e.name === targetName &&
      e.category === "Functions",
  );
  return (
    <div className="source-composer">
      <div className="source-hero">
        <ClockIcon size={40} />
        <div>
          <p className="eyebrow">SCHEDULED SOURCE</p>
          <h3>A recurring entry point</h3>
          <p>Runs a function on a schedule, in an explicit time zone.</p>
        </div>
      </div>
      <section className="composer-card">
        <div className="source-settings">
          {clause("CRON_DECL", "cron", "Cron schedule", true)}
          {clause("TIMEZONE_DECL", "timezone", "Time zone", true)}
        </div>
        <p className="muted small">
          Cron uses minute, hour, day of month, month, and day of week. Forge
          validates the schedule.
        </p>
      </section>
      <div className="source-connection">
        <span>Schedule</span>
        <ArrowRightIcon />
        <section className="composer-card">
          <SectionHeading title="Target function" />
          {editing ? (
            <Select
              aria-label="Target function"
              value={targetName}
              items={options(
                analysis.symbols
                  .filter((s) => s.kind === "FUNCTION_DECL")
                  .map((s) => s.name),
              )}
              onValueChange={(v) =>
                onChange(
                  setClause(source, node, "TARGET_DECL", "->", String(v)),
                )
              }
            />
          ) : (
            <strong>{targetName || "Choose a function"}</strong>
          )}
          {target && (
            <Button variant="ghost" onClick={() => onSelect(target.id)}>
              Explore {target.name}
              <ArrowRightIcon />
            </Button>
          )}
        </section>
      </div>
    </div>
  );
}
export function DataCatalog({
  analysis,
  entries,
  onSelect,
}: {
  analysis: Analysis;
  entries: Declaration[];
  onSelect: (id: string) => void;
}) {
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState("all");
  const fields = analysis.dataSemantics?.fields || [];
  const unresolved = fields.filter((f) => f.completeness === "unclassified");
  const filtered = fields.filter(
    (f) =>
      (filter === "all" ||
        (filter === "attention" && f.completeness === "unclassified") ||
        (filter === "personal" && f.personal === "yes")) &&
      `${f.resource} ${f.field} ${f.class} ${f.handling}`
        .toLowerCase()
        .includes(query.toLowerCase()),
  );
  return (
    <div className="data-catalog">
      <header className="catalog-hero">
        <div>
          <span className="catalog-icon">
            <ShieldCheckIcon size={28} />
          </span>
          <p className="eyebrow">DATA CATALOG</p>
          <h2>Know what your application holds.</h2>
          <p>
            Classifications, handling requirements, and personal data—from
            Forge’s native taxonomy.
          </p>
        </div>
        <div className="catalog-totals">
          <strong>{fields.length}</strong>
          <span>resource fields</span>
        </div>
      </header>
      <div className="catalog-toolbar">
        <Input
          aria-label="Search data catalog"
          placeholder="Find a resource, field, or classification…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <div role="group" aria-label="Catalog filter">
          {[
            ["all", "All fields"],
            ["attention", `Needs classification (${unresolved.length})`],
            ["personal", "Personal data"],
          ].map(([value, label]) => (
            <Button
              key={value}
              size="sm"
              aria-pressed={filter === value}
              variant={filter === value ? "secondary" : "ghost"}
              onClick={() => setFilter(value!)}
            >
              {label}
            </Button>
          ))}
        </div>
      </div>
      {!analysis.dataSemantics && (
        <p role="status" className="composer-empty">
          Resolve compiler errors to view authoritative classifications. No
          classifications are guessed.
        </p>
      )}
      <div className="table-scroll">
        <table className="catalog-table">
          <thead>
            <tr>
              <th>Resource / field</th>
              <th>Classification</th>
              <th>Evidence</th>
              <th>Personal data</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {filtered.map((f) => {
              const resource = entries.find(
                (e) =>
                  e.category === "Resources" &&
                  f.resource.endsWith(`/${e.module}/${e.name}`),
              );
              return (
                <tr key={f.resource + f.field}>
                  <td>
                    <small>
                      {resource?.name || f.resource.split("/").at(-1)}
                    </small>
                    <strong>{f.field}</strong>
                  </td>
                  <td>
                    <Classification value={f.class} handling={f.handling} />
                  </td>
                  <td>
                    {f.completeness === "unclassified" ? (
                      <span className="attention-label">
                        Needs classification
                      </span>
                    ) : f.evidence === "declared" ? (
                      "Explicit"
                    ) : f.evidence === "structural" ? (
                      "Structural"
                    ) : (
                      "Inferred from type"
                    )}
                  </td>
                  <td>
                    {f.personal === "yes"
                      ? "Personal"
                      : f.personal === "no"
                        ? "Non-personal"
                        : "Unknown"}
                  </td>
                  <td>
                    {resource && (
                      <Button
                        variant="ghost"
                        size="sm"
                        aria-label={`Open ${resource.name}.${f.field}`}
                        onClick={() => onSelect(resource.id)}
                      >
                        Open
                        <ArrowRightIcon />
                      </Button>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {analysis.dataSemantics && !filtered.length && (
        <p className="composer-empty">No fields match this filter.</p>
      )}
      <details className="taxonomy-reference">
        <summary>
          Explore the Forge taxonomy · {analysis.taxonomy.version}
        </summary>
        <div className="taxonomy-grid">
          {analysis.taxonomy.nodes.map((n) => (
            <div key={n.id}>
              <Classification value={n.id} handling={n.handling} />
              <p>{n.id}</p>
              <small>
                Personal data: {n.personal}
                {n.parent ? ` · Extends ${n.parent}` : ""}
              </small>
            </div>
          ))}
        </div>
      </details>
    </div>
  );
}
