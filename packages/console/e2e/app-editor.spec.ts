import { test, expect } from "@playwright/test";
test("browses the whole app by declaration kind and only edits explicitly", async ({
  page,
}) => {
  await page.goto("/");
  await page
    .getByLabel("Administrator token")
    .fill("local-console-test-token-1234567890");
  await page.getByRole("button", { name: "Connect to instance" }).click();
  await expect(
    page.getByRole("tab", { name: "Resources", exact: false }),
  ).toBeVisible();
  await expect(
    page.getByRole("navigation", { name: "Forge files" }),
  ).toHaveCount(0);
  await page.getByRole("button", { name: "ServicePlan", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "ServicePlan", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("includedHours - usedHours", { exact: true }),
  ).toBeVisible();
  await expect(page.getByLabel("Default value for includedHours")).toHaveCount(
    0,
  );
  await page.getByRole("tab", { name: "Functions", exact: false }).click();
  await page
    .getByRole("button", { name: "EscalateTicket", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "EscalateTicket", exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("tab", { name: /^Capabilities/ })).toHaveCount(0);
  await page.getByRole("tab", { name: /^Resources/ }).click();
  await page.getByRole("button", { name: "Contact", exact: true }).click();
  await page
    .getByRole("button", { name: "Access & purpose", exact: true })
    .click();
  await page.getByRole("button", { name: "Edit draft", exact: true }).click();
  await page
    .locator(".capability-card")
    .filter({
      has: page.getByRole("heading", { name: "Support", exact: true }),
    })
    .getByRole("button", { name: "Configure", exact: true })
    .click();
  await expect(page.getByLabel("Allow update email in Support")).toBeEnabled();
  await page.getByRole("button", { name: "Read view", exact: true }).click();
  await expect(page.getByLabel("Allow update email in Support")).toHaveCount(0);
  await page.setViewportSize({ width: 390, height: 844 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
});

test("reviews a Git draft, retains it on conflict, then records a successful commit", async ({
  page,
}) => {
  const snapshot = {
    id: "desk",
    name: "Desk",
    repository: "owner/desk",
    branch: "studio",
    root: "src",
    revision: "a".repeat(40),
    files: [
      {
        path: "model.forge",
        text: "resource Plan {\n id : id\n hours : integer = 10\n}\n",
      },
    ],
  };
  let conflict = true;
  await page.route("**/api/git/projects", (r) =>
    r.fulfill({ json: { projects: [snapshot] } }),
  );
  await page.route("**/api/git/projects/desk", (r) =>
    r.fulfill({ json: snapshot }),
  );
  await page.route("**/api/git/projects/desk/commits", (r) => {
    const data = r.request().postDataJSON();
    expect(data.base).toBe(snapshot.revision);
    expect(data.message).toBe("Increase plan allowance");
    expect(data.files[0].text).toContain("hours : integer = 20");
    return r.fulfill(
      conflict
        ? {
            status: 409,
            json: { error: "Branch changed. Your draft is preserved." },
          }
        : {
            status: 201,
            json: {
              revision: "b".repeat(40),
              url: "https://github.com/owner/desk/commit/b",
            },
          },
    );
  });
  await page.goto("/");
  await page
    .getByLabel("Administrator token")
    .fill("local-console-test-token-1234567890");
  await page.getByRole("button", { name: "Connect to instance" }).click();
  await page.getByRole("button", { name: "Connect Git", exact: true }).click();
  await page.getByRole("button", { name: "Load repository" }).click();
  await expect(
    page.getByRole("heading", { name: "Plan", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Edit draft", exact: true }).click();
  await page
    .getByRole("button", { name: "Edit field hours", exact: true })
    .click();
  await page.getByLabel("Default value", { exact: true }).fill("20");
  await page.getByRole("button", { name: "Save field", exact: true }).click();
  await page.getByRole("button", { name: "Review changes (1)" }).click();
  await expect(page.getByRole("dialog")).toContainText("hours : integer = 10");
  await expect(page.getByRole("dialog")).toContainText("hours : integer = 20");
  await page.getByLabel("Commit message").fill("Increase plan allowance");
  await page
    .getByRole("button", { name: "Commit changes", exact: true })
    .click();
  await expect(page.getByRole("dialog")).toContainText(
    "Branch changed. Your draft is preserved.",
  );
  conflict = false;
  await page
    .getByRole("button", { name: "Commit changes", exact: true })
    .click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(
    page.getByText("Committed bbbbbbbb to studio.", { exact: true }),
  ).toBeVisible();
  await expect(page.getByLabel("Default value for hours")).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Review changes (0)" }),
  ).toBeDisabled();
});

test("types a complete source change without losing focus and shows immutable fields in read view", async ({
  page,
}) => {
  await page.goto("/");
  await page
    .getByLabel("Administrator token")
    .fill("local-console-test-token-1234567890");
  await page.getByRole("button", { name: "Connect to instance" }).click();
  await page.getByRole("button", { name: "Organization", exact: true }).click();
  await expect(
    page.getByRole("row").filter({ hasText: "OrganizationCode" }),
  ).toContainText("Immutable");
  await page.getByRole("button", { name: "Edit draft", exact: true }).click();
  await page.getByRole("button", { name: "Source", exact: true }).click();
  const source = page.getByLabel("Forge source");
  await source.focus();
  await source.press("ControlOrMeta+Home");
  await source.pressSequentially("// continuous typing\n", { delay: 20 });
  await expect(source).toBeFocused();
  await expect(source).toHaveValue(/continuous typing/);
  await page.getByRole("button", { name: "Document", exact: true }).click();
  await page.getByRole("button", { name: "Source", exact: true }).click();
  await expect(source).toHaveValue(/continuous typing/);
});
