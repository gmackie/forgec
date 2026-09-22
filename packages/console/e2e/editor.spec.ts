import { test, expect } from "@playwright/test";
async function login(page: import("@playwright/test").Page) {
  await page.goto("/");
  await page
    .getByLabel("Administrator token")
    .fill("local-console-test-token-1234567890");
  await page.getByRole("button", { name: "Connect to instance" }).click();
  await page.getByRole("button", { name: /^Developer/ }).click();
  await expect(page.getByRole("tab", { name: /Resources/ })).toBeVisible();
}
test("edits a resource explicitly, preserves source, undoes and downloads", async ({
  page,
}) => {
  await login(page);
  await page.getByRole("button", { name: "Contact", exact: true }).click();
  await page.getByRole("button", { name: "Edit draft", exact: true }).click();
  await page
    .getByRole("button", { name: "Edit field email", exact: true })
    .click();
  await page.getByLabel("Field name", { exact: true }).fill("contactEmail");
  await page.getByRole("button", { name: "Save field", exact: true }).click();
  await page.getByRole("button", { name: "Undo edit" }).click();
  await expect(
    page.getByRole("button", { name: "Edit field email", exact: true }),
  ).toBeEnabled();
  await page
    .getByRole("button", { name: "Access & purpose", exact: true })
    .click();
  await page
    .locator(".capability-card")
    .filter({
      has: page.getByRole("heading", { name: "Support", exact: true }),
    })
    .getByRole("button", { name: "Configure", exact: true })
    .click();
  await page.getByLabel("Allow update email in Support").uncheck();
  await page.getByRole("button", { name: "Source", exact: true }).click();
  await expect(page.getByLabel("Forge source")).toHaveText(/update \{  \}/);
  const downloaded = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download file" }).click();
  const download = await downloaded;
  expect(download.suggestedFilename()).toBe("contacts.forge");
  const { readFile } = await import("node:fs/promises");
  expect(await readFile((await download.path())!, "utf8")).toContain(
    "// A small Forge model",
  );
});
test("opens multi-file models without showing files and binds a shared purpose", async ({
  page,
}) => {
  await login(page);
  await page.locator('input[type="file"]').setInputFiles([
    {
      name: "contacts.forge",
      mimeType: "text/plain",
      buffer: Buffer.from(
        '// retain source\nresource Person @purposeScoped {\n id : id\n type : text = "personal"\n capability Basic {\n read { id type }\n }\n}\n',
      ),
    },
    {
      name: "purposes.forge",
      mimeType: "text/plain",
      buffer: Buffer.from(
        "purpose Service\ndataClass Email extends data.contact.email\n",
      ),
    },
  ]);
  await page.getByRole("button", { name: "Person", exact: true }).click();
  await page.getByRole("button", { name: "Edit draft", exact: true }).click();
  await page
    .getByRole("button", { name: "Access & purpose", exact: true })
    .click();
  await page.getByRole("combobox", { name: "Purpose to bind" }).click();
  await page.getByRole("option", { name: "Service", exact: true }).click();
  await page.getByRole("combobox", { name: "Capability to bind" }).click();
  await page.getByRole("option", { name: "Basic", exact: true }).click();
  await page.getByRole("button", { name: "Bind purpose", exact: true }).click();
  await page.getByRole("button", { name: "Source", exact: true }).click();
  await expect(page.getByLabel("Forge source")).toHaveText(
    /for Service \{ use Basic \}/,
  );
  await expect(page.getByLabel("Forge source")).toHaveText(
    /type : text = "personal"/,
  );
});
test("loads demo safely and keeps a default edit through undo, redo and reload", async ({
  page,
}) => {
  await login(page);
  await page.locator("summary").filter({ hasText: "Project tools" }).click();
  await page.getByRole("button", { name: "Load demo", exact: true }).click();
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await page.getByRole("button", { name: "Load demo", exact: true }).click();
  await page.getByRole("button", { name: "Replace draft with demo" }).click();
  await page.getByRole("button", { name: "ServicePlan", exact: true }).click();
  await page.getByRole("button", { name: "Edit draft", exact: true }).click();
  await page
    .getByRole("button", { name: "Edit field includedHours", exact: true })
    .click();
  await page.getByLabel("Default value", { exact: true }).fill("20");
  await page.getByRole("button", { name: "Save field", exact: true }).click();
  await page.getByRole("button", { name: "Undo edit" }).click();
  await expect(
    page.getByRole("row", { name: /^includedHours / }),
  ).toContainText("10");
  await page.getByRole("button", { name: "Redo edit" }).click();
  await expect(
    page.getByRole("row", { name: /^includedHours / }),
  ).toContainText("20");
  await page.reload();
  await page
    .getByLabel("Administrator token")
    .fill("local-console-test-token-1234567890");
  await page.getByRole("button", { name: "Connect to instance" }).click();
  await page.getByRole("button", { name: /^Developer/ }).click();
  await page.getByRole("button", { name: "ServicePlan", exact: true }).click();
  await page.getByRole("button", { name: "Source", exact: true }).click();
  await expect(page.getByLabel("Forge source")).toHaveText(
    /includedHours : HourCount = 20/,
  );
  await expect(page.getByLabel("Forge source")).toHaveAttribute("aria-readonly", "true");
  await page.setViewportSize({ width: 390, height: 844 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
});
