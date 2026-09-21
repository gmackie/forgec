import { readFileSync } from "node:fs";
import { it, expect } from "vitest";
import { language } from "../web/editor/language.js";
import { children } from "../web/editor/model.js";
import {
  fieldNameTaken,
  saveField,
  dependencyDraft,
  dependencyText,
  classificationOptions,
} from "../web/editor/composer-model.js";
const inspect = await language(
  readFileSync(new URL("../generated/editor.wasm", import.meta.url)),
);
it("saves a focused field form in one lossless edit", () => {
  const source =
    'resource Person {\n id : id\n email : email = "old@example.com" @unique // retain this\n}\n';
  const analysis = inspect({
    name: "@test/app",
    currentFile: "a.forge",
    files: [{ path: "a.forge", text: source }],
  });
  const field = children(
    children(analysis.tree, "RESOURCE_DECL")[0]!,
    "FIELD_DECL",
  )[1]!;
  const next = saveField(source, field, {
    name: "email",
    type: "email?",
    value: '"new@example.com"',
    classification: "data.contact.email",
    unique: false,
    immutable: true,
  });
  expect(next).toContain('email : email? = "new@example.com"');
  expect(next).toContain("@data(data.contact.email)");
  expect(next).toContain("@immutable");
  expect(next).not.toContain("@unique");
  expect(next).toContain("// retain this");
  expect(next).toContain("id : id");
  expect(
    inspect({
      name: "@test/app",
      currentFile: "a.forge",
      files: [{ path: "a.forge", text: next }],
    }).diagnostics,
  ).toEqual([]);
});

it("adds a default and decorators together after the field type", () => {
  const source = "resource Person {\n id : id\n name : text // preserve\n}\n";
  const run = (text: string) =>
    inspect({
      name: "@test/app",
      currentFile: "a.forge",
      files: [{ path: "a.forge", text }],
    });
  const field = children(
    children(run(source).tree, "RESOURCE_DECL")[0]!,
    "FIELD_DECL",
  )[1]!;
  const next = saveField(source, field, {
    name: "name",
    type: "text",
    value: '"hi"',
    classification: "data.identity.name",
    unique: false,
    immutable: true,
  });
  expect(next).toContain(
    'name : text = "hi" @data(data.identity.name) @immutable // preserve',
  );
  expect(run(next).diagnostics).toEqual([]);
});

it("round trips qualified resource, purpose and function dependencies", () => {
  for (const value of [
    "crm.Ticket read",
    "Ticket read for purpose.Support",
    "ChargeCard",
    "Ticket.status.assign",
    "Ticket write",
  ]) {
    expect(dependencyText(dependencyDraft(value))).toBe(value);
  }
});

it("scopes same-name custom classifications to their module", () => {
  const result = inspect({
    name: "@test/app",
    currentFile: "a.forge",
    files: [
      {
        path: "a.forge",
        text: "module a\ndataClass Contact extends data.contact.email\n",
      },
      {
        path: "b.forge",
        text: "module b\ndataClass Contact extends data.identity.name\n",
      },
    ],
  });
  expect(result.diagnostics).toEqual([]);
  const choices = classificationOptions(result, "a").filter(
    (c) => c.value === "Contact",
  );
  expect(choices).toHaveLength(1);
  expect(choices[0]).toMatchObject({
    id: "@test/app/a/Contact",
    parent: "data.contact.email",
    handling: "confidential",
  });
});

it("recognizes the edited field after a compiler refresh replaces syntax node objects", () => {
  const source = "resource Person {\n id : id\n email : email\n}";
  const run = () =>
    inspect({
      name: "@test/app",
      currentFile: "a.forge",
      files: [{ path: "a.forge", text: source }],
    });
  const original = children(
    children(run().tree, "RESOURCE_DECL")[0]!,
    "FIELD_DECL",
  )[1]!;
  const refreshed = children(run().tree, "RESOURCE_DECL")[0]!;
  expect(fieldNameTaken(source, refreshed, original, "email")).toBe(false);
  expect(fieldNameTaken(source, refreshed, original, "id")).toBe(true);
});
