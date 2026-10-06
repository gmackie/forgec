import { test, expect } from "@playwright/test";

// No route mocks: the local test server proxies to stand-ins for ForgeGraph and the notes app
// (scripts/local-test-server.mjs), and the notes app only answers with the injected credential.
test("browses an app's published contract and calls it through the console", async ({ page }) => {
  const browserCalls: string[] = [];
  page.on("request", (r) => browserCalls.push(r.url()));
  await page.goto("/");
  await page.getByLabel("Administrator token").fill("local-console-test-token-1234567890");
  await page.getByRole("button", { name: "Connect to instance" }).click();
  await page.getByRole("button", { name: "Playground", exact: true }).click();
  await page.getByRole("tab", { name: "Integrations" }).click();

  await expect(page.getByText("3 operations")).toBeVisible();
  await page.getByRole("button", { name: /notes\.get.*GET \/notes\/\{id\}/ }).click();
  await page.getByLabel("Path id").fill("n 1");
  await page.getByLabel("Query view").fill("summary");
  await page.getByRole("button", { name: "Send request" }).click();
  const response = page.getByRole("region", { name: "Response" });
  await expect(response).toContainText("200");
  await expect(response).toContainText('"title": "Note n 1"');
  await expect(response).toContainText('"view": "summary"');
  await expect(response).toContainText("stub-1");

  // A write on a read-only integration is blocked in the UI.
  await page.getByRole("button", { name: /notes\.create.*POST/ }).click();
  await expect(page.getByRole("note")).toContainText("Writes are not enabled");
  await expect(page.getByRole("button", { name: "Send request" })).toBeDisabled();

  // The browser only ever talked to the console.
  expect(browserCalls.filter((u) => u.includes(":8789"))).toEqual([]);
});

test("hands one operation to the graph importer", async ({ page }) => {
  await page.goto("/");
  await page.getByLabel("Administrator token").fill("local-console-test-token-1234567890");
  await page.getByRole("button", { name: "Connect to instance" }).click();
  await page.getByRole("button", { name: "Playground", exact: true }).click();
  await page.getByRole("tab", { name: "Integrations" }).click();
  await page.getByRole("button", { name: /notes\.get.*GET/ }).click();
  await page.getByRole("button", { name: "Use in graph" }).click();
  await expect(page.getByRole("tab", { name: "Graph" })).toHaveAttribute("aria-selected", "true");
  await expect(page.getByLabel("OpenAPI package")).toHaveValue("@external/notes");
  await expect(page.getByLabel("OpenAPI document")).toHaveValue(/"\/notes\/\{id\}"/);
});
