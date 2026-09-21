import { test, expect } from "@playwright/test";
test("deploys a release and invokes a function with generated sample data", async ({
  page,
}) => {
  let deployed = false;
  const runs: any[] = [];
  await page.route("**/api/deployments/targets", (r) =>
    r.fulfill({
      json: {
        targets: [
          {
            id: "demo",
            name: "Support staging",
            kind: "docker",
            runtimeId: "demo",
          },
        ],
      },
    }),
  );
  await page.route("**/api/deployments/targets/demo", (r) =>
    r.fulfill({
      json: {
        releases: [
          {
            id: "r1",
            name: "1.0.0",
            artifact: "sha256:abc",
            createdAt: "2026-09-21T00:00:00Z",
          },
        ],
        deployments: runs,
        activeDeployment: deployed ? "run-1" : null,
      },
    }),
  );
  await page.route("**/api/deployments/targets/demo/actions", (r) => {
    expect(r.request().postDataJSON()).toMatchObject({
      action: "deploy",
      release: "r1",
      expectedDeployment: null,
    });
    deployed = true;
    runs.push({
      id: "run-1",
      release: "r1",
      action: "deploy",
      status: "healthy",
      createdAt: "2026-09-21T00:00:00Z",
      logs: ["Runtime ready"],
    });
    return r.fulfill({ status: 202, json: runs[0] });
  });
  await page.route("**/api/runtime/targets", (r) =>
    r.fulfill({
      json: {
        targets: [
          {
            id: "demo",
            name: "Support staging",
            endpoint: "https://demo.example",
          },
        ],
      },
    }),
  );
  await page.route("**/api/runtime/targets/demo/catalog", (r) =>
    r.fulfill({
      json: {
        buildHash: "build-1",
        observedAt: "2026-09-21T00:00:00Z",
        operations: [
          {
            id: "Quote",
            summary: "Calculate quote",
            method: "POST",
            path: "/quote",
            kind: "function",
            sample: { hours: 2 },
            schema: { type: "object" },
          },
        ],
      },
    }),
  );
  await page.route("**/api/runtime/targets/demo/invoke", (r) => {
    expect(r.request().postDataJSON()).toMatchObject({
      operationId: "Quote",
      input: { hours: 2 },
      buildHash: "build-1",
    });
    return r.fulfill({
      json: {
        status: 200,
        durationMs: 12,
        at: "2026-09-21T00:00:00Z",
        outcome: { kind: "ok", value: { total: 200 } },
      },
    });
  });
  await page.goto("/");
  await page
    .getByLabel("Administrator token")
    .fill("local-console-test-token-1234567890");
  await page.getByRole("button", { name: "Connect to instance" }).click();
  await page.getByRole("button", { name: "Deployments", exact: true }).click();
  await page
    .getByRole("button", { name: "Support staging", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Deploy release", exact: true })
    .click();
  await expect(page.getByRole("dialog")).toContainText("1.0.0");
  await page
    .getByRole("button", { name: "Start deployment", exact: true })
    .click();
  await expect(
    page.getByText("healthy", { exact: true }).first(),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Test functions", exact: true })
    .click();
  await expect(page.getByLabel("Sample input")).toHaveValue(/"hours": 2/);
  await page
    .getByRole("button", { name: "Invoke function", exact: true })
    .click();
  await expect(page.getByLabel("Invocation response")).toContainText("200");
  await expect(page.getByLabel("Invocation response")).toContainText("total");
  await page.setViewportSize({ width: 390, height: 844 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
});
