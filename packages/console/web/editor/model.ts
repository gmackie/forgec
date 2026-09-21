import type { SyntaxNode } from "./language.js";
export const textOf = (text: string, node: Pick<SyntaxNode, "start" | "end">) =>
  text.slice(node.start, node.end);
export const children = (node: SyntaxNode, kind?: string) =>
  node.children.filter((n) => !n.token && (!kind || n.kind === kind));
export const tokens = (node: SyntaxNode): SyntaxNode[] =>
  node.token ? [node] : node.children.flatMap(tokens);
export const named = (text: string, node: SyntaxNode) => {
  const identifiers = node.children.filter((n) => n.kind === "IDENT");
  if (["FIELD_DECL", "ENUM_MEMBER"].includes(node.kind)) return identifiers[0];
  return identifiers[
    textOf(text, identifiers[0] ?? { start: 0, end: 0 }) === "export" ? 2 : 1
  ];
};
export const nameOf = (text: string, node: SyntaxNode) => {
  const n = named(text, node);
  return n ? textOf(text, n) : node.kind.toLowerCase().replaceAll("_", " ");
};
export function patch(
  text: string,
  range: { start: number; end: number },
  replacement: string,
) {
  if (range.start < 0 || range.end < range.start || range.end > text.length)
    throw Error("The edit no longer matches this source.");
  return text.slice(0, range.start) + replacement + text.slice(range.end);
}
export function setClassification(
  text: string,
  field: SyntaxNode,
  value: string,
) {
  const existing = children(field, "DECORATOR").find((n) =>
    textOf(text, n).startsWith("@data("),
  );
  if (existing) return patch(text, existing, value ? `@data(${value})` : "");
  if (!value) return text;
  const last = tokens(field)
    .filter(
      (n) =>
        !["WHITESPACE", "NEWLINE", "COMMENT", "DOC_COMMENT"].includes(n.kind),
    )
    .at(-1)!;
  return patch(text, { start: last.end, end: last.end }, ` @data(${value})`);
}
export function toggleName(
  text: string,
  set: SyntaxNode,
  value: string,
  on: boolean,
) {
  const existing = tokens(set).find(
    (n) => n.kind === "IDENT" && textOf(text, n) === value,
  );
  if (existing) return on ? text : patch(text, existing, "");
  if (!on) return text;
  const close = set.children.find((n) => n.kind === "R_BRACE");
  if (!close) throw Error("Finish this block in the source view first.");
  return patch(text, { start: close.start, end: close.start }, `${value} `);
}
export function insertMember(text: string, parent: SyntaxNode, member: string) {
  const close = parent.children.findLast((n) => n.kind === "R_BRACE");
  if (!close) throw Error("Finish this block in the source view first.");
  const lineStart = text.lastIndexOf("\n", parent.start - 1) + 1;
  const indent = text.slice(lineStart, parent.start).match(/^\s*/)?.[0] ?? "";
  const closeLine = text.lastIndexOf("\n", close.start - 1) + 1;
  const ownLine = /^\s*$/.test(text.slice(closeLine, close.start));
  const position = ownLine ? closeLine : close.start;
  return patch(
    text,
    { start: position, end: position },
    `${ownLine ? "" : "\n"}${member
      .split("\n")
      .map((line) => indent + "  " + line)
      .join("\n")}\n${ownLine ? "" : indent}`,
  );
}
export function setDecorator(
  text: string,
  node: SyntaxNode,
  name: string,
  on: boolean,
) {
  const existing = children(node, "DECORATOR").find(
    (n) => textOf(text, n) === `@${name}`,
  );
  if (existing) return on ? text : patch(text, existing, "");
  if (!on) return text;
  const open = node.children.find((n) => n.kind === "L_BRACE");
  if (!open) throw Error("This declaration needs a body.");
  return patch(text, { start: open.start, end: open.start }, `@${name} `);
}

export function setFieldFlag(
  text: string,
  field: SyntaxNode,
  name: string,
  on: boolean,
) {
  const existing = children(field, "DECORATOR").find(
    (n) => textOf(text, n) === `@${name}`,
  );
  if (existing) return on ? text : patch(text, existing, "");
  if (!on) return text;
  const last = tokens(field)
    .filter(
      (n) =>
        !["WHITESPACE", "NEWLINE", "COMMENT", "DOC_COMMENT"].includes(n.kind),
    )
    .at(-1)!;
  return patch(text, { start: last.end, end: last.end }, ` @${name}`);
}
