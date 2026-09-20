import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { loadVectorFile, type VectorFile } from "../src/vectors.js";

const dir = resolve(import.meta.dirname, "..", "..", "specs", "codecs", "vectors");
const files = readdirSync(dir).filter((f) => f.endsWith(".json"));

describe("codec golden vectors are well-formed executable specs", () => {
  it("has the expected codec files", () => {
    expect(files.sort()).toEqual([
      "decimal.json", "enum.json", "identity.json", "integer.json", "sort.json", "temporal.json", "text.length.json", "text.normalize.json",
    ]);
  });

  it.each(files)("%s parses and every case has exactly one result key and a unique name", (f) => {
    const v: VectorFile = loadVectorFile(readFileSync(resolve(dir, f), "utf8"));
    expect(v.codec).toBeTruthy();
    expect(v.version).toBe(1);
    const names = new Set<string>();
    for (const c of v.cases) {
      expect(names.has(c.name), `duplicate case ${c.name}`).toBe(false);
      names.add(c.name);
      const keys = ["expect", "error", "expect_order", "expect_distinct"].filter((k) => k in c);
      expect(keys, `${f}:${c.name}`).toHaveLength(1);
      const inputs = ["input", "input_json", "input_list"].filter((k) => k in c);
      expect(inputs, `${f}:${c.name}`).toHaveLength(1);
      if ("expect_order" in c || "expect_distinct" in c) expect("input_list" in c).toBe(true);
    }
  });
});
