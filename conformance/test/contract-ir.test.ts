/**
 * `forgec build` writes `contract.json` (ForgeGraph contract IR v1). The curated
 * contracts in fixtures/contract-ir must pass ForgeGraph's own validator, vendored
 * verbatim in contract-ir/vendor: wire shape, ids, both fingerprint levels, `$ref`s.
 * Refresh them with scripts/refresh-fixtures.sh; scripts/validate-contracts.sh
 * sweeps every package in the repository the same way without committing output.
 */
import { readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { validateFile } from "../contract-ir/validate.js";

const dir = resolve(import.meta.dirname, "..", "fixtures", "contract-ir");
const files = readdirSync(dir).filter((f) => f.endsWith(".contract.json")).sort();

describe("forgec contract.json validates with ForgeGraph's validateContract", () => {
  it("has the curated set", () => {
    expect(files).toEqual([
      "acme.contract.json",
      "billing.contract.json",
      "console-playground.contract.json",
      "studio-desk.contract.json",
    ]);
  });

  it.each(files)("%s", (name) => {
    const result = validateFile(join(dir, name));
    expect(result.issues).toEqual([]);
    expect(result.ok).toBe(true);
    expect(result.operations).toBeGreaterThan(0);
  });

  it("the hand-written import fixture is a valid contract too", () => {
    const fixture = resolve(dir, "..", "..", "..", "crates", "forgegraph-codegen", "tests", "fixtures", "contract-import", "users-api.json");
    expect(validateFile(fixture).issues).toEqual([]);
  });

  it("studio-desk exposes every CRUD, function and workflow route", () => {
    expect(validateFile(join(dir, "studio-desk.contract.json")).operations).toBe(29);
  });
});
