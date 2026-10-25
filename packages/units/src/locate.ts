// Finds where `impl/` defines each unit, statically: nothing in impl/ is executed. A function
// unit is `export const x = defineFunction("<id>", ...)`; an external unit is an entry of
// `export const externals = { "<id>": ident }` in the impl index, resolved through its import.
// It reads through a `SourceFiles` view (FORG-50), so it runs the same over a checkout or a snapshot.
import ts from "typescript";
import { dirname, join, nodeFiles, normalize, text, type SourceFiles } from "./files.ts";

export interface ImplSite {
  symbol: string;
  /** App-relative, `/`-separated. */
  file: string;
  exportName: string;
  binding: "function" | "external";
  /** Byte range `[start, end)` of the exported definition in `file` (UTF-8 bytes, not UTF-16 units). */
  start: number;
  end: number;
}

/** Byte offsets of a node's text (leading trivia excluded). TypeScript positions are UTF-16 units. */
const utf8 = new TextEncoder();
function byteRange(src: ts.SourceFile, node: ts.Node): { start: number; end: number } {
  // TextEncoder counts a lone surrogate as U+FFFD's 3 bytes, as Buffer.byteLength does.
  const bytes = (pos: number) => utf8.encode(src.text.slice(0, pos)).byteLength;
  return { start: bytes(node.getStart(src)), end: bytes(node.end) };
}

/** The top-level statement that exports `name`, or the whole file when it is re-exported some other way. */
function definitionOf(files: SourceFiles, file: string, name: string): { start: number; end: number } {
  const src = parse(files, file);
  for (const stmt of src.statements) {
    if (!exported(stmt)) continue;
    if ((ts.isFunctionDeclaration(stmt) || ts.isClassDeclaration(stmt)) && stmt.name?.text === name) return byteRange(src, stmt);
    if (ts.isVariableStatement(stmt) && stmt.declarationList.declarations.some((d) => ts.isIdentifier(d.name) && d.name.text === name)) return byteRange(src, stmt);
  }
  return { start: 0, end: utf8.encode(src.text).byteLength };
}

export interface LocateOptions {
  implDir?: string;
  index?: string;
}

function sourceFiles(files: SourceFiles, dir: string): string[] {
  return files
    .list(dir)
    .filter((f) => /\.(ts|tsx|mts)$/.test(f) && !/\.d\.ts$|\.test\.tsx?$/.test(f))
    .sort();
}

function parse(files: SourceFiles, file: string): ts.SourceFile {
  const bytes = files.read(file);
  if (!bytes) throw new Error(`${file} does not exist`);
  return ts.createSourceFile(file, text(bytes), ts.ScriptTarget.ES2022, true);
}

function exported(node: ts.Node): boolean {
  return ts.canHaveModifiers(node) && (ts.getModifiers(node) ?? []).some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
}

/** `./payment-adapter.js` written for NodeNext resolves to the `.ts` source next to it. */
function resolveImport(files: SourceFiles, from: string, spec: string): string | null {
  if (!spec.startsWith(".")) return null;
  const base = join(dirname(from), spec);
  const stem = base.replace(/\.(m?js|tsx?)$/, "");
  for (const c of [base, `${stem}.ts`, `${stem}.tsx`, `${stem}.mts`, join(base, "index.ts")]) if (c.match(/\.(ts|tsx|mts)$/) && files.read(c)) return c;
  return null;
}

export function locateImpl(appRoot: string, options: LocateOptions = {}): Map<string, ImplSite> {
  return locateIn(nodeFiles(appRoot), options);
}

/** `locateImpl` over any view of the app's files; paths are relative to the app root. */
export function locateIn(files: SourceFiles, options: LocateOptions = {}): Map<string, ImplSite> {
  const implDir = normalize(options.implDir ?? "impl");
  const index = normalize(options.index ?? "impl/index.ts");
  const rel = (f: string) => f.split("\\").join("/");
  const sites = new Map<string, ImplSite>();
  const add = (site: ImplSite) => {
    const previous = sites.get(site.symbol);
    if (previous) throw new Error(`${site.symbol} is implemented twice: ${previous.file}#${previous.exportName} and ${site.file}#${site.exportName}`);
    sites.set(site.symbol, site);
  };

  for (const file of sourceFiles(files, implDir)) {
    const src = parse(files, file);
    for (const stmt of src.statements) {
      if (!ts.isVariableStatement(stmt) || !exported(stmt)) continue;
      for (const decl of stmt.declarationList.declarations) {
        const init = decl.initializer;
        if (!ts.isIdentifier(decl.name) || !init || !ts.isCallExpression(init)) continue;
        if (!ts.isIdentifier(init.expression) || init.expression.text !== "defineFunction") continue;
        const id = init.arguments[0];
        if (!id || !ts.isStringLiteralLike(id)) throw new Error(`${rel(file)}: defineFunction id must be a string literal`);
        add({ symbol: id.text, file: rel(file), exportName: decl.name.text, binding: "function", ...byteRange(src, stmt) });
      }
    }
  }

  if (!files.read(index)) return sites;
  const src = parse(files, index);
  const imports = new Map<string, { file: string; name: string }>();
  for (const stmt of src.statements) {
    if (!ts.isImportDeclaration(stmt) || !ts.isStringLiteral(stmt.moduleSpecifier)) continue;
    const bindings = stmt.importClause?.namedBindings;
    const target = resolveImport(files, index, stmt.moduleSpecifier.text);
    if (!target || !bindings || !ts.isNamedImports(bindings)) continue;
    for (const el of bindings.elements) imports.set(el.name.text, { file: target, name: (el.propertyName ?? el.name).text });
  }
  for (const stmt of src.statements) {
    if (!ts.isVariableStatement(stmt) || !exported(stmt)) continue;
    for (const decl of stmt.declarationList.declarations) {
      if (!ts.isIdentifier(decl.name) || decl.name.text !== "externals") continue;
      if (!decl.initializer || !ts.isObjectLiteralExpression(decl.initializer)) throw new Error(`${rel(index)}: externals must be an object literal`);
      for (const prop of decl.initializer.properties) {
        const key = ts.isPropertyAssignment(prop) && (ts.isStringLiteralLike(prop.name) || ts.isIdentifier(prop.name)) ? prop.name.text : null;
        const value = ts.isPropertyAssignment(prop) ? prop.initializer : null;
        if (!key || !value || !ts.isIdentifier(value)) throw new Error(`${rel(index)}: each external must be \`"<id>": <imported binding>\``);
        const target = imports.get(value.text);
        if (!target) throw new Error(`${rel(index)}: external ${key} is bound to ${value.text}, which is not imported from a local module`);
        add({ symbol: key, file: rel(target.file), exportName: target.name, binding: "external", ...definitionOf(files, target.file, target.name) });
      }
    }
  }
  return sites;
}
