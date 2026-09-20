/**
 * Runs every scenario against a deployed endpoint through the generated
 * client. Enabled with FORGE_TARGET_URL; FORGE_TARGET_NAME labels the report.
 *
 *   FORGE_TARGET_URL=http://localhost:8787 FORGE_TARGET_NAME=cloudflare-local pnpm vitest run test/remote.test.ts
 */
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import * as client from "../fixtures/acme.client.js";
import { HttpTarget } from "../src/http-target.js";
import { runScenario, type Report } from "../src/runner.js";
import { loadScenarios } from "../src/scenarios.js";

const url = process.env["FORGE_TARGET_URL"];
const name = process.env["FORGE_TARGET_NAME"] ?? "remote";
const reports: Report[] = [];

describe.skipIf(!url)(`conformance against ${name} (${url})`, () => {
  for (const scenario of loadScenarios()) {
    it(`${scenario.id}: ${scenario.title}`, async () => {
      const report = await runScenario(scenario, new HttpTarget(client, url!, name), { tenant: `t-${randomUUID().slice(0, 8)}` });
      reports.push(report);
      expect(report.failures).toEqual([]);
    }, 60_000);
  }
  afterAll(() => {
    const dir = resolve(import.meta.dirname, "..", "reports");
    mkdirSync(dir, { recursive: true });
    const summary = { target: name, url, at: new Date().toISOString(), scenarios: reports.map((r) => ({ id: r.scenario, steps: r.steps, failures: r.failures })) };
    writeFileSync(resolve(dir, `${name}.json`), JSON.stringify(summary, null, 2));
  });
});
