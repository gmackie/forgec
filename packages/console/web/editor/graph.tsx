import React from "react";
import type { Analysis, SyntaxNode } from "./language.js";
import { children, nameOf, textOf } from "./model.js";
export function Relationships({
  analysis,
  source,
  onSelect,
  onOpenFile,
  currentFile,
}: {
  analysis: Analysis;
  source: string;
  onSelect: (n: SyntaxNode) => void;
  onOpenFile: (file: string) => void;
  currentFile: string;
}) {
  const nodes = children(analysis.tree).filter((n) =>
    ["RESOURCE_DECL", "SHAPE_DECL", "PURPOSE_DECL", "DATA_CLASS_DECL"].includes(
      n.kind,
    ),
  );
  const external: { name: string; kind: string; file: string }[] = [];
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
        let j = nodes.findIndex((other) => nameOf(source, other) === q);
        if (j < 0) {
          const symbol = analysis.symbols.find(s => s.name === q && s.file !== currentFile);
          if (symbol) {
            let index = external.findIndex(s => s.name === symbol.name && s.file === symbol.file);
            if (index < 0) { index = external.length; external.push(symbol); }
            j = nodes.length + index;
          }
        }
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
  const cards = [
    ...nodes.map(n => ({ name: nameOf(source, n), kind: n.kind, file: currentFile, node: n })),
    ...external.map(s => ({ ...s, node: null })),
  ];
  const pos = (i: number) => ({
    x: 40 + (i % 2) * 360,
    y: 35 + Math.floor(i / 2) * 125,
  });
  return (
    <section className="relationship-panel">
      <h3>Relationships from this file</h3>
      <p className="muted small">
        Select a declaration to return to its visual controls. Connections
        reflect source references. Dashed cards open a referenced file.
      </p>
      <div className="relationship-scroll">
        <svg
          role="img"
          aria-label="Forge declaration relationships"
          viewBox={`0 0 730 ${Math.max(180, Math.ceil(cards.length / 2) * 125 + 35)}`}
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
          {cards.map((n, i) => {
            const p = pos(i);
            return (
              <g
                key={`${n.file}:${n.name}`}
                role="button"
                tabIndex={0}
                aria-label={n.node ? `Edit ${n.name}` : `Open ${n.name} in ${n.file}`}
                onClick={() => n.node ? onSelect(n.node) : onOpenFile(n.file)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    if (n.node) onSelect(n.node); else onOpenFile(n.file);
                  }
                }}
                className={`graph-node kind-${n.kind.toLowerCase()}`}
              >
                <rect x={p.x} y={p.y} width="270" height="64" rx="10" strokeDasharray={n.node ? undefined : "5 3"} />
                <text x={p.x + 16} y={p.y + 23} className="graph-kind">
                  {n.node ? n.kind.replace("_DECL", "").toLowerCase().replace("_", " ") : n.file}
                </text>
                <text x={p.x + 16} y={p.y + 46}>
                  {n.name}
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
