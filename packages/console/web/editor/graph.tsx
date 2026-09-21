import React from "react";
import type { Analysis, SyntaxNode } from "./language.js";
import { children, nameOf, textOf } from "./model.js";
export function Relationships({
  analysis,
  source,
  onSelect,
}: {
  analysis: Analysis;
  source: string;
  onSelect: (n: SyntaxNode) => void;
}) {
  const nodes = children(analysis.tree).filter((n) =>
    ["RESOURCE_DECL", "SHAPE_DECL", "PURPOSE_DECL", "DATA_CLASS_DECL"].includes(
      n.kind,
    ),
  );
  const edges: { from: number; to: number; label: string }[] = [];
  nodes.forEach((n, i) => {
    const inspect = (node: SyntaxNode) => {
      if (
        node.kind === "TYPE_REF" ||
        node.kind === "EXTENDS_CLAUSE" ||
        node.kind === "PURPOSE_BINDING"
      ) {
        const q =
          node.kind === "TYPE_REF"
            ? textOf(source, node)
            : textOf(source, children(node, "QUALIFIED_NAME")[0] ?? node);
        const j = nodes.findIndex((other) => nameOf(source, other) === q);
        if (j >= 0 && j !== i)
          edges.push({
            from: i,
            to: j,
            label:
              node.kind === "TYPE_REF"
                ? "references"
                : node.kind === "EXTENDS_CLAUSE"
                  ? "extends"
                  : "for purpose",
          });
      } else node.children.filter((c) => !c.token).forEach(inspect);
    };
    inspect(n);
  });
  const pos = (i: number) => ({
    x: 40 + (i % 2) * 360,
    y: 35 + Math.floor(i / 2) * 125,
  });
  return (
    <section className="relationship-panel">
      <h3>Relationships in this file</h3>
      <p className="muted small">
        Select a declaration to return to its visual controls. Connections
        reflect source references, not inferred access.
      </p>
      <div className="relationship-scroll">
        <svg
          role="img"
          aria-label="Forge declaration relationships"
          viewBox={`0 0 730 ${Math.max(180, Math.ceil(nodes.length / 2) * 125 + 35)}`}
        >
          <defs>
            <marker
              id="editor-arrow"
              markerWidth="7"
              markerHeight="7"
              refX="6"
              refY="3"
              orient="auto"
            >
              <path d="M0,0 L6,3 L0,6" fill="#8791a6" />
            </marker>
          </defs>
          {edges.map((e, i) => {
            const a = pos(e.from),
              b = pos(e.to);
            return (
              <g key={i}>
                <path
                  d={`M${a.x + 135} ${a.y + 64} C${a.x + 135} ${a.y + 100},${b.x + 135} ${b.y - 30},${b.x + 135} ${b.y}`}
                  fill="none"
                  stroke="#8791a6"
                  markerEnd="url(#editor-arrow)"
                />
                <text
                  x={(a.x + b.x) / 2 + 140}
                  y={(a.y + b.y) / 2 + 48}
                  className="edge-label"
                >
                  {e.label}
                </text>
              </g>
            );
          })}
          {nodes.map((n, i) => {
            const p = pos(i);
            return (
              <g
                key={n.start}
                role="button"
                tabIndex={0}
                aria-label={`Edit ${nameOf(source, n)}`}
                onClick={() => onSelect(n)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") onSelect(n);
                }}
                className={`graph-node kind-${n.kind.toLowerCase()}`}
              >
                <rect x={p.x} y={p.y} width="270" height="64" rx="10" />
                <text x={p.x + 16} y={p.y + 23} className="graph-kind">
                  {n.kind.replace("_DECL", "").toLowerCase().replace("_", " ")}
                </text>
                <text x={p.x + 16} y={p.y + 46}>
                  {nameOf(source, n)}
                </text>
              </g>
            );
          })}
        </svg>
      </div>
      {!nodes.length && <p>No declarations to connect yet.</p>}
    </section>
  );
}
