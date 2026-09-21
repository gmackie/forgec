import type { Analysis, FieldSemantics, SyntaxNode } from "./language.js";
import type { Declaration } from "./app-model.js";
import {
  children,
  named,
  nameOf,
  textOf,
  tokens,
  patch,
  insertMember,
} from "./model.js";
export interface FieldDraft {
  name: string;
  type: string;
  value: string;
  classification: string;
  unique: boolean;
  immutable: boolean;
}
export function fieldDraft(source: string, node: SyntaxNode): FieldDraft {
  const type = children(node, "TYPE_EXPR")[0];
  const value = children(node).find((n) =>
    ["DEFAULT_VALUE", "DERIVED_VALUE"].includes(n.kind),
  );
  const decorators = children(node, "DECORATOR").map((n) => textOf(source, n));
  return {
    name: nameOf(source, node),
    type: type ? textOf(source, type).trim() : "",
    value: value ? textOf(source, value).trim() : "",
    classification:
      decorators.find((d) => d.startsWith("@data("))?.slice(6, -1) || "",
    unique: decorators.includes("@unique"),
    immutable: decorators.includes("@immutable"),
  };
}
export function saveField(
  source: string,
  node: SyntaxNode,
  draft: FieldDraft,
): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(draft.name))
    throw Error("Enter a valid field name.");
  const edits: { start: number; end: number; text: string }[] = [];
  const add = (n: Pick<SyntaxNode, "start" | "end">, text: string) => {
    const insertion =
      n.start === n.end &&
      edits.find((e) => e.start === n.start && e.end === n.end);
    if (insertion) insertion.text += text;
    else edits.push({ ...n, text });
  };
  const name = named(source, node)!;
  add(name, draft.name);
  const type = children(node, "TYPE_EXPR")[0];
  const value = children(node).find((n) =>
    ["DEFAULT_VALUE", "DERIVED_VALUE"].includes(n.kind),
  );
  if (type) {
    if (!draft.type.trim()) throw Error("Choose a field type.");
    add(type, draft.type.trim());
  }
  if (value) {
    if (value.kind === "DERIVED_VALUE" && !draft.value.trim())
      throw Error("A calculated field needs an expression.");
    if (draft.value.trim()) add(value, draft.value.trim());
    else {
      const equal = node.children.find(
        (n) => n.kind === "EQ" && n.start < value.start,
      );
      add({ start: equal?.start ?? value.start, end: value.end }, "");
    }
  } else if (type && draft.value.trim())
    add({ start: type.end, end: type.end }, ` = ${draft.value.trim()}`);
  const additions: string[] = [];
  for (const [key, text] of [
    ["data", draft.classification ? `@data(${draft.classification})` : ""],
    ["unique", draft.unique ? "@unique" : ""],
    ["immutable", draft.immutable ? "@immutable" : ""],
  ] as const) {
    const existing = children(node, "DECORATOR").find(
      (d) =>
        textOf(source, d) === `@${key}` ||
        textOf(source, d).startsWith(`@${key}(`),
    );
    if (existing) add(existing, text);
    else if (text) additions.push(text);
  }
  if (additions.length) {
    const end = tokens(node)
      .filter(
        (t) =>
          !["WHITESPACE", "NEWLINE", "COMMENT", "DOC_COMMENT"].includes(t.kind),
      )
      .at(-1)!.end;
    add({ start: end, end }, " " + additions.join(" "));
  }
  return edits
    .sort((a, b) => b.start - a.start || b.end - a.end)
    .reduce((s, e) => patch(s, e, e.text), source);
}
export function semanticsFor(
  analysis: Analysis,
  entry: Declaration,
  field: string,
): FieldSemantics | undefined {
  return analysis.dataSemantics?.fields.find(
    (f) =>
      f.resource.endsWith(`/${entry.module}/${entry.name}`) &&
      f.field === field,
  );
}
export function setClause(
  source: string,
  owner: SyntaxNode,
  kind: string,
  keyword: string,
  value: string,
): string {
  const existing = children(owner, kind)[0];
  if (existing) {
    const child = children(existing)[0];
    if (child && value) return patch(source, child, value);
    return patch(source, existing, value ? `${keyword} ${value}` : "");
  }
  return value ? insertMember(source, owner, `${keyword} ${value}`) : source;
}
export const shortClass = (value: string) =>
  value.includes("/") ? value.split("/").at(-1)! : value.replace(/^data\./, "");

export function dependencyDraft(value: string) {
  const match = value
    .trim()
    .match(/^(\S+)(?:\s+(read|write|create|delete))?(?:\s+for\s+(\S+))?$/);
  return {
    target: match?.[1] || value.trim(),
    operation: match?.[2] || "",
    purpose: match?.[3] || "",
  };
}
export function dependencyText(draft: {
  target: string;
  operation: string;
  purpose: string;
}) {
  return `${draft.target}${draft.operation ? " " + draft.operation : ""}${draft.purpose ? " for " + draft.purpose : ""}`;
}

export function classificationOptions(analysis: Analysis, module: string) {
  return [
    ...(analysis.dataClasses || [])
      .filter((c) => c.id.endsWith(`/${module}/${c.name}`))
      .map((c) => ({ ...c, value: c.name })),
    ...analysis.taxonomy.nodes.map((c) => ({ ...c, value: c.id })),
  ];
}

export function fieldNameTaken(
  source: string,
  owner: SyntaxNode,
  field: SyntaxNode | null,
  name: string,
) {
  return children(owner, "FIELD_DECL").some(
    (f) =>
      (f.start !== field?.start || f.end !== field?.end) &&
      nameOf(source, f) === name,
  );
}
