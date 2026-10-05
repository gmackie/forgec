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
test("uses Cloudflare endpoint controls and exposes the deployed Worker URL", async ({
  page,
}) => {
  await page.route("**/api/deployments/targets", (r) =>
    r.fulfill({
      json: {
        targets: [
          {
            id: "workers",
            name: "Workers playground",
            kind: "cloudflare",
            runtimeId: "workers",
          },
        ],
      },
    }),
  );
  await page.route("**/api/deployments/targets/workers", (r) =>
    r.fulfill({
      json: {
        releases: [
          { id: "v1", name: "1.0.1", artifact: "sha256:abc", createdAt: "now" },
        ],
        activeDeployment: "run-1",
        deployments: [
          {
            id: "run-1",
            release: "v1",
            action: "deploy",
            status: "healthy",
            createdAt: "2026-09-21T00:00:00Z",
            logs: ["Worker healthy"],
            runtimeUrl: "https://demo.example.workers.dev",
          },
        ],
      },
    }),
  );
  await page.goto("/");
  await page
    .getByLabel("Administrator token")
    .fill("local-console-test-token-1234567890");
  await page.getByRole("button", { name: "Connect to instance" }).click();
  await page.getByRole("button", { name: "Deployments", exact: true }).click();
  await page
    .getByRole("button", { name: "Workers playground", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Pause endpoint", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Resume endpoint", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: "Worker endpoint" }),
  ).toHaveAttribute("href", "https://demo.example.workers.dev");
});

test('opens the linked deployment and playground from an app environment',async({page})=>{
 await page.route('**/api/state',r=>r.fulfill({json:{revision:1,instance:{name:'Test',authority:'test.example',runtime:'Node',registry:null},audit:[],apps:[{id:'support',name:'Support app',description:'',archived:false,updatedAt:'2026-09-27T00:00:00Z',environments:[{id:'prod',name:'Production',target:'cloudflare',endpoint:'https://support.example',packageDigest:'',config:{REGION:'west'},secretRefs:{}}]}]}}));
 await page.route('**/api/deployments/targets',r=>r.fulfill({json:{targets:[{id:'unrelated',name:'Other deployment',kind:'docker'},{id:'workers',name:'Support production',kind:'cloudflare',appId:'support',environmentId:'prod',runtimeId:'support-runtime'}]}}));
 await page.route('**/api/deployments/targets/workers',r=>r.fulfill({json:{releases:[{id:'v1',name:'Support 1.0',artifact:'sha256:abc',createdAt:'now'}],activeDeployment:'run',deployments:[{id:'run',release:'v1',status:'healthy',action:'deploy',config:{REGION:'east'},createdAt:'2026-09-27T00:00:00Z',logs:['Worker ready']}]}}));
 await page.route('**/api/runtime/targets',r=>r.fulfill({json:{targets:[{id:'unrelated',name:'Other runtime',endpoint:'https://other.example'},{id:'support-runtime',name:'Support production',endpoint:'https://support.example'}]}}));
 await page.route('**/api/runtime/targets/support-runtime/catalog',r=>r.fulfill({json:{buildHash:'build',observedAt:'2026-09-27T00:00:00Z',operations:[{id:'Estimate',summary:'Estimate support',method:'POST',path:'/estimate',kind:'function',sample:{hours:1},schema:{}}]}}));
 await page.goto('/');await page.getByRole('button',{name:'Apps',exact:true}).click();await page.getByRole('button',{name:'Support app',exact:true}).click();
 await expect(page.getByText('1 configuration value differs')).toBeVisible();
 await page.getByRole('button',{name:'Manage deployment',exact:true}).click();await expect(page.getByText('Worker ready')).toBeVisible();
 await page.getByRole('button',{name:'Test functions',exact:true}).click();await expect(page.getByLabel('Sample input')).toHaveValue(/hours/);
 await page.setViewportSize({width:390,height:844});await page.getByRole('button',{name:'Apps',exact:true}).click();await page.getByRole('button',{name:'Support app',exact:true}).click();
 await expect(page.getByRole('button',{name:'Manage deployment'})).toBeVisible();expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
});
