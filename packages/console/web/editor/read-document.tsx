import React from "react";
import { Badge } from "@cloudflare/kumo/components/badge";
import type { SyntaxNode } from "./language.js";
import type { Declaration } from "./app-model.js";
import { children, nameOf, textOf } from "./model.js";
const label = (kind: string) =>
  kind
    .replace(/_(DECL|BLOCK|CLAUSE|EXPR)$/, "")
    .toLowerCase()
    .replaceAll("_", " ");
export function ReadDocument({ entry }: { entry: Declaration }) {
  const { source, node } = entry;
  const fields = children(node, "FIELD_DECL");
  const decorators = children(node, "DECORATOR");
  const skip = new Set(["FIELD_DECL", "DECORATOR"]);
  function block(n: SyntaxNode): React.ReactNode {
    if (
      n.kind.endsWith("_EXPR") ||
      [
        "TYPE_REF",
        "QUALIFIED_NAME",
        "NAME_SET",
        "FIELD_LIST",
        "STATE_SET",
      ].includes(n.kind)
    )
      return <code className="read-value">{textOf(source, n).trim()}</code>;
    if (
      [
        "RULE",
        "FIND_DECL",
        "LIST_DECL",
        "TRANSITION_DECL",
        "STEP_DECL",
        "SLO_ITEM",
        "CAPABILITY_ITEM",
      ].includes(n.kind)
    )
      return (
        <section className="read-block" key={n.start}>
          <h4>{label(n.kind)}</h4>
          <p className="read-value">{textOf(source, n).trim()}</p>
        </section>
      );
    const nested = children(n);
    const words = n.children
      .filter(
        (c) =>
          c.token &&
          ![
            "WHITESPACE",
            "NEWLINE",
            "L_BRACE",
            "R_BRACE",
            "DOC_COMMENT",
            "COMMENT",
          ].includes(c.kind),
      )
      .map((c) => textOf(source, c))
      .join(" ");
    if (!nested.length)
      return <span className="read-value">{textOf(source, n).trim()}</span>;
    return (
      <section
        className={`read-block read-${n.kind.toLowerCase()}`}
        key={n.start}
      >
        <h4>{label(n.kind)}</h4>
        {words && <p className="read-words">{words}</p>}
        <div className="read-block-content">
          {nested.map((c) => (
            <React.Fragment key={c.start}>{block(c)}</React.Fragment>
          ))}
        </div>
      </section>
    );
  }
  return (
    <article className={`read-document kind-${node.kind.toLowerCase()}`}>
      {!!decorators.length && (
        <div className="read-traits">
          {decorators.map((d) => (
            <Badge key={d.start} variant="outline">
              {textOf(source, d).replace(/^@/, "")}
            </Badge>
          ))}
        </div>
      )}
      {!!fields.length && (
        <div className="table-scroll">
          <table className="read-fields">
            <thead>
              <tr>
                <th>Field</th>
                <th>Type</th>
                <th>Data class</th>
                <th>Value</th>
              </tr>
            </thead>
            <tbody>
              {fields.map((f) => {
                const type = children(f, "TYPE_EXPR")[0];
                const value = children(f).find((n) =>
                  ["DEFAULT_VALUE", "DERIVED_VALUE"].includes(n.kind),
                );
                const classification = children(f, "DECORATOR").find((d) =>
                  textOf(source, d).startsWith("@data("),
                );
                return (
                  <tr key={f.start}>
                    <th>{nameOf(source, f)}</th>
                    <td>
                      {type ? textOf(source, type) : "Calculated"}
                      {children(f, "DECORATOR")
                        .filter((d) => d !== classification)
                        .map((d) => (
                          <small key={d.start}>
                            {textOf(source, d).replace(/^@/, "")}
                          </small>
                        ))}
                    </td>
                    <td>
                      {classification
                        ? textOf(source, classification).slice(6, -1)
                        : "Inferred"}
                    </td>
                    <td>
                      {value ? (
                        <>
                          <small>
                            {value.kind === "DEFAULT_VALUE"
                              ? "Default"
                              : "Calculation"}
                          </small>
                          <code>{textOf(source, value)}</code>
                        </>
                      ) : (
                        "—"
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      <div className="read-sections">
        {children(node)
          .filter((n) => !skip.has(n.kind))
          .map((n) => (
            <React.Fragment key={n.start}>{block(n)}</React.Fragment>
          ))}
      </div>
    </article>
  );
}
