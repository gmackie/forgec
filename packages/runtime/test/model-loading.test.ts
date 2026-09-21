/** PAR-081 / PAR-083: the runtime refuses artifacts it cannot interpret and up-converts M8 bundles by rule. */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { Model, type AppBundle } from "../src/model.js";

const bundle = JSON.parse(readFileSync(resolve(import.meta.dirname, "..", "..", "..", "conformance", "fixtures", "acme.app.json"), "utf8")) as AppBundle;

describe("bundle loading", () => {
  it("loads an M8-shaped bundle (no `requires`, no governance fields) with defaults", () => {
    const m8 = structuredClone(bundle) as AppBundle & { ir: { requires?: string[] } };
    delete m8.ir.requires;
    const m = new Model(m8);
    expect(m.resources.length).toBeGreaterThan(0);
    expect(m.purposes).toEqual([]);
  });
  it("fails closed on an unknown critical feature or IR version", () => {
    const future = structuredClone(bundle) as AppBundle & { ir: { requires?: string[] } };
    future.ir.requires = ["capability-algebra/9"];
    expect(() => new Model(future)).toThrow(/capability-algebra\/9/);
    const v7 = structuredClone(bundle);
    (v7.ir as { version: string }).version = "domain-ir/7";
    expect(() => new Model(v7)).toThrow(/domain-ir\/7/);
  });
});
