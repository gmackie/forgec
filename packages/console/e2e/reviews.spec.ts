import { test, expect } from "@playwright/test";
test("submits a Forge review, discusses it, and approves pinned source", async ({
  page,
}) => {
  const snapshot = {
    id: "desk",
    name: "Desk",
    repository: "owner/desk",
    branch: "studio",
    root: "src",
    revision: "b".repeat(40),
    files: [
      {
        path: "model.forge",
        text: "resource Plan {\n id : id\n hours : integer = 20\n}\n",
      },
    ],
  };
  let review: any,
    comments: any[] = [];
  await page.route("**/api/git/projects**", async (route) => {
    const req = route.request(),
      url = new URL(req.url()),
      path = url.pathname;
    let json: any;
    if (path === "/api/git/projects") json = { projects: [snapshot] };
    else if (path.endsWith("/branches"))
      json = {
        items: [
          { name: "studio", revision: snapshot.revision, protected: false },
        ],
        hasMore: false,
      };
    else if (path.endsWith("/reviews")) {
      if (req.method() === "POST") {
        const data = req.postDataJSON();
        expect(data.headRevision).toBe(snapshot.revision);
        review = {
          ...data,
          id: "r1",
          version: 1,
          status: "Open",
          baseRevision: "a".repeat(40),
        };
        json = review;
      } else json = { items: review ? [review] : [] };
    } else if (path.endsWith("/decisions")) {
      expect(req.postDataJSON()).toEqual({
        action: "approve",
        expectedVersion: 1,
      });
      review = { ...review, version: 2, status: "Approved" };
      json = review;
    } else if (path.endsWith("/comments")) {
      comments.push({
        id: "c1",
        body: req.postDataJSON().body,
        author: "console-administrator",
      });
      json = comments[0];
    } else if (path.endsWith("/reviews/r1"))
      json = {
        review,
        outdated: false,
        files: [
          {
            path: "model.forge",
            before: snapshot.files[0]!.text.replace("20", "10"),
            after: snapshot.files[0]!.text,
          },
        ],
        comments: { items: comments },
      };
    else json = snapshot;
    await route.fulfill({ json });
  });
  await page.goto("/");
  await page
    .getByLabel("Administrator token")
    .fill("local-console-test-token-1234567890");
  await page.getByRole("button", { name: "Connect to instance" }).click();
  await page.getByRole("button", { name: /^Developer/ }).click();
  await page.getByRole("button", { name: "Connect Git", exact: true }).click();
  await page.getByRole("button", { name: "Load repository" }).click();
  await page
    .getByText("Repository, branches & reviews", { exact: true })
    .click();
  const workspace = page.getByRole("region", { name: "Repository workspace" });
  await workspace.getByRole("button", { name: "Reviews", exact: true }).click();
  await workspace.getByLabel("Review title").fill("Increase allowance");
  await workspace.getByLabel("Target branch").fill("main");
  await workspace
    .getByRole("button", { name: "Submit committed changes for review" })
    .click();
  const detail = page.getByRole("region", { name: "Change review" });
  await expect(detail).toContainText("hours : integer = 10");
  await expect(detail).toContainText("hours : integer = 20");
  await expect(detail.locator(".cm-content span").first()).toBeVisible();
  await detail.getByLabel("Review comment").fill("Verified the allowance");
  await detail
    .getByRole("button", { name: "Add comment", exact: true })
    .click();
  await expect(detail).toContainText("Verified the allowance");
  await detail.getByRole("button", { name: "Approve", exact: true }).click();
  await expect(detail).toContainText("Approved");
  await expect(
    detail.getByRole("button", { name: "Approve", exact: true }),
  ).toBeDisabled();
  await page.screenshot({
    path: "/tmp/forge-studio-review-desktop.png",
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect
    .poll(() =>
      page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    )
    .toBe(true);
  await page.screenshot({
    path: "/tmp/forge-studio-review-mobile.png",
    fullPage: true,
  });
});
