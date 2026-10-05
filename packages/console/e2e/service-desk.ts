import type { Page } from "@playwright/test";

export async function loadServiceDesk(page: Page) {
  await page.locator("summary").filter({ hasText: /Project tools|Draft options/ }).click();
  await page.getByRole("button", { name: "Load service desk", exact: true }).click();
  await page.getByRole("button", { name: "Replace draft", exact: true }).click();
}
