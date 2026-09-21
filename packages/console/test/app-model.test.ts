import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { language } from "../web/editor/language.js";
import { example } from "../web/editor/example.js";
import { appDeclarations } from "../web/editor/app-model.js";
const inspect = await language(
  readFileSync(new URL("../generated/editor.wasm", import.meta.url)),
);
it("indexes app declarations across files with resource-scoped capabilities", () => {
  const entries = appDeclarations(example, inspect(example));
  expect(
    entries.filter((e) => e.category === "Resources").map((e) => e.name),
  ).toEqual(["Organization", "Contact", "Ticket", "Reply", "ServicePlan"]);
  expect(entries.find((e) => e.name === "Contact.Support")?.category).toBe(
    "Capabilities",
  );
  expect(entries.find((e) => e.name === "EscalateTicket")?.category).toBe(
    "Functions",
  );
  expect(entries.find((e) => e.name === "DailySupportDigest")?.category).toBe(
    "Sources",
  );
  expect(entries.find((e) => e.name === "CustomerSupport")?.category).toBe(
    "Purposes",
  );
  expect(new Set(entries.map((e) => e.id)).size).toBe(entries.length);
});
