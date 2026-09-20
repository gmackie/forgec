import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { runVector, type VectorCase } from "../src/codecs.js";

/** Every golden vector in specs/codecs/vectors is executed against the runtime codecs. */
const dir = resolve(import.meta.dirname, "..", "..", "..", "specs", "codecs", "vectors");

for (const file of readdirSync(dir).filter((f) => f.endsWith(".json")).sort()) {
  const v = JSON.parse(readFileSync(resolve(dir, file), "utf8")) as { codec: string; cases: VectorCase[] };
  describe(`${v.codec} (${file})`, () => {
    for (const c of v.cases) {
      it(c.name, () => {
        const outcome = runVector(v.codec, c);
        if ("error" in c) {
          expect(outcome).toEqual({ error: c.error });
        } else if ("expect" in c) {
          expect(outcome).toEqual({ value: c.expect });
        } else if ("expect_order" in c) {
          expect(outcome).toEqual({ order: c.expect_order });
        } else if ("expect_distinct" in c) {
          expect(outcome).toEqual({ distinct: c.expect_distinct });
        }
      });
    }
  });
}
