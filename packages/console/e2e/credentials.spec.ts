import { test, expect } from "@playwright/test";

/**
 * Issuing a registry credential, through the real server.
 *
 * The credential API, the credential store and the token exchange each had their own passing
 * suite while this panel answered 503 on every request, because `src/node.ts` — the host this
 * suite actually runs — never passed a credential store to `createApi`. A stubbed-fetch unit
 * test could not see that: it asserted a POST was issued, which is true of a 503 as well.
 *
 * So this drives the real UI against the real host and asserts on the one thing only a working
 * chain produces: the `docker login` line, which exists only if a secret came back.
 */
test("an operator issues a registry credential and is shown the secret once", async ({
  page,
}) => {
  await page.goto("/");
  await page
    .getByLabel("Administrator token")
    .fill("local-console-test-token-1234567890");
  await page.getByRole("button", { name: "Connect to instance" }).click();

  await page.getByRole("button", { name: "Settings", exact: true }).click();
  const panel = page
    .locator("section.detail-panel")
    .filter({ hasText: "Registry credentials" });
  await expect(
    page.getByRole("heading", { name: "Registry credentials" }),
  ).toBeVisible();

  // A 503 renders the error banner instead, so this assertion is the real gate.
  await expect(page.getByText("This instance does not issue registry credentials.")).toHaveCount(0);

  const label = `ci-${Date.now()}`;
  await page.getByLabel("Label").fill(label);
  await page.getByRole("button", { name: "Issue credential" }).click();

  const secret = page.getByText(/^docker login /);
  await expect(secret).toBeVisible();
  // The identifier is the docker username, so it has to be in the command the operator copies.
  await expect(secret).toContainText(/\bfgc_[0-9a-f]{16}\b/);

  await page.getByRole("button", { name: "I have copied it" }).click();
  await expect(secret).toHaveCount(0);

  // It is listed afterwards, without the secret, so it can be revoked knowingly.
  await expect(panel.getByText(label)).toBeVisible();
  await expect(panel.getByText(/^docker login /)).toHaveCount(0);
});
