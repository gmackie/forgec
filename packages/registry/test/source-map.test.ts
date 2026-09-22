import { createHash } from "node:crypto";
import { expect, it } from "vitest";
import { verifySourceBytes, type SourceMap } from "../src/source-map.js";

it("checks original UTF-8 bytes before source navigation", () => {
  const bytes = new TextEncoder().encode("// café\n");
  const map: SourceMap = { version: "forge-source-map/1", package: "@test/maps", buildHash: "build", compilerVersion: "test", sources: { "src/a.forge": { digest: `sha256:${createHash("sha256").update(bytes).digest("hex")}`, byteLength: bytes.length } }, anchors: {}, derivations: {} };
  expect(verifySourceBytes(map, "src/a.forge", bytes)).toBe(true);
  expect(verifySourceBytes(map, "src/a.forge", new TextEncoder().encode("// cafe\n"))).toBe(false);
  expect(verifySourceBytes(map, "src/missing.forge", bytes)).toBe(false);
});
