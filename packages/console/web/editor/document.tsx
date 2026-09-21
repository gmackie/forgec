import React, { useEffect, useState, useRef } from "react";
import { Button } from "@cloudflare/kumo/components/button";
import { Input, Textarea } from "@cloudflare/kumo/components/input";
import { Select } from "@cloudflare/kumo/components/select";
import { Badge } from "@cloudflare/kumo/components/badge";
import type { Analysis, SyntaxNode } from "./language.js";
import {
  children,
  tokens,
  named,
  nameOf,
  textOf,
  patch,
  insertMember,
  setClassification,
  setDecorator,
  toggleName,
  setFieldFlag,
} from "./model.js";
export function Edit({
  value,
  label,
  onCommit,
  multiline = false,
}: {
  value: string;
  label: string;
  onCommit: (v: string) => void;
  multiline?: boolean;
}) {
  const [draft, setDraft] = useState(value);
  const canceled = useRef(false);
  useEffect(() => setDraft(value), [value]);
  const props = {
    "aria-label": label,
    value: draft,
    onChange: (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
      setDraft(e.target.value),
    onBlur: () => {
      if (!canceled.current && draft !== value) onCommit(draft);
      canceled.current = false;
    },
    onKeyDown: (e: React.KeyboardEvent) => {
      if (e.key === "Escape") {
        canceled.current = true;
        setDraft(value);
        e.currentTarget instanceof HTMLElement && e.currentTarget.blur();
      }
      if (!multiline && e.key === "Enter") {
        e.preventDefault();
        (e.target as HTMLElement).blur();
      }
    },
  };
  return multiline ? <Textarea {...props} /> : <Input {...props} />;
}
const options = (values: string[]) =>
  Object.fromEntries([...new Set(values)].filter(Boolean).map((v) => [v, v]));
interface Props {
  source: string;
  analysis: Analysis;
  onChange: (value: string) => void;
  onError: (error: string) => void;
  selection?: { node: SyntaxNode; owner: SyntaxNode };
}
export function VisualDocument({
  source,
  analysis,
  onChange,
  onError,
  selection,
}: Props) {
  const declarations = selection ? [selection.node] : children(analysis.tree);
  const purposes = analysis.symbols
    .filter((n) => n.kind === "PURPOSE_DECL")
    .map((n) => n.name);
  const types = [
    ...analysis.scalars,
    ...analysis.symbols
      .filter((n) =>
        ["RESOURCE_DECL", "SHAPE_DECL", "TYPE_DECL", "ENUM_DECL"].includes(
          n.kind,
        ),
      )
      .map((n) => n.name),
  ];
  const classes = [
    ...analysis.taxonomy.nodes.map((n) => n.id),
    ...analysis.symbols
      .filter((n) => n.kind === "DATA_CLASS_DECL")
      .map((n) => n.name),
  ];
  const change = (fn: () => string) => {
    try {
      onChange(fn());
    } catch (e) {
      onError((e as Error).message);
    }
  };
  const replace = (node: SyntaxNode, v: string) =>
    change(() => patch(source, node, v));
  const rename = (node: SyntaxNode, v: string) => {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(v)) {
      onError(
        "Use a Forge identifier: letters, digits and underscores, starting with a letter or underscore.",
      );
      return;
    }
    const name = named(source, node);
    if (name) replace(name, v);
  };
  const sourceBlock = (node: SyntaxNode) => (
    <details className="editor-source-block">
      <summary>
        Edit {node.kind.toLowerCase().replaceAll("_", " ")} source
      </summary>
      <Edit
        multiline
        label={`${nameOf(source, node)} source`}
        value={textOf(source, node)}
        onCommit={(v) => replace(node, v)}
      />
    </details>
  );
  const refinement = (node: SyntaxNode, fieldName: string) => {
    const range = children(node, "RANGE")[0];
    const bounds =
      range?.children.filter((n) =>
        ["INT", "DECIMAL", "DURATION", "PERCENT"].includes(n.kind),
      ) ?? [];
    if (bounds.length === 2)
      return (
        <span className="range-control" key={node.start}>
          <span className="editor-label">
            {textOf(source, node).split(/\s/)[0]}
          </span>
          <Edit
            label={`Minimum ${textOf(source, node).split(/\s/)[0]} for ${fieldName}`}
            value={textOf(source, bounds[0]!)}
            onCommit={(v) => replace(bounds[0]!, v)}
          />
          <span>to</span>
          <Edit
            label={`Maximum ${textOf(source, node).split(/\s/)[0]} for ${fieldName}`}
            value={textOf(source, bounds[1]!)}
            onCommit={(v) => replace(bounds[1]!, v)}
          />
          <Button
            variant="ghost"
            size="sm"
            aria-label={`Remove constraint from ${fieldName}`}
            onClick={() => replace(node, "")}
          >
            ×
          </Button>
        </span>
      );
    return (
      <span className="constraint" key={node.start}>
        <Edit
          label={`Constraint for ${fieldName}`}
          value={textOf(source, node)}
          onCommit={(v) => replace(node, v)}
        />
      </span>
    );
  };
  const field = (node: SyntaxNode, resource: boolean) => {
    const type = children(node, "TYPE_EXPR")[0],
      ref = type && children(type, "TYPE_REF")[0];
    const classNode = children(node, "DECORATOR").find((n) =>
      textOf(source, n).startsWith("@data("),
    );
    const cls = classNode ? textOf(source, classNode).slice(6, -1) : "";
    const expression = children(node).find(
      (n) => n.kind === "DEFAULT_VALUE" || n.kind === "DERIVED_VALUE",
    );
    const optional = type?.children.find((n) => n.kind === "QUESTION");
    return (
      <div className="forge-field" key={node.start}>
        <span className="field-mark" aria-hidden>
          ƒ
        </span>
        <div>
          <span className="editor-label">Field</span>
          <Edit
            label={`Field ${nameOf(source, node)} name`}
            value={nameOf(source, node)}
            onCommit={(v) => rename(node, v)}
          />
        </div>
        {ref && (
          <div>
            <span className="editor-label">Type</span>
            <Select
              aria-label={`Type of ${nameOf(source, node)}`}
              value={textOf(source, ref)}
              items={options([...types, textOf(source, ref)])}
              onValueChange={(v) => replace(ref, String(v))}
            />
          </div>
        )}
        {!ref && expression?.kind === "DERIVED_VALUE" && (
          <Badge variant="outline">Calculated</Badge>
        )}
        <div className="classification-control">
          <span className="editor-label">Data class</span>
          <Select
            aria-label={`Data class of ${nameOf(source, node)}`}
            value={cls || "__inferred"}
            items={{
              __inferred: "Inferred by Forge",
              ...options([...classes, cls]),
            }}
            onValueChange={(v) =>
              change(() =>
                setClassification(
                  source,
                  node,
                  v === "__inferred" ? "" : String(v),
                ),
              )
            }
          />
        </div>
        {type && (
          <label className="editor-check">
            <input
              type="checkbox"
              defaultChecked={!!optional}
              onChange={(e) =>
                change(() =>
                  optional
                    ? patch(source, optional, "")
                    : patch(
                        source,
                        {
                          start: ref?.end ?? type.end,
                          end: ref?.end ?? type.end,
                        },
                        "?",
                      ),
                )
              }
            />
            Optional
          </label>
        )}
        <Button
          variant="ghost"
          size="sm"
          aria-label={`Remove field ${nameOf(source, node)}`}
          onClick={() => replace(node, "")}
        >
          ×
        </Button>
        {expression && (
          <div className="field-expression">
            <span className="editor-label">
              {expression.kind === "DERIVED_VALUE"
                ? "Calculated from"
                : "Default value"}
            </span>
            <Edit
              label={`${expression.kind === "DERIVED_VALUE" ? "Calculation" : "Default value"} for ${nameOf(source, node)}`}
              value={textOf(source, expression)}
              onCommit={(v) => replace(expression, v)}
            />
          </div>
        )}
        <div className="field-details">
          {type &&
            children(type, "REFINEMENT").map((r) =>
              refinement(r, nameOf(source, node)),
            )}
          {type &&
            ref &&
            ["text", "email"].includes(textOf(source, ref)) &&
            !children(type, "REFINEMENT").some((r) =>
              textOf(source, r).startsWith("length "),
            ) && (
              <Button
                variant="ghost"
                size="sm"
                onClick={() =>
                  change(() =>
                    patch(
                      source,
                      { start: type.end, end: type.end },
                      " length 0..200",
                    ),
                  )
                }
              >
                Add length bounds
              </Button>
            )}
          {resource &&
            ["unique", "immutable"].map((d) => (
              <label className="editor-check" key={d}>
                <input
                  type="checkbox"
                  defaultChecked={children(node, "DECORATOR").some(
                    (n) => textOf(source, n) === `@${d}`,
                  )}
                  onChange={(e) => {
                    change(() =>
                      setFieldFlag(source, node, d, e.target.checked),
                    );
                  }}
                />
                {d}
              </label>
            ))}
          {sourceBlock(node)}
        </div>
      </div>
    );
  };
  function block(node: SyntaxNode, depth = 0): React.ReactNode {
    const labels: Record<string, string> = {
      FUNCTION_DECL: "Function",
      FUNCTION_INPUT: "Input",
      FUNCTION_OUTPUT: "Output",
      USES_BLOCK: "Dependencies",
      SENDS_BLOCK: "Sends messages",
      RULES_BLOCK: "Rules",
      RULE: "Rule",
      LIFECYCLE_BLOCK: "Lifecycle",
      TRANSITION_DECL: "Transition",
      WORKFLOW_DECL: "Workflow",
      STEP_DECL: "Step",
      CHOICE_DECL: "Choice",
      THEN_BLOCK: "Then",
      ELSE_BLOCK: "Otherwise",
      PARALLEL_DECL: "Parallel",
      RETURN_DECL: "Return",
      FAIL_DECL: "Fail",
      BINARY_EXPR: "Expression",
      CALL_EXPR: "Call",
      DECORATOR: "Annotation",
    };
    const label =
      labels[node.kind] ??
      node.kind
        .toLowerCase()
        .replaceAll("_", " ")
        .replace(/ decl$/, "");
    const hidden = new Set([
      "WHITESPACE",
      "NEWLINE",
      "L_BRACE",
      "R_BRACE",
      "L_PAREN",
      "R_PAREN",
      "COLON",
      "COMMA",
    ]);
    const literals = new Set([
      "STRING",
      "INT",
      "DECIMAL",
      "DURATION",
      "PERCENT",
    ]);
    return (
      <div
        className={`syntax-block syntax-${node.kind.toLowerCase()}`}
        key={node.start}
      >
        <span className="syntax-label">{label}</span>
        <div className="syntax-content">
          {node.children
            .filter((c) => !hidden.has(c.kind))
            .map((child, i) =>
              child.token ? (
                child.kind === "COMMENT" || child.kind === "DOC_COMMENT" ? (
                  <span className="syntax-comment" key={child.start}>
                    {textOf(source, child).replace(/^\/\/\/?\s*/, "")}
                  </span>
                ) : child.kind === "IDENT" || literals.has(child.kind) ? (
                  <Edit
                    key={child.start}
                    label={`${label} ${i + 1}`}
                    value={textOf(source, child)}
                    onCommit={(v) => replace(child, v)}
                  />
                ) : (
                  <span className="syntax-operator" key={child.start}>
                    {textOf(source, child)}
                  </span>
                )
              ) : (
                block(child, depth + 1)
              ),
            )}
        </div>
      </div>
    );
  }
  function capability(node: SyntaxNode, resource: SyntaxNode) {
    const fields = children(resource, "FIELD_DECL").map((n) =>
      nameOf(source, n),
    );
    const items = children(node, "CAPABILITY_ITEM");
    const caps = children(resource, "CAPABILITY_DECL")
      .filter((n) => n !== node)
      .map((n) => nameOf(source, n));
    return (
      <section className="forge-capability" key={node.start}>
        <div className="editor-row">
          <Badge variant="secondary">Capability</Badge>
          <Edit
            label={`Capability ${nameOf(source, node)} name`}
            value={nameOf(source, node)}
            onCommit={(v) => rename(node, v)}
          />
          <Button variant="ghost" size="sm" onClick={() => replace(node, "")}>
            Remove
          </Button>
        </div>
        {!!caps.length && (
          <div className="cap-includes">
            <span className="editor-label">Includes</span>
            {caps.map((c) => {
              const existing = items.find(
                (i) => textOf(source, i).trim() === `includes ${c}`,
              );
              return (
                <label className="editor-check" key={c}>
                  <input
                    type="checkbox"
                    defaultChecked={!!existing}
                    onChange={() =>
                      change(() =>
                        existing
                          ? patch(source, existing, "")
                          : insertMember(source, node, `includes ${c}`),
                      )
                    }
                  />
                  {c}
                </label>
              );
            })}
          </div>
        )}
        {[false, true].map((deny) => (
          <details key={String(deny)} open={!deny}>
            <summary>{deny ? "Explicit denials" : "Allowed fields"}</summary>
            <div className="table-scroll">
              <table className="capability-matrix">
                <thead>
                  <tr>
                    <th>Field</th>
                    {["read", "create", "update", "filter", "order"].map(
                      (v) => (
                        <th key={v}>{v}</th>
                      ),
                    )}
                  </tr>
                </thead>
                <tbody>
                  {fields.map((f) => (
                    <tr key={f}>
                      <th>{f}</th>
                      {["read", "create", "update", "filter", "order"].map(
                        (verb) => {
                          const clause = items.find((i) =>
                            textOf(source, i)
                              .trim()
                              .startsWith(`${deny ? "deny " : ""}${verb} `),
                          );
                          const set = clause && children(clause, "NAME_SET")[0];
                          const checked =
                            !!set &&
                            tokens(set).some(
                              (t) =>
                                t.kind === "IDENT" && textOf(source, t) === f,
                            );
                          return (
                            <td key={verb}>
                              <input
                                aria-label={`${deny ? "Deny" : "Allow"} ${verb} ${f} in ${nameOf(source, node)}`}
                                type="checkbox"
                                defaultChecked={checked}
                                onChange={(e) =>
                                  change(() =>
                                    set
                                      ? toggleName(
                                          source,
                                          set,
                                          f,
                                          e.target.checked,
                                        )
                                      : insertMember(
                                          source,
                                          node,
                                          `${deny ? "deny " : ""}${verb} { ${f} }`,
                                        ),
                                  )
                                }
                              />
                            </td>
                          );
                        },
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </details>
        ))}
        {sourceBlock(node)}
      </section>
    );
  }
  if (selection?.node.kind === "CAPABILITY_DECL")
    return (
      <div className="visual-document">
        {capability(selection.node, selection.owner)}
      </div>
    );
  return (
    <div className="visual-document">
      {declarations.map((node) => {
        const name = nameOf(source, node),
          kind = node.kind
            .replace("_DECL", "")
            .toLowerCase()
            .replaceAll("_", " ");
        const structured = [
          "RESOURCE_DECL",
          "SHAPE_DECL",
          "ENUM_DECL",
          "PURPOSE_DECL",
          "DATA_CLASS_DECL",
          "TYPE_DECL",
        ].includes(node.kind);
        const fields = children(node, "FIELD_DECL");
        const parents = children(node, "EXTENDS_CLAUSE");
        return (
          <section
            className={`forge-declaration kind-${node.kind.toLowerCase()}`}
            id={`declaration-${node.start}`}
            key={`${node.kind}:${node.start}`}
          >
            <header className="declaration-heading">
              <Badge variant="secondary">{kind}</Badge>
              {named(source, node) ? (
                <Edit
                  label={`${kind} name`}
                  value={name}
                  onCommit={(v) => rename(node, v)}
                />
              ) : (
                <h3>{name}</h3>
              )}
              <span className="declaration-spacer" />
              <Button
                variant="ghost"
                size="sm"
                aria-label={`Remove ${kind} ${name}`}
                onClick={() => replace(node, "")}
              >
                Remove
              </Button>
            </header>
            {["PURPOSE_DECL", "DATA_CLASS_DECL"].includes(node.kind) && (
              <div className="declaration-body">
                <span className="editor-label">Extends</span>
                <Select
                  aria-label={`Parent of ${name}`}
                  value={
                    parents[0]
                      ? textOf(
                          source,
                          children(parents[0], "QUALIFIED_NAME")[0]!,
                        )
                      : "__none"
                  }
                  items={{
                    __none:
                      node.kind === "PURPOSE_DECL"
                        ? "No parent"
                        : "Choose a Forge data class",
                    ...options([
                      ...(node.kind === "PURPOSE_DECL"
                        ? purposes.filter((p) => p !== name)
                        : classes.filter((c) => c !== name)),
                      ...(parents[0]
                        ? [
                            textOf(
                              source,
                              children(parents[0], "QUALIFIED_NAME")[0]!,
                            ),
                          ]
                        : []),
                    ]),
                  }}
                  onValueChange={(v) =>
                    change(() =>
                      parents[0]
                        ? patch(
                            source,
                            parents[0],
                            v === "__none" ? "" : `extends ${v}`,
                          )
                        : patch(
                            source,
                            { start: node.end, end: node.end },
                            v === "__none" ? "" : ` extends ${v}`,
                          ),
                    )
                  }
                />
                <p className="muted small">
                  {node.kind === "PURPOSE_DECL"
                    ? "Purpose inheritance describes meaning; access requires an explicit capability binding."
                    : `Vocabulary: ${analysis.taxonomy.version}. Custom classes retain their parent’s handling requirements.`}
                </p>
              </div>
            )}
            {["RESOURCE_DECL", "SHAPE_DECL"].includes(node.kind) && (
              <>
                {node.kind === "RESOURCE_DECL" && (
                  <div className="resource-traits">
                    {[
                      "tenant",
                      "timestamps",
                      "versioned",
                      "audited",
                      "softDelete",
                      "purposeScoped",
                    ].map((d) => (
                      <label className="editor-check" key={d}>
                        <input
                          type="checkbox"
                          defaultChecked={children(node, "DECORATOR").some(
                            (n) => textOf(source, n) === `@${d}`,
                          )}
                          onChange={(e) =>
                            change(() =>
                              setDecorator(source, node, d, e.target.checked),
                            )
                          }
                        />
                        {d}
                      </label>
                    ))}
                  </div>
                )}
                <div className="forge-fields">
                  {fields.map((f) => field(f, node.kind === "RESOURCE_DECL"))}
                </div>
                <div className="declaration-body">
                  <AddMember
                    label="Add field"
                    placeholder="Field name"
                    onAdd={(v) =>
                      change(() => insertMember(source, node, `${v} : text`))
                    }
                  />
                </div>
                {children(node, "CAPABILITY_DECL").map((c) =>
                  capability(c, node),
                )}
                {node.kind === "RESOURCE_DECL" && (
                  <div className="declaration-body">
                    <AddMember
                      label="Add capability"
                      placeholder="Capability name"
                      onAdd={(v) =>
                        change(() =>
                          insertMember(
                            source,
                            node,
                            `capability ${v} {\n  read { }\n}`,
                          ),
                        )
                      }
                    />
                  </div>
                )}
                {children(node, "PURPOSE_BINDING").map((binding) => {
                  const purpose = children(binding, "QUALIFIED_NAME")[0]!;
                  return (
                    <div className="purpose-binding" key={binding.start}>
                      <Badge variant="secondary">For purpose</Badge>
                      <Select
                        aria-label={`Purpose binding for ${name}`}
                        value={textOf(source, purpose)}
                        items={options([...purposes, textOf(source, purpose)])}
                        onValueChange={(v) => replace(purpose, String(v))}
                      />
                      <span>use</span>
                      {children(node, "CAPABILITY_DECL").map((c) => {
                        const existing = children(binding, "USE_PURPOSE").find(
                          (u) =>
                            tokens(u).some(
                              (t) => textOf(source, t) === nameOf(source, c),
                            ),
                        );
                        return (
                          <label className="editor-check" key={c.start}>
                            <input
                              type="checkbox"
                              defaultChecked={!!existing}
                              onChange={() =>
                                change(() =>
                                  existing
                                    ? patch(source, existing, "")
                                    : insertMember(
                                        source,
                                        binding,
                                        `use ${nameOf(source, c)}`,
                                      ),
                                )
                              }
                            />
                            {nameOf(source, c)}
                          </label>
                        );
                      })}
                      <Button
                        size="sm"
                        variant="ghost"
                        aria-label={`Remove purpose binding for ${name}`}
                        onClick={() => replace(binding, "")}
                      >
                        ×
                      </Button>
                    </div>
                  );
                })}
                {node.kind === "RESOURCE_DECL" && (
                  <div className="declaration-body">
                    <AddBinding
                      purposes={purposes}
                      capabilities={children(node, "CAPABILITY_DECL").map((c) =>
                        nameOf(source, c),
                      )}
                      onAdd={(p, c) =>
                        change(() =>
                          insertMember(source, node, `for ${p} { use ${c} }`),
                        )
                      }
                    />
                  </div>
                )}
                {children(node)
                  .filter(
                    (n) =>
                      ![
                        "FIELD_DECL",
                        "DECORATOR",
                        "CAPABILITY_DECL",
                        "PURPOSE_BINDING",
                      ].includes(n.kind),
                  )
                  .map((n) => (
                    <div className="declaration-body" key={n.start}>
                      {block(n)}
                      {sourceBlock(n)}
                    </div>
                  ))}
              </>
            )}
            {node.kind === "ENUM_DECL" && (
              <div className="declaration-body enum-members">
                {children(node, "ENUM_MEMBER").map((m) => (
                  <div key={m.start}>
                    <Badge variant="outline">Option</Badge>
                    <Edit
                      label="Enum option"
                      value={textOf(source, m)}
                      onCommit={(v) => replace(m, v)}
                    />
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => replace(m, "")}
                    >
                      ×
                    </Button>
                  </div>
                ))}
                <AddMember
                  label="Add option"
                  placeholder="Option name"
                  onAdd={(v) =>
                    change(() =>
                      insertMember(source, node, `${v} = "${v.toLowerCase()}"`),
                    )
                  }
                />
              </div>
            )}
            {(!structured || node.kind === "TYPE_DECL") && (
              <div className="declaration-body">
                {block(node)}
                {sourceBlock(node)}
              </div>
            )}
            {structured && (
              <div className="declaration-source">{sourceBlock(node)}</div>
            )}
          </section>
        );
      })}
      {!declarations.length && (
        <div className="editor-empty">
          <h3>A document ready for your model</h3>
          <p>Add a resource, purpose, data class or enum using the toolbar.</p>
        </div>
      )}
    </div>
  );
}
function AddMember({
  label,
  placeholder,
  onAdd,
}: {
  label: string;
  placeholder: string;
  onAdd: (v: string) => void;
}) {
  const [value, setValue] = useState("");
  return (
    <form
      className="add-member"
      onSubmit={(e) => {
        e.preventDefault();
        if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) {
          onAdd(value);
          setValue("");
        }
      }}
    >
      <Input
        aria-label={placeholder}
        placeholder={placeholder}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        pattern="[A-Za-z_][A-Za-z0-9_]*"
        required
      />
      <Button type="submit" size="sm">
        {label}
      </Button>
    </form>
  );
}
function AddBinding({
  purposes,
  capabilities,
  onAdd,
}: {
  purposes: string[];
  capabilities: string[];
  onAdd: (p: string, c: string) => void;
}) {
  const [purpose, setPurpose] = useState(""),
    [cap, setCap] = useState("");
  if (!purposes.length || !capabilities.length)
    return (
      <p className="muted small">
        Declare a purpose and a capability to add a purpose binding.
      </p>
    );
  return (
    <div className="add-member">
      <Select
        aria-label="New binding purpose"
        value={purposes.includes(purpose) ? purpose : purposes[0]}
        items={options(purposes)}
        onValueChange={(v) => setPurpose(String(v))}
      />
      <Select
        aria-label="New binding capability"
        value={capabilities.includes(cap) ? cap : capabilities[0]}
        items={options(capabilities)}
        onValueChange={(v) => setCap(String(v))}
      />
      <Button
        size="sm"
        onClick={() =>
          onAdd(
            purposes.includes(purpose) ? purpose : purposes[0]!,
            capabilities.includes(cap) ? cap : capabilities[0]!,
          )
        }
      >
        Bind purpose
      </Button>
    </div>
  );
}
