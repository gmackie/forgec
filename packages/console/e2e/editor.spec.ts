import { test, expect } from "@playwright/test";
async function login(page: import("@playwright/test").Page) {
  await page.goto("/");
  await page
    .getByLabel("Administrator token")
    .fill("local-console-test-token-1234567890");
  await page.getByRole("button", { name: "Connect to instance" }).click();
  await expect(page.getByRole("tab", { name: /Resources/ })).toBeVisible();
}
test("edits a resource explicitly, preserves source, undoes and downloads", async ({
  page,
}) => {
  await login(page);
  await page.getByRole("button", { name: "Contact", exact: true }).click();
  await page.getByRole("button", { name: "Edit draft", exact: true }).click();
  await expect(page.getByLabel("Field email name")).toBeEnabled();
  await page.getByLabel("Field email name").fill("contactEmail");
  await page.getByLabel("Field email name").press("Enter");
  await page.getByRole("button", { name: "Undo edit" }).click();
  await expect(page.getByLabel("Field email name")).toBeEnabled();
  await page.getByLabel("Allow update email in Support").uncheck();
  await page.getByRole("button", { name: "Source", exact: true }).click();
  await expect(page.getByLabel("Forge source")).toHaveValue(/update \{  \}/);
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
  await expect(page.getByLabel("Field type name")).toBeEnabled();
  await page.getByRole("button", { name: "Bind purpose", exact: true }).click();
  await page.getByRole("button", { name: "Source", exact: true }).click();
  await expect(page.getByLabel("Forge source")).toHaveValue(
    /for Service \{ use Basic \}/,
  );
  await expect(page.getByLabel("Forge source")).toHaveValue(
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
  await expect(
    page.getByLabel("Default value for includedHours"),
  ).toBeEnabled();
  await page.getByLabel("Default value for includedHours").fill("20");
  await page.getByLabel("Default value for includedHours").press("Enter");
  await page.getByRole("button", { name: "Undo edit" }).click();
  await expect(page.getByLabel("Default value for includedHours")).toHaveValue(
    "10",
  );
  await page.getByRole("button", { name: "Redo edit" }).click();
  await expect(page.getByLabel("Default value for includedHours")).toHaveValue(
    "20",
  );
  await page.reload();
  await page
    .getByLabel("Administrator token")
    .fill("local-console-test-token-1234567890");
  await page.getByRole("button", { name: "Connect to instance" }).click();
  await page.getByRole("button", { name: "ServicePlan", exact: true }).click();
  await page.getByRole("button", { name: "Source", exact: true }).click();
  await expect(page.getByLabel("Forge source")).toHaveValue(
    /includedHours : HourCount = 20/,
  );
  await expect(page.getByLabel("Forge source")).toHaveAttribute("readonly", "");
  await page.setViewportSize({ width: 390, height: 844 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
});
