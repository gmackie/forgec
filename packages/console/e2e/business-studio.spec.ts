import { test, expect } from "@playwright/test";
test("business design, developer details and live use are distinct and preserve the draft", async ({
  page,
}) => {
  await page.goto("/");
  await page
    .getByLabel("Administrator token")
    .fill("local-console-test-token-1234567890");
  await page.getByRole("button", { name: "Connect to instance" }).click();
  await expect(page.getByRole("tab", { name: /^Data \d/ })).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Source", exact: true }),
  ).toHaveCount(0);
  await page.getByRole("button", { name: "Contact", exact: true }).click();
  await page.getByRole("button", { name: "Edit draft", exact: true }).click();
  await page.getByRole("button", { name: "Try form", exact: true }).click();
  await expect(page.getByRole("form", { name: "Try draft form" })).toBeVisible();
  await expect(page.getByRole("form", { name: "Try draft form" }).locator('input[type="email"]')).toBeVisible();
  await page
    .getByRole("button", { name: "Configure email", exact: true })
    .click();
  await expect(page.getByRole("combobox", { name: "Field type" })).toHaveValue(
    "email",
  );
  await page.getByLabel("Field name", { exact: true }).fill("businessEmail");
  await page.getByRole("button", { name: "Save field", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Configure businessEmail", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: /^Developer/ }).click();
  await page.getByRole("button", { name: "Source", exact: true }).click();
  await expect(page.getByLabel("Forge source", { exact: true })).toHaveText(
    /businessEmail : email/,
  );
  await page.getByRole("tab", { name: /^Functions/ }).click();
  await page
    .getByRole("button", { name: "EscalateTicket", exact: true })
    .click();
  await expect(page.getByLabel("HTTP path", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: /^Design/ }).click();
  await expect(page.getByLabel("HTTP path", { exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: /^Use/ }).click();
  await expect(
    page.getByRole("heading", { name: "Your daily workspace" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Open records" }),
  ).toBeDisabled();
  await page.getByRole("button", { name: /^Design/ }).click();
  await page.getByRole("tab", { name: /^Data \d/ }).click();
  await page.getByRole("button", { name: "Contact", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Configure businessEmail", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Undo edit" }).click();
  await expect(
    page.getByRole("button", { name: "Configure email", exact: true }),
  ).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
});

test("Use loads an explicit environment, reviews record edits and preserves input across views", async ({
  page,
}) => {
  const { readFileSync } = await import("node:fs");
  const bundle = JSON.parse(
    readFileSync(
      new URL("../../../conformance/fixtures/acme.app.json", import.meta.url),
      "utf8",
    ),
  );
  let name = "Original customer";
  const calls: any[] = [];
  await page.route("**/api/runtime/targets", (r) =>
    r.fulfill({
      json: {
        targets: [
          {
            id: "demo",
            name: "Demo environment",
            endpoint: "https://example.test",
          },
        ],
      },
    }),
  );
  await page.route("**/api/runtime/targets/demo/workspace", (r) =>
    r.fulfill({
      json: {
        buildHash: bundle.buildHash,
        descriptor: bundle.ui,
        operations: ["@acme/commerce/_/Customer.list.all", "@acme/commerce/_/Customer.create", "@acme/commerce/_/Customer.update", ...["propose","preview","approve","commit"].map((name) => `@acme/commerce/_/changesets.${name}`)].map((id) => ({id,method:"POST",path:"/test",kind:"test"})),
      },
    }),
  );
  await page.route("**/api/runtime/targets/demo/record", async (r) => {
    const body = r.request().postDataJSON();
    calls.push(body);
    let value: any = { items: [{ id: "c1", code: "BIZ", name, version: 1 }] };
    if (body.operationId.endsWith("changesets.propose"))
      value = { id: "proposal" };
    if (body.operationId.endsWith("changesets.preview"))
      value = {
        contentHash: "hash",
        items: [
          {
            index: 0,
            op: "Customer.update",
            status: "ok",
            diff: [{ path: "name", before: name, after: "Updated customer" }],
          },
        ],
        budget: { physicalActions: 1, physicalLimit: 10, atomicAllowed: true },
      };
    if (body.operationId.endsWith("changesets.approve")) value = {};
    if (body.operationId.endsWith("changesets.commit")) {
      name = "Updated customer";
      value = { status: "committed", results: [] };
    }
    await r.fulfill({ json: { ok: true, value } });
  });
  await page.goto("/");
  await page
    .getByLabel("Administrator token")
    .fill("local-console-test-token-1234567890");
  await page.getByRole("button", { name: "Connect to instance" }).click();
  await page.getByRole("button", { name: /^Use/ }).click();
  await expect(
    page.getByRole("button", { name: "Open records" }),
  ).toBeDisabled();
  await page.getByLabel("Record environment").selectOption("demo");
  await page.getByRole("button", { name: "Open records" }).click();
  await expect(page.getByRole("button", { name: "Add row" })).toBeVisible();
  await expect(page.getByText("Live data · Demo environment")).toBeVisible();
  await page.getByLabel("name of c1", { exact: true }).fill("Updated customer");
  await page.getByRole("button", { name: /^Design/ }).click();
  await page.getByRole("button", { name: /^Use/ }).click();
  await expect(page.getByLabel("name of c1", { exact: true })).toHaveValue(
    "Updated customer",
  );
  await expect(
    page.getByRole("button", { name: "Change environment", exact: true }),
  ).toBeDisabled();
  await expect(
    page.getByRole("button", { name: "Gizmos", exact: true }),
  ).toBeDisabled();
  await page.getByRole("button", { name: "Apps", exact: true }).click();
  await page.getByRole("button", { name: "Editor", exact: true }).click();
  await expect(page.getByLabel("name of c1", { exact: true })).toHaveValue(
    "Updated customer",
  );
  expect(calls.every((c) => !c.operationId.includes("changesets"))).toBe(true);
  await page
    .getByRole("button", { name: "Preview changes", exact: true })
    .click();
  await expect(
    page.getByRole("dialog", { name: "Changeset preview" }),
  ).toContainText("Original customer → Updated customer");
  await page.getByRole("button", { name: "Save changes", exact: true }).click();
  await expect(
    page.getByRole("dialog", { name: "Changeset preview" }),
  ).toHaveCount(0);
  expect(
    calls.find((c) => c.operationId.endsWith("changesets.propose")).input
      .operations[0].input.patch,
  ).toEqual({ name: "Updated customer" });
  await page.getByRole("button", { name: "Gizmos", exact: true }).click();
  await page.getByRole("button", { name: /Customer directory/ }).click();
  await expect(
    page.getByRole("heading", { name: "Updated customer", exact: true }),
  ).toBeVisible();
  await page.getByLabel("Search directory page").fill("not a customer");
  await expect(
    page.getByText("No matching people on this page. Try another search."),
  ).toBeVisible();
  await page.getByLabel("Search directory page").fill("Updated");
  await page.setViewportSize({ width: 390, height: 844 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.getByRole("button", { name: "Manage customers in forms" }).click();
  await expect(page.getByLabel("name of c1", { exact: true })).toHaveValue("Updated customer");
  await page.getByRole("button", { name: "Browse records", exact: true }).click();
  await expect(page.getByRole("button", { name: "View Updated customer" })).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.getByRole("button", { name: "Edit records", exact: true }).click();
  await expect(page.getByLabel("name of c1", { exact: true })).toHaveValue(
    "Updated customer",
  );
  expect(calls.every((c) => c.buildHash === bundle.buildHash)).toBe(true);
});
