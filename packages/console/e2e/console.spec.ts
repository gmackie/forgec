import { test, expect } from "@playwright/test";
import { resolve } from "node:path";
test("operator manages apps, config, and OCI packages without off-origin browser traffic", async ({
  page,
  request,
}) => {
  const offOrigin: string[] = [],
    errors: string[] = [];
  page.on("request", (req) => {
    if (
      !req
        .url()
        .startsWith(process.env.CONSOLE_TEST_URL || "http://127.0.0.1:8787")
    )
      offOrigin.push(req.url());
  });
  page.on("pageerror", (error) => errors.push(error.message));
  const root = await request.get("/");
  expect(root.status()).toBe(200);
  await page.goto("/");
  await page
    .getByLabel("Administrator token")
    .fill("local-console-test-token-1234567890");
  await page.getByRole("button", { name: "Connect to instance" }).click();
  await page.getByRole("button", { name: "Register app", exact: true }).click();
  await page.getByLabel("App name").fill(`Commerce ${Date.now()}`);
  await page.getByLabel("Description").fill("Orders, payments and fulfillment");
  await page.getByRole("button", { name: "Save app" }).click();
  await page
    .getByRole("button", { name: /^Commerce / })
    .last()
    .click();
  await page
    .getByRole("button", { name: "Add environment", exact: true })
    .click();
  await page.getByLabel("Environment name").fill("production");
  await page
    .getByLabel("Endpoint", { exact: true })
    .fill("https://commerce.example.com");
  await page.getByLabel("Configuration (JSON)").fill('{"REGION":"us-east"}');
  await page
    .getByLabel("Secret references (JSON)")
    .fill('{"PAYMENTS":"worker:PAYMENTS"}');
  await page.getByRole("button", { name: "Save environment" }).click();
  await expect(page.getByText("Deployment unverified")).toBeVisible();
  await page.getByRole("button", { name: "Configure", exact: true }).click();
  await expect(page.getByLabel("Configuration (JSON)")).toHaveValue(/us-east/);
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await page.getByRole("button", { name: "Registry", exact: true }).click();
  await page
    .getByRole("button", { name: "Publish package", exact: true })
    .click();
  await page.getByLabel("Package name", { exact: true }).fill("@acme/commerce-next");
  await page.getByLabel("Version", { exact: true }).fill(`1.0.${Date.now()}`);
  await page.getByLabel("Owner", { exact: true }).fill("Commerce team");
  await page.getByLabel("Source revision").fill("e2e-verification");
  await page
    .getByLabel("Compiled bundle")
    .setInputFiles(resolve("../../conformance/fixtures/acme-next.app.json"));
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Publish package", exact: true })
    .click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page
    .getByRole("button", { name: "@acme/commerce-next", exact: true })
    .first()
    .click();
  await expect(
    page.getByText("OCI manifest digest", { exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("heading", { name: "Data classification" })).toBeVisible();
  await expect(page.getByText("data-taxonomy/1", { exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Purposes and capability surfaces" })).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.screenshot({
    path: "/tmp/forge-console-registry.png",
    fullPage: true,
  });
  await page.getByRole("button", { name: "Apps", exact: true }).click();
  await page.screenshot({
    path: "/tmp/forge-console-apps.png",
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({
    path: "/tmp/forge-console-mobile.png",
    fullPage: true,
  });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  expect(errors).toEqual([]);
  expect(offOrigin).toEqual([]);
});
