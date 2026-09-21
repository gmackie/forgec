import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { language, type SyntaxNode } from "../web/editor/language.js";
import {
  patch,
  setClassification,
  toggleName,
  insertMember,
} from "../web/editor/model.js";
const inspect = await language(
  readFileSync(new URL("../generated/editor.wasm", import.meta.url)),
);
const source =
  "// 😀 original comment\nexport purpose Support\nexport resource Person @purposeScoped {\n  id : id\n  email : email // preserve me\n  capability Contact {\n    read { id email }\n  }\n  for Support { use Contact }\n}\n";
const analyze = (text: string) =>
  inspect({
    name: "@local/test",
    currentFile: "main.forge",
    files: [{ path: "main.forge", text }],
  });
const find = (n: SyntaxNode, kind: string): SyntaxNode =>
  n.kind === kind ? n : n.children.map((c) => find(c, kind)).find(Boolean)!;
it("edits a field using the real parser spans without rewriting comments or siblings", () => {
  const fields = find(analyze(source).tree, "RESOURCE_DECL").children.filter(
    (n) => n.kind === "FIELD_DECL",
  );
  const next = setClassification(source, fields[1]!, "data.contact.email");
  expect(next).toContain(
    "email : email @data(data.contact.email) // preserve me",
  );
  expect(next).toContain("// 😀 original comment");
  expect(next).toContain("for Support { use Contact }");
  expect(analyze(next).diagnostics.some((d) => d.severity === "error")).toBe(
    false,
  );
  const updated = find(analyze(next).tree, "RESOURCE_DECL").children.filter(
    (n) => n.kind === "FIELD_DECL",
  )[1]!;
  expect(setClassification(next, updated, "")).toContain(
    "email : email  // preserve me",
  );
});
it("changes explicit capability membership and adds fields without regenerating a resource", () => {
  const tree = analyze(source).tree;
  const names = find(tree, "NAME_SET");
  const next = toggleName(source, names, "email", false);
  expect(next).toContain("read { id  }");
  expect(next).toContain("email : email // preserve me");
  const withField = insertMember(
    next,
    find(analyze(next).tree, "RESOURCE_DECL"),
    "name : text",
  );
  expect(withField).toContain("name : text");
  expect(
    analyze(withField).diagnostics.some((d) => d.severity === "error"),
  ).toBe(false);
});
it("rejects stale or invalid edit spans", () => {
  expect(() => patch("abc", { start: 5, end: 6 }, "x")).toThrow();
});
it("keeps field decorators after defaults and derived values", async () => {
  const { setFieldFlag } = await import("../web/editor/model.js");
  const text =
    'resource Item {\n  id : id\n  name : text = "hello" // retain\n}\n';
  const field = find(analyze(text).tree, "RESOURCE_DECL").children.filter(
    (n) => n.kind === "FIELD_DECL",
  )[1]!;
  const changed = setFieldFlag(text, field, "immutable", true);
  expect(changed).toContain('name : text = "hello" @immutable // retain');
  expect(analyze(changed).diagnostics.some((d) => d.severity === "error")).toBe(
    false,
  );
});
it("exposes purpose, class and type symbols across project files", () => {
  const result = inspect({
    name: "@local/test",
    currentFile: "contacts.forge",
    files: [
      {
        path: "purposes.forge",
        text: "purpose Support\ndataClass Email extends data.contact.email\ntype EmailValue = email\n",
      },
      { path: "contacts.forge", text: "resource Contact {\n id : id\n}\n" },
    ],
  });
  expect(result.symbols).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        name: "Support",
        kind: "PURPOSE_DECL",
        file: "purposes.forge",
      }),
      expect.objectContaining({ name: "Email", kind: "DATA_CLASS_DECL" }),
    ]),
  );
});
it("uses syntax roles for field names that also happen to be keywords", async () => {
  const { nameOf, named } = await import("../web/editor/model.js");
  const text =
    "resource Entry {\n id : id\n type : text\n purpose : text\n source : text\n}\n";
  const fields = find(analyze(text).tree, "RESOURCE_DECL").children.filter(
    (n) => n.kind === "FIELD_DECL",
  );
  expect(fields.map((f) => nameOf(text, f))).toEqual([
    "id",
    "type",
    "purpose",
    "source",
  ]);
  expect(named(text, fields[1]!)).toBeDefined();
});

it("compiles every service desk demo file with the browser compiler", async () => {
  const { example } = await import("../web/editor/example.js");
  expect(example.files).toHaveLength(7);
  for (const file of example.files) {
    const result = inspect({ ...example, currentFile: file.path });
    expect(result.error).toBeUndefined();
    expect(result.diagnostics).toEqual([]);
    expect(result.tree.children.some((n) => n.kind.endsWith("_DECL"))).toBe(
      true,
    );
    expect(result.symbols.some((s) => s.name === "CustomerSupport")).toBe(true);
  }
});

it("exposes authoritative field classifications for the data catalog", async () => {
  const { example } = await import("../web/editor/example.js");
  const result = inspect(example);
  expect(
    result.dataClasses?.find((c) => c.name === "ContactEmail"),
  ).toMatchObject({
    parent: "data.contact.email",
    handling: "confidential",
    personal: "yes",
  });
  expect(
    result.dataSemantics?.fields.find(
      (f) => f.resource.endsWith("/Contact") && f.field === "email",
    ),
  ).toMatchObject({
    handling: "confidential",
    personal: "yes",
    evidence: "declared",
  });
  expect(
    result.dataSemantics?.fields.find(
      (f) => f.resource.endsWith("/Organization") && f.field === "name",
    ),
  ).toMatchObject({
    class: "data.unknown",
    handling: "restricted",
    completeness: "unclassified",
  });
});
