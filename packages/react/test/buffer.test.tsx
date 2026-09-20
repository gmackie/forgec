import { describe, expect, it } from "vitest";
import { EditBuffer, buildChangeset } from "../src/buffer.js";
import type { UiResource } from "../src/descriptor.js";

const customer: UiResource = {
  id: "@acme/commerce/_/Customer", name: "Customer", kind: "resource", label: "Customer", plural: "Customers", route: "customers", titleField: "name",
  fields: [
    { name: "id", label: "Id", widget: "readonly", required: false, editableOnCreate: false, editableOnUpdate: false, sortable: true },
    { name: "version", label: "Version", widget: "readonly", required: false, editableOnCreate: false, editableOnUpdate: false, sortable: true },
    { name: "code", label: "Code", widget: "text", required: true, editableOnCreate: true, editableOnUpdate: false, sortable: true },
    { name: "name", label: "Name", widget: "text", required: true, editableOnCreate: true, editableOnUpdate: true, sortable: true },
    { name: "email", label: "Email", widget: "email", required: false, editableOnCreate: true, editableOnUpdate: true, sortable: true },
    { name: "tier", label: "Tier", widget: "select", required: false, editableOnCreate: true, editableOnUpdate: true, sortable: true, options: [{ value: "standard", label: "Standard" }, { value: "gold", label: "Gold" }] },
  ],
  tableColumns: ["code", "name", "tier"], lists: [], finds: [], actions: [], softDelete: true, versioned: true,
};

describe("EditBuffer", () => {
  it("tracks per-row edits against the loaded record, only writable fields, and yields a patch", () => {
    const b = new EditBuffer(customer);
    b.load([{ id: "c1", version: 3, code: "ACME", name: "Acme", email: "old@acme.co", tier: "standard" }]);
    b.set("c1", "name", "Acme Inc");
    b.set("c1", "email", "");
    b.set("c1", "code", "NEW"); // immutable: ignored
    b.set("c1", "version", 9); // server-owned: ignored
    expect(b.dirty()).toEqual(["c1"]);
    expect(b.patchFor("c1")).toEqual({ name: "Acme Inc", email: null }); // empty optional text clears
    b.set("c1", "name", "Acme");
    expect(b.patchFor("c1")).toEqual({ email: null });
    b.revert("c1");
    expect(b.dirty()).toEqual([]);
  });

  it("new rows become creates with defaults omitted; empty required fields are reported before proposing", () => {
    const b = new EditBuffer(customer);
    const tmp = b.addNew();
    b.set(tmp, "code", "beta");
    expect(b.validate()).toEqual([{ row: tmp, field: "name", code: "Required" }]);
    b.set(tmp, "name", "Beta");
    expect(b.validate()).toEqual([]);
    expect(b.createFor(tmp)).toEqual({ code: "beta", name: "Beta" });
  });

  it("builds a changeset proposal with updates (expectedVersion) and creates, in row order", () => {
    const b = new EditBuffer(customer);
    b.load([{ id: "c1", version: 3, code: "ACME", name: "Acme", email: null, tier: "standard" }]);
    b.set("c1", "tier", "gold");
    const tmp = b.addNew();
    b.set(tmp, "code", "beta");
    b.set(tmp, "name", "Beta");
    expect(buildChangeset(b)).toEqual({ mode: "resumable", operations: [
      { op: "@acme/commerce/_/Customer.update", input: { id: "c1", expectedVersion: 3, patch: { tier: "gold" } } },
      { op: "@acme/commerce/_/Customer.create", input: { code: "beta", name: "Beta" } },
    ] });
  });

  it("paste fills consecutive rows and columns from tab-separated text, creating rows as needed", () => {
    const b = new EditBuffer(customer);
    b.load([{ id: "c1", version: 1, code: "ACME", name: "Acme", email: null, tier: "standard" }]);
    b.paste("c1", "name", "Acme Inc\tops@acme.co\nBeta\tops@beta.co");
    expect(b.patchFor("c1")).toEqual({ name: "Acme Inc", email: "ops@acme.co" });
    const news = b.dirty().filter((r) => r.startsWith("new:"));
    expect(news).toHaveLength(1);
    expect(b.createFor(news[0]!)).toEqual({ name: "Beta", email: "ops@beta.co" });
  });
});
