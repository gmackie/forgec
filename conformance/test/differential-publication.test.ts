import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it, expect } from "vitest";
import { runDifferentialCli } from "../src/differential-cli.js";

it("a failed or empty run cannot leave a previous passing differential report", () => {
  const root = mkdtempSync(join(tmpdir(), "forge-differential-publication-"));
  try {
    mkdirSync(join(root, "reports"));
    for (const status of [0, 1]) {
      writeFileSync(join(root, "reports/differential.json"), JSON.stringify({ drift: "none" }));
      expect(runDifferentialCli(root, () => ({ status }))).toBe(1);
      expect(existsSync(join(root, "reports/differential.json"))).toBe(false);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

it("publishes only a complete passing invocation, removing candidates after failures", () => {
  const root = mkdtempSync(join(tmpdir(), "forge-differential-publication-"));
  try {
    for (const [status, passed, pending, expected] of [[1, 2, 0, 1], [0, 1, 1, 1], [0, 0, 0, 1], [0, 2, 0, 0]]) {
      expect(runDifferentialCli(root, () => {
        writeFileSync(join(root, "reports/differential-candidate.json"), JSON.stringify({ drift: "none" }));
        writeFileSync(join(root, "reports/differential-suite.json"), JSON.stringify({ success: true, numFailedTests: 0, numPendingTests: pending, numTodoTests: 0, testResults: [{ assertionResults: Array.from({ length: passed! }, () => ({ status: "passed" })) }] }));
        return { status: status! };
      })).toBe(expected);
      expect(existsSync(join(root, "reports/differential.json"))).toBe(expected === 0);
      expect(existsSync(join(root, "reports/differential-candidate.json"))).toBe(false);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});
