/**
 * The SQL facades (raw D1, Drizzle, Effect Connection) must execute the same
 * logical plans with the same semantics (plan §10.2). Requires the harness
 * Worker running on real local D1:
 *   FORGE_D1_HARNESS=http://localhost:8798 pnpm test:d1
 * (start it with `pnpm exec wrangler dev --config test/d1-harness/wrangler.jsonc --port 8798`
 *  after `wrangler d1 migrations apply forge-harness --local --config test/d1-harness/wrangler.jsonc`)
 */
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { runScenario } from "../../../conformance/src/runner.js";
import { HttpTarget } from "../../../conformance/src/http-target.js";
import { loadScenarios } from "../../../conformance/src/scenarios.js";
import * as client from "../../../conformance/fixtures/acme.client.js";
import type { ClientModule } from "../../../conformance/src/http-target.js";

const base = process.env["FORGE_D1_HARNESS"];

describe.skipIf(!base)("D1 facades run the full conformance suite identically", () => {
  for (const facade of ["raw-d1", "drizzle", "effect-sql"]) {
    for (const scenario of loadScenarios()) {
      it(`${facade}: ${scenario.id}`, async () => {
        const c: ClientModule = { createClient: (o) => client.createClient({ ...o, headers: { "x-facade": facade } }) };
        const report = await runScenario(scenario, new HttpTarget(c, base!, facade), { tenant: `t-${facade}-${randomUUID().slice(0, 8)}` });
        expect(report.failures).toEqual([]);
      }, 60_000);
    }
  }
});
