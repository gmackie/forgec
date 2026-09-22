import { test, expect } from "@playwright/test";
async function login(page: import("@playwright/test").Page) {
  await page.goto("/");
  await page
    .getByLabel("Administrator token")
    .fill("local-console-test-token-1234567890");
  await page.getByRole("button", { name: "Connect to instance" }).click();
  await page.getByRole("button", { name: /^Developer/ }).click();
  await expect(page.getByRole("tab", { name: /^Resources/ })).toBeVisible();
}
test("composes resources with a focused field editor and native data catalog", async ({
  page,
}) => {
  await login(page);
  await expect(page.getByRole("tab", { name: /^Capabilities/ })).toHaveCount(0);
  await page.getByRole("button", { name: "Contact", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Schema", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Edit draft", exact: true }).click();
  await page
    .getByRole("button", { name: "Edit field email", exact: true })
    .click();
  await page.getByLabel("Find a data class").fill("data.contact.email");
  await page
    .getByRole("button", { name: "data.contact.email", exact: false })
    .click();
  await page.getByRole("button", { name: "Save field", exact: true }).click();
  await page.getByRole("button", { name: "Source", exact: true }).click();
  await expect(page.getByLabel("Forge source")).toHaveValue(
    /email : email @data\(data.contact.email\)/,
  );
  await page.getByRole("button", { name: "Document", exact: true }).click();
  await page
    .getByRole("button", { name: "Access & purpose", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Purpose bindings", exact: true }),
  ).toBeVisible();
  await page.getByRole("tab", { name: /^Data catalog/ }).click();
  await page.getByLabel("Search data catalog").fill("email");
  await expect(
    page.getByRole("row").filter({ hasText: "contact.email" }).first(),
  ).toContainText("confidential");
});
test("defines function contracts and follows sources to their functions", async ({
  page,
}) => {
  await login(page);
  await page.getByRole("tab", { name: /^Functions/ }).click();
  await page
    .getByRole("button", { name: "EscalateTicket", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Dependencies", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("EscalationInput", { exact: true }).first(),
  ).toBeVisible();
  await page.getByRole("button", { name: "Edit draft", exact: true }).click();
  await page.getByLabel("HTTP path").fill("/v2/escalations");
  await page
    .getByRole("button", { name: "Save endpoint", exact: true })
    .click();
  await page.getByRole("button", { name: "Source", exact: true }).click();
  await expect(page.getByLabel("Forge source")).toHaveValue(
    /@http\(POST, "\/v2\/escalations"\)/,
  );
  await page.getByRole("tab", { name: /^Sources/ }).click();
  await page
    .getByRole("button", { name: "DailySupportDigest", exact: true })
    .click();
  await expect(page.getByLabel("Cron schedule")).toHaveValue("0 8 * * *");
  await page
    .getByRole("button", { name: "Explore BuildSupportDigest", exact: true })
    .click();
  await expect(
    page.getByLabel("Declaration name", { exact: true }),
  ).toHaveValue("BuildSupportDigest");
  await page.setViewportSize({ width: 390, height: 844 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
});

test("edits function dependencies with labeled controls and restores an endpoint on undo", async ({
  page,
}) => {
  await login(page);
  await page.getByRole("tab", { name: /^Functions/ }).click();
  await page
    .getByRole("button", { name: "EscalateTicket", exact: true })
    .click();
  await page.getByRole("button", { name: "Edit draft", exact: true }).click();
  await page.getByLabel("HTTP path").fill("/v2/test");
  await page
    .getByRole("button", { name: "Save endpoint", exact: true })
    .click();
  await page.getByRole("button", { name: "Undo edit" }).click();
  await expect(page.getByLabel("HTTP path")).toHaveValue("/v1/escalations");
  await page
    .getByRole("button", { name: "Edit Ticket read", exact: true })
    .click();
  const form = page
    .locator(".relation-form")
    .filter({ has: page.getByRole("button", { name: "Save", exact: true }) });
  await form.getByRole("combobox", { name: "Operation", exact: true }).click();
  await page
    .getByRole("option", { name: "Write records", exact: true })
    .click();
  await form.getByRole("button", { name: "Save", exact: true }).click();
  await page.getByRole("button", { name: "Source", exact: true }).click();
  await expect(page.getByLabel("Forge source")).toHaveValue(/Ticket write/);
});

test("keeps the mobile field editor contained with its actions reachable", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await login(page);
  await page.getByRole("button", { name: "Contact", exact: true }).click();
  await page.getByRole("button", { name: "Edit draft", exact: true }).click();
  await page
    .getByRole("button", { name: "Edit field email", exact: true })
    .click();
  const save = page.getByRole("button", { name: "Save field", exact: true });
  await save.scrollIntoViewIfNeeded();
  await expect(save).toBeInViewport();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
});
