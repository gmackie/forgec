import type { Page } from "@playwright/test";

/** Opens the editor's tools menu. Clicking its summary toggles it, so an already-open menu is left open. */
export async function openProjectTools(page: Page) {
  const tools = page.locator("details").filter({
    has: page.locator("summary", { hasText: /Project tools|Draft options/ }),
  });
  if (!(await tools.evaluate((d) => (d as HTMLDetailsElement).open)))
    await tools.locator("summary").click();
}

export async function loadServiceDesk(page: Page) {
  await openProjectTools(page);
  await page.getByRole("button", { name: "Load service desk", exact: true }).click();
  await page.getByRole("button", { name: "Replace draft", exact: true }).click();
}
