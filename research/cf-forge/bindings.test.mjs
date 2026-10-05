import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { once } from "node:events";
import { createBinding } from "./binding.mjs";
const { CloudflareApiClient } = await import("./.cache/github-sdk/sdk/Client.ts");
const map = JSON.parse(
  await readFile(new URL("./.cache/github-sdk/sdk/sdk-map.json", import.meta.url)),
);
async function vendor(run) {
  const calls = [];
  let reply = { status: 201, body: { id: 17, number: 4, title: "hello" } };
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const c of req) body += c;
    calls.push({ url: req.url, method: req.method, headers: req.headers, body });
    if (reply.disconnect) {
      req.socket.destroy();
      return;
    }
    res.writeHead(reply.status, {
      "content-type": "application/json",
      etag: '"v1"',
      ...reply.headers,
    });
    res.end(JSON.stringify(reply.body));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    await run({
      calls,
      baseUrl: `http://127.0.0.1:${server.address().port}`,
      setReply: (r) => (reply = r),
    });
  } finally {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  }
}
function binding(baseUrl, overrides = {}) {
  return createBinding({
    client: CloudflareApiClient,
    map,
    operationId: "issues/create",
    baseUrl,
    timeoutInSeconds: 0.2,
    tenant: "a",
    credential: async () => "fake-test-token",
    mapInput: (i) => ({ owner: "team", repo: "repo", title: i.title, body: i.body }),
    decodeOutput: (value) => {
      if (!Number.isInteger(value?.id)) throw new Error("invalid vendor id");
      return { externalId: String(value.id) };
    },
    ...overrides,
  });
}
const ctx = { tenant: "a", actor: "test", requestId: "request-1" };
test("generated SDK supplies transport behind an external binding", () =>
  vendor(async ({ baseUrl, calls }) => {
    const result = await binding(baseUrl)({ title: "hello" }, ctx);
    assert.deepEqual(result, { ok: true, value: { externalId: "17" } });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].method, "POST");
    assert.equal(calls[0].url, "/repos/team/repo/issues");
    assert.deepEqual(JSON.parse(calls[0].body), { title: "hello" });
    assert.equal(calls[0].headers.authorization, "Bearer fake-test-token");
  }));
test("connection rejects another tenant before resolving credentials or sending traffic", () =>
  vendor(async ({ baseUrl, calls }) => {
    let credentials = 0;
    const b = binding(baseUrl, {
      credential: async () => {
        credentials++;
        return "fake";
      },
    });
    assert.deepEqual(await b({ title: "hello" }, { ...ctx, tenant: "b" }), {
      ok: false,
      code: "ConnectionScopeMismatch",
    });
    assert.equal(credentials, 0);
    assert.equal(calls.length, 0);
  }));
test("uncertain writes return an explicit outcome without retry or credential leakage", () =>
  vendor(async ({ baseUrl, calls, setReply }) => {
    setReply({ disconnect: true });
    assert.deepEqual(await binding(baseUrl)({ title: "hello" }, ctx), {
      ok: false,
      code: "ExternalOutcomeUnknown",
    });
    assert.equal(calls.length, 1);
  }));
test("invalid success data is rejected at the binding boundary", () =>
  vendor(async ({ baseUrl, setReply }) => {
    setReply({ status: 201, body: { unexpected: "payload" } });
    assert.deepEqual(await binding(baseUrl)({ title: "hello" }, ctx), {
      ok: false,
      code: "ExternalResponseInvalid",
    });
  }));
test("HTTP failures distinguish rejected input, credentials, throttling, and unavailable reads", () =>
  vendor(async ({ baseUrl, setReply, calls }) => {
    for (const [status, code] of [
      [422, "ExternalRejected"],
      [401, "ExternalCredentialsRejected"],
      [429, "ExternalRateLimited"],
      [503, "ExternalOutcomeUnknown"],
    ]) {
      setReply({
        status,
        body: { message: "do not leak token fake-test-token" },
        headers: { "retry-after": "0" },
      });
      assert.deepEqual(await binding(baseUrl)({ title: "hello" }, ctx), { ok: false, code });
    }
    assert.equal(calls.length, 4);
    setReply({ disconnect: true });
    assert.deepEqual(
      await binding(baseUrl, {
        operationId: "issues/list-for-repo",
        mapInput: () => ({ owner: "team", repo: "repo" }),
      })({}, ctx),
      { ok: false, code: "ExternalUnavailable" },
    );
  }));
