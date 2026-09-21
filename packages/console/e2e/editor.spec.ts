import { test, expect } from "@playwright/test";
test("edits Forge visually, preserves source, undoes edits and exports a real file", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("/");
  await page
    .getByLabel("Administrator token")
    .fill("local-console-test-token-1234567890");
  await page.getByRole("button", { name: "Connect to instance" }).click();
  await expect(
    page.getByRole("heading", { name: "A language you can shape." }),
  ).toBeVisible();
  await expect(page.getByLabel("Field email name")).toBeEnabled();
  await page.getByRole("button", { name: "Split", exact: true }).click();
  await page.getByLabel("Field email name").fill("contactEmail");
  await page.getByLabel("Field email name").press("Enter");
  await expect(page.getByLabel("Forge source")).toHaveValue(
    /contactEmail : email @data\(ContactEmail\)/,
  );
  await expect(page.getByLabel("Forge source")).toHaveValue(
    /\/\/ A small Forge model/,
  );
  await page.getByRole("button", { name: "Undo edit" }).click();
  await expect(page.getByLabel("Forge source")).toHaveValue(
    /\n  email : email/,
  );
  await expect(page.getByLabel("Allow update email in Support")).toBeEnabled();
  await page.getByLabel("Allow update email in Support").uncheck();
  await expect(page.getByLabel("Forge source")).toHaveValue(/update \{  \}/);
  await expect(page.getByLabel("Data class of email")).toBeEnabled();
  await page.getByLabel("Data class of email").click();
  await page
    .getByRole("option", { name: "data.contact.email", exact: true })
    .click();
  await expect(page.getByLabel("Forge source")).toHaveValue(
    /email : email @data\(data.contact.email\)/,
  );
  await page.getByLabel("New declaration name").fill("Delivery");
  await page
    .getByRole("button", { name: "Add declaration", exact: true })
    .click();
  await expect(page.getByLabel("Forge source")).toHaveValue(
    /export resource Delivery/,
  );
  await page
    .getByRole("button", { name: "Relationships", exact: true })
    .click();
  await expect(
    page.getByRole("img", { name: "Forge declaration relationships" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Edit Contact", exact: true }).click();
  await expect(page.getByLabel("Field contactEmail name")).toHaveCount(0);
  const downloadPromise = page.waitForEvent("download");
  await page
    .getByRole("button", { name: "Download file", exact: true })
    .click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe("contacts.forge");
  await page.setViewportSize({ width: 390, height: 844 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: "/tmp/forge-editor-mobile.png",
    fullPage: true,
  });
  await page.setViewportSize({ width: 1550, height: 1000 });
  await page.screenshot({
    path: "/tmp/forge-editor-document.png",
    fullPage: true,
  });
  expect(errors).toEqual([]);
});
test('opens multiple source files and binds a purpose declared in another file', async ({page}) => {
  await page.goto('/');
  await page.getByLabel('Administrator token').fill('local-console-test-token-1234567890');
  await page.getByRole('button',{name:'Connect to instance'}).click();
  await page.getByRole('heading',{name:'A language you can shape.'}).waitFor();
  const contacts='// retain source\nresource Person @purposeScoped {\n id : id\n type : text = "personal"\n capability Basic {\n read { id type }\n }\n}\n';
  await page.locator('input[type="file"][accept=".forge,.json"]').setInputFiles([
    {name:'contacts.forge',mimeType:'text/plain',buffer:Buffer.from(contacts)},
    {name:'purposes.forge',mimeType:'text/plain',buffer:Buffer.from('purpose Service\ndataClass Email extends data.contact.email\n')},
  ]);
  await expect(page.getByLabel('Field type name')).toBeEnabled();
  await page.getByRole('button',{name:'Bind purpose',exact:true}).click();
  await page.getByRole('button',{name:'Source',exact:true}).click();
  await expect(page.getByLabel('Forge source')).toHaveValue(/for Service \{ use Basic \}/);
  await expect(page.getByLabel('Forge source')).toHaveValue(/type : text = "personal"/);
  const downloadPromise=page.waitForEvent('download');
  await page.getByRole('button',{name:'Download file',exact:true}).click();
  const downloaded=await downloadPromise;
  const {readFile}=await import('node:fs/promises');
  const saved=await readFile((await downloaded.path())!,'utf8');
  expect(saved).toContain('// retain source');
  expect(saved).toContain('for Service { use Basic }');
});

test('loads the service desk safely, follows cross-file relationships, and retains edits', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.goto('/');
  await page.getByLabel('Administrator token').fill('local-console-test-token-1234567890');
  await page.getByRole('button', { name: 'Connect to instance' }).click();
  await expect(page.getByLabel('Field email name')).toBeEnabled();
  await page.getByLabel('Package name').fill('@local/my-draft');
  await page.getByRole('button', { name: 'Load demo', exact: true }).click();
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(page.getByLabel('Package name')).toHaveValue('@local/my-draft');
  await page.getByRole('button', { name: 'Load demo', exact: true }).click();
  await page.getByRole('button', { name: 'Replace draft with demo' }).click();
  await expect(page.getByLabel('Package name')).toHaveValue('@demo/service-desk');
  await page.getByRole('button', { name: 'Undo edit' }).click();
  await expect(page.getByLabel('Package name')).toHaveValue('@local/my-draft');
  await page.getByRole('button', { name: 'Redo edit' }).click();
  for (const file of ['contacts', 'tickets', 'plans', 'governance', 'types', 'events', 'operations']) {
    await page.getByRole('navigation', { name: 'Forge files' }).getByRole('button', { name: `${file}.forge`, exact: true }).click();
    await expect(page.getByRole('status').filter({ hasText: '0 errors · 0 warnings' })).toBeVisible();
    await page.screenshot({ path: `/tmp/forge-demo-${file}.png`, fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), file).toBe(true);
    await page.setViewportSize({ width: 1440, height: 1000 });
  }
  await page.getByRole('navigation', { name: 'Forge files' }).getByRole('button', { name: 'plans.forge', exact: true }).click();
  await expect(page.getByLabel('Default value for includedHours')).toBeEnabled();
  await page.getByLabel('Default value for includedHours').fill('20');
  await page.getByLabel('Default value for includedHours').press('Enter');
  await page.getByRole('button', { name: 'Undo edit' }).click();
  await expect(page.getByLabel('Default value for includedHours')).toHaveValue('10');
  await page.getByRole('button', { name: 'Redo edit' }).click();
  await expect(page.getByLabel('Default value for includedHours')).toHaveValue('20');
  await expect(page.getByLabel('Calculation for availableHours')).toHaveValue('includedHours - usedHours');
  await page.getByRole('button', { name: 'Source', exact: true }).click();
  await expect(page.getByLabel('Forge source')).toHaveValue(/includedHours : HourCount = 20/);
  await page.getByRole('button', { name: 'Document', exact: true }).click();
  await page.getByRole('navigation', { name: 'Forge files' }).getByRole('button', { name: 'tickets.forge', exact: true }).click();
  await expect(page.getByLabel('Field title name')).toBeEnabled();
  await page.getByRole('button', { name: 'Relationships', exact: true }).click();
  await page.getByRole('button', { name: 'Open Contact in contacts.forge', exact: true }).click();
  await expect(page.getByLabel('Field email name')).toBeEnabled();
  await page.getByRole('navigation', { name: 'Declarations in this file' }).getByRole('button', { name: 'Contact', exact: true }).click();
  await page.getByLabel('Field email name').fill('contactEmail');
  await page.getByLabel('Field email name').press('Enter');
  await expect(page.getByLabel('Field contactEmail name')).toBeEnabled();
  await page.reload();
  await page.getByLabel('Administrator token').fill('local-console-test-token-1234567890');
  await page.getByRole('button', { name: 'Connect to instance' }).click();
  await expect(page.getByLabel('Field contactEmail name')).toBeEnabled();
  expect(errors).toEqual([]);
});
