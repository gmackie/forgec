import { expect, it } from "vitest";
import { forgePackage } from "../web/forge-package.js";

const source = 'export function GetNote\n  @http(GET, "/notes/{id}")\n{\n}\n';

it("wraps the importer's Forge source in the package forgec check opens", () => {
  const packed = forgePackage("@external/notes", {
    files: [{ path: "src/index.forge", text: source }],
    report: {
      source: { title: "Notes", version: "1.2.3", openapi: "3.1.0" },
      hosts: ["notes.example.com"],
      operations: [],
      skippedOperations: [],
      unsupported: [{ feature: "array", at: "/notes", note: "kept as json" }],
      foreignIdentifiers: [],
      callbacks: [],
    },
  });
  expect(packed.error).toBeUndefined();
  expect(packed.files!.map((file) => file.path)).toEqual(["forge.toml", "src/index.forge", "import-report.json"]);
  expect(packed.files![0]!.text).toBe(
    '[package]\nname = "@external/notes"\nversion = "1.2.3"\nedition = "2026"\n\n[source]\nroot = "src"\nentry = "src/index.forge"\n\n[compatibility]\nprofile = "portable-v1"\ntargets = ["cloudflare-d1", "aws-dynamodb"]\n',
  );
  expect(packed.files![1]!.text).toBe(source);
  expect(packed.files![2]!.text).toContain('"feature": "array"');
});

it("keeps a manifest and report the importer already wrote", () => {
  const packed = forgePackage("@external/notes", {
    files: [
      { path: "forge.toml", text: "kept-toml\n" },
      { path: "src/index.forge", text: source },
      { path: "import-report.json", text: "kept-report\n" },
    ],
  });
  expect(packed.files!.map((file) => file.text)).toEqual(["kept-toml\n", source, "kept-report\n"]);
});

it("returns the importer error and refuses a path outside the package", () => {
  expect(forgePackage("@external/notes", { error: "private host" })).toEqual({ error: "private host" });
  expect(forgePackage("@external/notes", { files: [{ path: "../secret.forge", text: source }] }).error).toMatch(/Refusing/);
  expect(forgePackage("@external/notes", { files: [] }).error).toMatch(/did not produce/);
});
