import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import {
  Engine,
  MemoryStorage,
  Model,
  testLayer,
  type AppBundle,
} from "../../runtime/src/index.js";
import { createHttpHandler } from "../../runtime/src/http.js";
import { RuntimeConnection } from "../src/runtime-control.js";
const bundle = JSON.parse(
  readFileSync(
    new URL("../../../conformance/fixtures/acme.app.json", import.meta.url),
    "utf8",
  ),
) as AppBundle;
it("loads the deployed descriptor and edits records through HTTP review and commit with build and version guards", async () => {
  const model = new Model(bundle);
  let handler = createHttpHandler(
    model,
    new Engine(model, testLayer(new MemoryStorage())),
    {
      auth: {
        authenticate: async () => ({ tenant: "acme", actor: "operator" }),
      },
    },
  );
  const requests: Request[] = [];
  const runtime = new RuntimeConnection(
    {
      id: "test",
      name: "Test",
      endpoint: "https://runtime.test",
      token: "server-only",
    },
    async (url, init) => {
      const req = new Request(url, init);
      requests.push(req.clone());
      return handler(req);
    },
  );
  const workspace = await runtime.workspace();
  expect(workspace.descriptor.version).toBe("ui/1");
  expect(workspace.operations.some((o) => o.kind.startsWith("admin."))).toBe(
    false,
  );
  const call = (operationId: string, input: unknown) =>
    runtime.record({ operationId, input, buildHash: workspace.buildHash });
  const proposal = await call("@acme/commerce/_/changesets.propose", {
    mode: "resumable",
    operations: [
      {
        op: "@acme/commerce/_/Customer.create",
        input: { code: "BIZ", name: "Business user" },
      },
    ],
  });
  expect(proposal.ok).toBe(true);
  const id = proposal.value.id;
  const preview = await call("@acme/commerce/_/changesets.preview", { id });
  expect(preview.ok).toBe(true);
  expect(preview.value.items[0].status).not.toBe("error");
  expect(
    (
      await call("@acme/commerce/_/changesets.approve", {
        id,
        contentHash: preview.value.contentHash,
      })
    ).ok,
  ).toBe(true);
  expect(
    (await call("@acme/commerce/_/changesets.commit", { id })).value.status,
  ).toBe("committed");
  const resource = workspace.descriptor.resources.find(
    (r) => r.name === "Customer",
  )!;
  const list = resource.lists.find((l) => !l.params.length)!;
  const rows = await call(list.op, { params: {}, limit: 100 });
  expect(rows.value.items).toHaveLength(1);
  const row = rows.value.items[0];
  const stale = await call(`${resource.id}.update`, {
    id: row.id,
    expectedVersion: 99,
    patch: { name: "Wrong" },
  });
  expect(stale).toMatchObject({ ok: false, status: 412 });
  expect(
    (
      await call(`${resource.id}.update`, {
        id: row.id,
        expectedVersion: row.version,
        patch: { name: "Updated" },
      })
    ).value.name,
  ).toBe("Updated");
  await expect(call("@acme/commerce/_/admin.export", {})).rejects.toThrow(
    /not available/,
  );
  const before = requests.length;
  handler = createHttpHandler(
    new Model({ ...bundle, buildHash: "new-build" }),
    new Engine(model, testLayer(new MemoryStorage())),
    {
      auth: {
        authenticate: async () => ({ tenant: "acme", actor: "operator" }),
      },
    },
  );
  await expect(
    call(`${resource.id}.update`, {
      id: row.id,
      expectedVersion: 2,
      patch: { name: "Wrong" },
    }),
  ).rejects.toThrow(/changed/);
  expect(requests.slice(before).every((r) => r.method === "GET")).toBe(true);
});
