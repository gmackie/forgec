import { describe, it, expect } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { createApi } from "../src/api.js";
import { SqliteState } from "../src/sqlite.js";
const token = "a-test-administrator-token-that-is-long";
function setup() {
  const db = new DatabaseSync(":memory:");
  const store = new SqliteState(db);
  const api = createApi({
    store,
    token,
    authority: "standalone.example",
    name: "My Forge",
    runtime: "node",
    registry: null,
  });
  const call = (
    path: string,
    method = "GET",
    body?: unknown,
    revision?: number,
    authorized = true,
  ) =>
    api(
      new Request(`http://localhost/api${path}`, {
        method,
        headers: {
          ...(authorized ? { authorization: `Bearer ${token}` } : {}),
          ...(body ? { "content-type": "application/json" } : {}),
          ...(revision !== undefined ? { "if-match": String(revision) } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      }),
    );
  return { db, store, call };
}
describe("management API", () => {
  it("fails closed and exposes no private state without instance authentication", async () => {
    const { call } = setup();
    expect(
      (await call("/state", "GET", undefined, undefined, false)).status,
    ).toBe(401);
    const r = await call("/state");
    expect(r.status).toBe(200);
    expect((await r.json()).instance.authority).toBe("standalone.example");
  });
  it("creates app/environment configuration, persists across handlers and rejects stale updates", async () => {
    const { call, db } = setup();
    const r = await call(
      "/apps",
      "POST",
      { name: "Commerce", description: "Orders" },
      0,
    );
    expect(r.status).toBe(201);
    const created = await r.json();
    const id = created.apps[0].id;
    const env = {
      name: "production",
      target: "cloudflare",
      endpoint: "https://commerce.example",
      packageDigest: "",
      config: { REGION: "us-east" },
      secretRefs: { PAYMENTS: "worker:PAYMENTS" },
    };
    const saved = await call(`/apps/${id}/environments`, "POST", env, 1);
    expect(saved.status).toBe(201);
    expect(
      (
        await call(
          `/apps/${id}`,
          "PATCH",
          { name: "Lost update", description: "", archived: false },
          1,
        )
      ).status,
    ).toBe(409);
    const persisted = await new SqliteState(db).read();
    expect(persisted.apps[0]?.environments[0]?.config).toEqual({
      REGION: "us-east",
    });
    expect(persisted.audit).toHaveLength(2);
  });
  it("rejects malformed inputs, cross-origin writes, and missing preconditions", async () => {
    const { call, store } = setup();
    expect((await call("/apps", "POST", { name: "" }, 0)).status).toBe(400);
    expect(
      (await call("/apps", "POST", { name: "App", description: "" })).status,
    ).toBe(428);
    const api = createApi({
      store,
      token,
      authority: "standalone.example",
      name: "My Forge",
      runtime: "node",
      registry: null,
    });
    expect(
      (
        await api(
          new Request("https://console.example/api/apps", {
            method: "POST",
            headers: {
              origin: "https://evil.example",
              authorization: `Bearer ${token}`,
              "content-type": "application/json",
              "if-match": "0",
            },
            body: "{}",
          }),
        )
      ).status,
    ).toBe(403);
  });
  it("allows only one of two concurrent writes at the same revision", async () => {
    const { call } = setup();
    const results = await Promise.all([
      call("/apps", "POST", { name: "A", description: "" }, 0),
      call("/apps", "POST", { name: "B", description: "" }, 0),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
  });
});
it("durably reserves package versions across storage instances", async () => {
  const { db, store } = setup();
  const second = new SqliteState(db);
  const results = await Promise.all([
    store.reservePublication("version-key"),
    second.reservePublication("version-key"),
  ]);
  expect(results.sort()).toEqual([false, true]);
  expect(await new SqliteState(db).reservePublication("version-key")).toBe(
    false,
  );
});

it("requires authentication and exposes only configured Git projects", async () => {
  const { call } = setup();
  expect(
    (await call("/git/projects", "GET", undefined, undefined, false)).status,
  ).toBe(401);
  expect(await (await call("/git/projects")).json()).toEqual({ projects: [] });
  expect((await call("/git/projects/arbitrary")).status).toBe(404);
  expect(
    (
      await call("/git/projects/arbitrary/commits", "POST", {
        base: "a".repeat(40),
        message: "Change",
        files: [],
      })
    ).status,
  ).toBe(404);
});

it("returns 400 for malformed Git commit input without calling the provider", async () => {
  const { GitRepository } = await import("../src/git.js");
  const db = new DatabaseSync(":memory:");
  const api = createApi({
    store: new SqliteState(db),
    token,
    authority: "local.test",
    name: "Test",
    runtime: "test",
    registry: null,
    git: [
      new GitRepository(
        {
          id: "demo",
          name: "Demo",
          repository: "owner/repo",
          branch: "main",
          root: "src",
        },
        "private",
        async () => {
          throw Error("Must not call provider");
        },
      ),
    ],
  });
  const response = await api(
    new Request("http://localhost/api/git/projects/demo/commits", {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ base: "bad" }),
    }),
  );
  expect(response.status).toBe(400);
});

it('requires console authentication before exposing runtime and deployment connections',async()=>{
 const {call}=setup();
 for(const path of ['/runtime/targets','/deployments/targets']){
  expect((await call(path,'GET',undefined,undefined,false)).status).toBe(401);
  expect(await (await call(path)).json()).toEqual({targets:[]});
 }
 expect((await call('/runtime/targets/missing/invoke','POST',{operationId:'x',input:{},buildHash:'b'})).status).toBe(404);
});