test("GitHub list preserves pagination input, path encoding and response headers", () =>
  vendor(async ({ baseUrl, calls, setReply }) => {
    setReply({
      status: 200,
      body: [{ id: 17 }],
      headers: { link: '<https://vendor.example/page2>; rel="next"' },
    });
    const sdk = new CloudflareApiClient({ baseUrl, maxRetries: 0, timeoutInSeconds: 0.2 });
    const { data, rawResponse } = await sdk.issues
      .listForRepo({ owner: "team/name", repo: "a b", page: 2, per_page: 3 })
      .withRawResponse();
    assert.deepEqual(data, [{ id: 17 }]);
    assert.match(calls[0].url, /team%2Fname\/a%20b/);
    assert.match(calls[0].url, /page=2/);
    assert.match(rawResponse.headers.get("link"), /page2/);
  }));
test("Cloudflare map identifies wrapped create payload and list envelope", () =>
  vendor(async ({ baseUrl, calls, setReply }) => {
    const { CloudflareApiClient: CF } = await import("./.cache/cloudflare-sdk/sdk/Client.ts");
    const cfMap = JSON.parse(
      await readFile(new URL("./.cache/cloudflare-sdk/sdk/sdk-map.json", import.meta.url)),
    );
    setReply({
      status: 200,
      body: { success: true, result: { id: "dns-1" }, errors: [], messages: [] },
    });
    const sdk = new CF({
      baseUrl,
      auth: false,
      headers: { Authorization: "Bearer fake" },
      maxRetries: 0,
      timeoutInSeconds: 0.2,
    });
    const create = cfMap["dns-records-for-a-zone-create-dns-record"];
    let owner = sdk;
    for (const x of create.accessor) owner = owner[x];
    await owner[create.method]({
      zone_id: "zone-1",
      [create.requestBodyProperty]: { type: "A", name: "example.test", content: "192.0.2.1" },
    });
    assert.deepEqual(JSON.parse(calls[0].body), {
      type: "A",
      name: "example.test",
      content: "192.0.2.1",
    });
    setReply({
      status: 200,
      body: {
        success: true,
        result: [{ id: "dns-1" }],
        result_info: { page: 1, total_pages: 2 },
        errors: [],
        messages: [],
      },
    });
    const listed = await sdk.dns.records.list({ zone_id: "zone-1", page: 1, per_page: 2 });
    assert.deepEqual(listed, {
      result: [{ id: "dns-1" }],
      result_info: { page: 1, total_pages: 2 },
    });
    assert.equal(calls.length, 2);
  }));
test("connection resolves rotated credentials on each call and preserves explicit null", () =>
  vendor(async ({ baseUrl, calls }) => {
    let n = 0;
    const b = binding(baseUrl, { credential: async () => `fake-${++n}` });
    await b({ title: "one", body: null }, ctx);
    await b({ title: "two" }, ctx);
    assert.equal(calls[0].headers.authorization, "Bearer fake-1");
    assert.equal(calls[1].headers.authorization, "Bearer fake-2");
    assert.equal(JSON.parse(calls[0].body).body, null);
    assert.equal(Object.hasOwn(JSON.parse(calls[1].body), "body"), false);
  }));
