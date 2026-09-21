import type { Analysis, Project, SyntaxNode } from "./language.js";
import { children, nameOf, textOf } from "./model.js";
export const categories = [
  "Resources",
  "Functions",
  "Sources",
  "Shapes",
  "Purposes",
  "Capabilities",
  "Types",
  "Data classes",
  "Events",
  "Workflows",
  "Other",
] as const;
export type Category = (typeof categories)[number];
const kinds: Record<string, Category> = {
  RESOURCE_DECL: "Resources",
  FUNCTION_DECL: "Functions",
  SOURCE_DECL: "Sources",
  SHAPE_DECL: "Shapes",
  PURPOSE_DECL: "Purposes",
  CAPABILITY_DECL: "Capabilities",
  TYPE_DECL: "Types",
  ENUM_DECL: "Types",
  DATA_CLASS_DECL: "Data classes",
  CHANNEL_DECL: "Events",
  SUBSCRIPTION_DECL: "Events",
  WORKFLOW_DECL: "Workflows",
};
export interface Declaration {
  id: string;
  name: string;
  category: Category;
  path: string;
  module: string;
  node: SyntaxNode;
  owner: SyntaxNode;
  source: string;
}
export function appDeclarations(
  project: Project,
  analysis: Analysis,
): Declaration[] {
  return analysis.documents.flatMap((doc) => {
    const source = project.files.find((f) => f.path === doc.path)?.text;
    if (source === undefined) return [];
    return children(doc.tree).flatMap((node, index) => {
      if (["MODULE_DECL", "IMPORT_DECL"].includes(node.kind)) return [];
      const entry: Declaration = {
        id: `${doc.path}:${index}`,
        name: nameOf(source, node),
        category: kinds[node.kind] || "Other",
        path: doc.path,
        module: doc.module,
        node,
        owner: node,
        source,
      };
      return [
        entry,
        ...children(node, "CAPABILITY_DECL").map((cap, i) => ({
          ...entry,
          id: `${entry.id}:cap:${i}`,
          name: `${entry.name}.${nameOf(source, cap)}`,
          node: cap,
          category: "Capabilities" as const,
        })),
      ];
    });
  });
}
export function declarationSummary(entry: Declaration): string {
  const docs = entry.node.children
    .filter((n) => n.kind === "DOC_COMMENT")
    .map((n) => textOf(entry.source, n).replace(/^\/\/\/\s?/, ""))
    .join(" ");
  if (docs) return docs;
  const fields = children(entry.node, "FIELD_DECL");
  return fields.length
    ? `${fields.length} fields`
    : entry.node.kind.replace("_DECL", "").toLowerCase().replaceAll("_", " ");
}
