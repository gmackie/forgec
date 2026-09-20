/** Outbox dispatch against real local D1 via the harness Worker's `/_forge/dispatch` endpoint. */
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";

const base = process.env["FORGE_D1_HARNESS"];
const H = { "content-type": "application/json" };

describe.skipIf(!base)("D1 outbox dispatch (live local D1)", () => {
  it("sweeps, delivers per subscription, retries failed ones, dead-letters and redrives", async () => {
    const tenant = `t-${randomUUID().slice(0, 8)}`;
    const T = { ...H, "x-forge-tenant": tenant };
    const c = await (await fetch(`${base}/v1/customers`, { method: "POST", headers: T, body: JSON.stringify({ code: "DISP", name: "D" }) })).json();
    expect(c.id).toBeTruthy();
    const sweep = async (failFor: string[], now: number) => (await fetch(`${base}/_forge/dispatch`, { method: "POST", headers: T, body: JSON.stringify({ tenant, now, failFor }) })).json();
    expect(await sweep(["b"], 1000)).toMatchObject({ report: { claimed: 1, delivered: 1, failed: 1, dead: 0 }, sent: ["a"] });
    expect(await sweep([], 2000)).toMatchObject({ report: { claimed: 0 } }); // leased
    expect(await sweep(["b"], 7000)).toMatchObject({ report: { claimed: 1, delivered: 0, failed: 1, dead: 1 }, sent: [] }); // a not repeated; b dead after 2 attempts
    const dead = await (await fetch(`${base}/_forge/dispatch/dead`, { headers: T })).json();
    expect(dead.map((d: any) => [d.status, d.attempts, d.delivered])).toEqual([["dead", 2, ["a"]]]);
    expect(await (await fetch(`${base}/_forge/dispatch/redrive`, { method: "POST", headers: T, body: JSON.stringify({ opId: dead[0].opId, ordinal: 0 }) })).json()).toEqual({ ok: true });
    expect(await sweep([], 20000)).toMatchObject({ report: { claimed: 1, delivered: 1, failed: 0, dead: 0 }, sent: ["b"] });
    const dedup = await (await fetch(`${base}/_forge/dispatch/consume`, { method: "POST", headers: T, body: JSON.stringify({ subscription: "b", messageId: "x:0" }) })).json();
    const dedup2 = await (await fetch(`${base}/_forge/dispatch/consume`, { method: "POST", headers: T, body: JSON.stringify({ subscription: "b", messageId: "x:0" }) })).json();
    expect([dedup.outcome, dedup2.outcome]).toEqual(["processed", "duplicate"]);
  }, 60_000);
});
