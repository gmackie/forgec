/** The generated baseline schema must match the reviewed migration baseline (plan §22). */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("reviewed migrations", () => {
  it("0001_init.sql in examples/acme/migrations/d1 equals the generated baseline", () => {
    const generated = readFileSync(resolve(import.meta.dirname, "..", "fixtures", "acme.0001_init.sql"), "utf8");
    const reviewed = readFileSync(resolve(import.meta.dirname, "..", "..", "examples", "acme", "migrations", "d1", "0001_init.sql"), "utf8");
    expect(reviewed).toBe(generated);
  });
});
