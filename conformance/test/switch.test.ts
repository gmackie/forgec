/**
 * Provider switching (plan §22), live: fence the source, export from it,
 * import into the target behind its fence, verify counts/hashes/references/
 * revisions on both sides, then lift the fences. Requires FORGE_SOURCE_URL and
 * FORGE_TARGET_URL pointing at two deployments of the same package.
 */
import { describe, expect, it } from "vitest";
import { createClient } from "../fixtures/acme.client.js";

const SOURCE = process.env["FORGE_SOURCE_URL"];
const TARGET = process.env["FORGE_TARGET_URL"];
const tenant = `switch-${Date.now().toString(36)}`;

describe.skipIf(!SOURCE || !TARGET)("provider switching between live deployments", () => {
  it("export on one provider, import + verify on the other, revisions and identities preserved", async () => {
    const src = createClient({ baseUrl: SOURCE!, tenant, actor: "operator" });
    const dst = createClient({ baseUrl: TARGET!, tenant, actor: "operator" });
    const c = await src.customers.create({ code: "SWI", name: "Switch" });
    const s = await src.sites.create({ customer: c.id, code: "hq", name: "HQ", timezone: "UTC" });
    const o = await src.orders.create({ customer: c.id, site: s.id, subtotal: "10.00", tax: "1.00", requestedOn: "2026-09-20" });
    await src.orders.update(o.id, 1, { subtotal: "12.00" });
    const gone = await src.customers.create({ code: "OLD", name: "Old" });
    await src.customers.delete(gone.id, 1);

    await src.admin.fence(true);
    try {
      const snap = await src.admin.export();
      expect(snap.resources["@acme/commerce/_/Customer"]!.count).toBe(2);
      expect(snap.resources["@acme/commerce/_/Order"]!.records[0]).toMatchObject({ id: o.id, version: 2 });
      await dst.admin.fence(true);
      const report = await dst.admin.import(snap);
      expect(report.imported["@acme/commerce/_/Order"]).toBe(1);
      const verify = await dst.admin.verify(snap);
      expect(verify.ok).toBe(true);
      expect(verify.resources["@acme/commerce/_/Order"]).toMatchObject({ hashMatch: true, references: { missing: 0 } });
      // the source still verifies against its own export (nothing moved while fenced)
      expect((await src.admin.verify(snap)).ok).toBe(true);
    } finally {
      await src.admin.fence(false);
      await dst.admin.fence(false);
    }
    // traffic on the new provider: same identity, same revision, same contract
    const moved = await dst.orders.update(o.id, 2, { tax: "2.00" });
    expect(moved).toMatchObject({ id: o.id, version: 3, total: "14.00" });
    const dupExit = await dst.customers.create({ code: "SWI", name: "Again" }).then(() => "ok", (e: { code?: string }) => e.code);
    expect(dupExit).toBe("UniqueConflict");
  }, 120_000);
});
