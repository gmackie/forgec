import { test } from "node:test";
import assert from "node:assert/strict";
import worker from "../../conformance/artifacts/management-worker.mjs";
const env = () => ({
  QUALIFICATION_SECRET: "fixture-secret",
  REPO_NAME: "forge-binding-fixture",
  EXPIRES_AT: String(Date.now() + 60000),
  ARTIFACTS: {
    create: async (name) => ({
      id: "repo-fixture",
      name,
      remote: "https://fixture.invalid/repo.git",
      token: "fixture-git-token",
    }),
    delete: async () => {},
    get: async () => ({
      info: async () => ({ id: "repo-fixture" }),
      [Symbol.dispose]: () => {},
    }),
  },
});
const request = (method, action, auth = "fixture-secret") =>
  new Request("https://fixture.invalid/" + action, {
    method,
    headers: { authorization: "Bearer " + auth },
  });
test("management host authenticates before touching provider and fixes repository identity", async () => {
  const e = env();
  let calls = 0;
  e.ARTIFACTS.create = async (name) => {
    calls++;
    assert.equal(name, e.REPO_NAME);
    return { id: "repo-fixture" };
  };
  assert.equal(
    (await worker.fetch(request("POST", "create", "wrong"), e)).status,
    401,
  );
  assert.equal(calls, 0);
  assert.equal(
    (await worker.fetch(request("POST", "create?name=production"), e)).status,
    400,
  );
  assert.equal(calls, 0);
  assert.equal((await worker.fetch(request("POST", "create"), e)).status, 200);
  assert.equal(calls, 1);
});
test("expired host refuses creation but retains bounded cleanup", async () => {
  const e = env();
  e.EXPIRES_AT = "0";
  let deleted = false;
  e.ARTIFACTS.delete = async (name) => {
    assert.equal(name, e.REPO_NAME);
    deleted = true;
  };
  assert.equal((await worker.fetch(request("POST", "create"), e)).status, 410);
  assert.equal((await worker.fetch(request("DELETE", "repo"), e)).status, 200);
  assert.equal(deleted, true);
});
test("readiness has no provider side effects and info disposes capability", async () => {
  const e = env();
  let disposed = false;
  e.ARTIFACTS.get = async () => ({
    info: async () => ({ id: "repo-fixture" }),
    [Symbol.dispose]: () => {
      disposed = true;
    },
  });
  assert.equal((await worker.fetch(request("GET", "ready"), e)).status, 200);
  assert.deepEqual(
    await (await worker.fetch(request("GET", "repo"), e)).json(),
    { id: "repo-fixture" },
  );
  assert.equal(disposed, true);
});
test("provider errors return no credential or provider text", async () => {
  const e = env();
  e.ARTIFACTS.create = async () => {
    throw Error("private token");
  };
  const r = await worker.fetch(request("POST", "create"), e);
  assert.equal(r.status, 502);
  assert.equal((await r.text()).includes("private"), false);
});