test("real ForgeGraph function invokes the binding; undeclared dependencies never reach the vendor", () =>
  vendor(async ({ baseUrl, calls }) => {
    const { createRequire } = await import("node:module");
    const require = createRequire(new URL("../../packages/runtime/package.json", import.meta.url));
    const { Effect } = await import(require.resolve("effect"));
    const { Engine } = await import("../../packages/runtime/src/engine.ts");
    const { Model } = await import("../../packages/runtime/src/model.ts");
    const { MemoryStorage } = await import("../../packages/runtime/src/adapters/memory.ts");
    const { testLayer } = await import("../../packages/runtime/src/testing.ts");
    const { defineFunction } = await import("../../packages/runtime/src/functions.ts");
    const bundle = JSON.parse(
      await readFile(new URL("../../conformance/fixtures/acme.app.json", import.meta.url)),
    );
    const model = new Model(bundle);
    const id = "@acme/commerce/_/SubmitOrder",
      external = "@acme/payments/_/AuthorizePayment";
    // Existing capability is a deliberate seam fixture, not a claim that creating an issue authorizes payment.
    const impl = defineFunction(id, (deps) =>
      Effect.gen(function* () {
        const result = yield* deps.external(external, { title: "fixture" });
        assert.equal(result.ok, true);
        return yield* deps.resources.Order.get(deps.input.order);
      }),
    );
    const engine = new Engine(model, testLayer(new MemoryStorage()), {
      functions: [impl],
      externals: { [external]: binding(baseUrl) },
    });
    const run = (e) => Effect.runPromise(e);
    const customer = await run(
      engine.call("@acme/commerce/_/Customer.create", { code: "RESEARCH", name: "Research" }, ctx),
    );
    const site = await run(
      engine.call(
        "@acme/commerce/_/Site.create",
        { customer: customer.id, code: "hq", name: "HQ", timezone: "UTC" },
        ctx,
      ),
    );
    const order = await run(
      engine.call(
        "@acme/commerce/_/Order.create",
        {
          customer: customer.id,
          site: site.id,
          subtotal: "1.00",
          tax: "0.00",
          requestedOn: "2026-09-28",
        },
        ctx,
      ),
    );
    await run(engine.call(id, { order: order.id, expectedVersion: 1 }, ctx));
    assert.equal(calls.length, 1);
    const rogue = new Engine(model, testLayer(new MemoryStorage()), {
      functions: [defineFunction(id, (deps) => deps.external("undeclared", {}))],
      externals: { undeclared: binding(baseUrl) },
    });
    await assert.rejects(
      () => run(rogue.call(id, { order: order.id, expectedVersion: 1 }, ctx)),
      (e) => e.code === "Forbidden" && e.detail.includes("did not declare"),
    );
    assert.equal(calls.length, 1);
  }));
test("stable operation ID survives a generated SDK method rename", () =>
  vendor(async ({ baseUrl, calls }) => {
    const { CloudflareApiClient: Next } = await import("./.cache/github-next-sdk/sdk/Client.ts");
    const nextMap = JSON.parse(
      await readFile(new URL("./.cache/github-next-sdk/sdk/sdk-map.json", import.meta.url)),
    );
    assert.notEqual(map["issues/create"].method, nextMap["issues/create"].method);
    const result = await binding(baseUrl, { client: Next, map: nextMap })({ title: "hello" }, ctx);
    assert.deepEqual(result, { ok: true, value: { externalId: "17" } });
    assert.equal(calls.length, 1);
  }));
test("credential-provider failures stay local and do not expose secrets", () =>
  vendor(async ({ baseUrl, calls }) => {
    assert.deepEqual(
      await binding(baseUrl, {
        credential: async () => {
          throw new Error("fake-private-token");
        },
      })({ title: "hello" }, ctx),
      { ok: false, code: "ExternalCredentialsUnavailable" },
    );
    assert.equal(calls.length, 0);
  }));
test("same binding interface supports Cloudflare with explicit domain mapping", () =>
  vendor(async ({ baseUrl, setReply, calls }) => {
    const { CloudflareApiClient: CF } = await import("./.cache/cloudflare-sdk/sdk/Client.ts");
    const cfMap = JSON.parse(
      await readFile(new URL("./.cache/cloudflare-sdk/sdk/sdk-map.json", import.meta.url)),
    );
    setReply({
      status: 200,
      body: { success: true, result: { id: "dns-1" }, errors: [], messages: [] },
    });
    const b = binding(baseUrl, {
      client: CF,
      map: cfMap,
      operationId: "dns-records-for-a-zone-create-dns-record",
      mapInput: (i) => ({
        zone_id: "zone-1",
        body: { type: "A", name: i.name, content: i.address },
      }),
      decodeOutput: (value) => {
        if (typeof value?.id !== "string") throw new Error("bad record");
        return { externalId: value.id };
      },
    });
    assert.deepEqual(await b({ name: "example.test", address: "192.0.2.1" }, ctx), {
      ok: true,
      value: { externalId: "dns-1" },
    });
    assert.equal(calls[0].headers.authorization, "Bearer fake-test-token");
  }));
