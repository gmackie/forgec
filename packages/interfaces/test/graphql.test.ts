import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import {
  Engine,
  Model,
  MemoryStorage,
  testLayer,
  createHttpHandler,
  devHeaderAuth,
  type AppBundle,
} from "@forgegraph/runtime";
import {
  projectGraphQL,
  executeGraphQL,
  diffGraphQL,
  graphqlHttp,
} from "../src/graphql.js";
import { localCallable } from "../src/rpc.js";
const bundle = JSON.parse(
  readFileSync(
    new URL("../../../conformance/fixtures/acme.app.json", import.meta.url),
    "utf8",
  ),
) as AppBundle;
const base = "@acme/commerce/_/Customer";
const mapping = {
  operations: {
    [base + ".get"]: "customer",
    [base + ".create"]: "customerCreate",
    [base + ".list.all"]: "customers",
    [base + ".update"]: "customerUpdate",
  },
  types: { CustomerRecord: "Customer" },
  fields: {
    CustomerRecord: { name: "displayName" },
    CustomerCreate: { name: "displayName" },
  },
};
it("generates deterministic schemas and supports explicit legacy names", () => {
  const a = projectGraphQL(bundle, mapping),
    b = projectGraphQL(bundle, mapping);
  expect(a.sdl).toBe(b.sdl);
  expect(a.sdl).toContain("type Customer {");
  expect(a.sdl).toContain("displayName: String");
  const diff = diffGraphQL(
    a,
    projectGraphQL(bundle, {
      ...mapping,
      operations: { ...mapping.operations, [base + ".get"]: "renamed" },
    }),
  );
  expect(diff.breaking.some((c) => c.description.includes("customer"))).toBe(
    true,
  );
});
it("creates, reads, updates and pages through the same tenant-scoped engine", async () => {
  const engine = new Engine(new Model(bundle), testLayer(new MemoryStorage()));
  const callable = localCallable(engine, { tenant: "graphql", actor: "user" }),
    projection = projectGraphQL(bundle, mapping);
  const run = (query: string, variables?: Record<string, unknown>) =>
    executeGraphQL(projection, callable, {
      query,
      ...(variables ? { variables } : {}),
    });
  const created = await run(
    'mutation { customerCreate(input:{code:"ONE",displayName:"One"}) {id displayName version} }',
  );
  expect(created.errors).toBeUndefined();
  const row = created.data!["customerCreate"] as any;
  expect(row.displayName).toBe("One");
  await run(
    'mutation { customerCreate(input:{code:"TWO",displayName:"Two"}) {id} }',
  );
  const first = await run(
    "{ customers(limit:1) {items{id displayName} next limit} }",
  );
  expect(first.errors).toBeUndefined();
  const page = first.data!["customers"] as any;
  expect(page.items).toHaveLength(1);
  expect(page.next).toBeTruthy();
  const second = await run(
    "query($cursor:String!){customers(limit:1,cursor:$cursor){items{id} next}}",
    { cursor: page.next },
  );
  expect(second.errors).toBeUndefined();
  expect((second.data!["customers"] as any).items[0].id).not.toBe(
    page.items[0].id,
  );
  const read = await run(
    "query($id:String!){customer(id:$id){id displayName}}",
    { id: row.id },
  );
  expect(read.errors).toBeUndefined();
  const other = await executeGraphQL(
    projection,
    localCallable(engine, { tenant: "other", actor: "user" }),
    {
      query: "query($id:String!){customer(id:$id){id}}",
      variables: { id: row.id },
    },
  );
  expect(other.errors?.[0]?.extensions["code"]).toBe("NotFound");
  const stale = await run(
    'mutation($id:String!){customerUpdate(id:$id,expectedVersion:99,input:{name:"Changed"}){id}}',
    { id: row.id },
  );
  expect(stale.errors?.[0]?.extensions["code"]).toBe("VersionConflict");
  expect(
    (await run("{ customers(limit:101) { next } }")).errors?.[0]?.extensions[
      "code"
    ],
  ).toBe("ValidationFailed");
});
it("mounts behind the existing host authentication and enforces credential purpose", async () => {
  const engine = new Engine(new Model(bundle), testLayer(new MemoryStorage()));
  const handler = createHttpHandler(engine.model, engine, {
    auth: devHeaderAuth(),
    mounts: { "/forge/graphql": graphqlHttp(engine, mapping) },
  });
  const request = (headers: Record<string, string>) =>
    new Request("http://local/forge/graphql", {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify({ query: "{customers(limit:1){next}}" }),
    });
  expect((await handler(request({}))).status).toBe(401);
  const response = await handler(
    request({ "x-forge-tenant": "t", "x-forge-actor": "a" }),
  );
  expect(response.status).toBe(200);
  expect((await response.json()).errors).toBeUndefined();
  const denied = await executeGraphQL(
    projectGraphQL(bundle, mapping),
    localCallable(engine, { tenant: "t", actor: "a", purposes: ["allowed"] }),
    { query: "{customers(limit:1){next}}" },
    { purpose: "forbidden" },
  );
  expect(denied.errors?.[0]?.extensions["code"]).toBe("NotPermitted");
});
it("rejects collisions, stale mappings, amplification, and unsupported shapes before invoking", async () => {
  expect(() =>
    projectGraphQL(bundle, {
      operations: { [base + ".get"]: "same", [base + ".create"]: "same" },
    }),
  ).toThrow("collision");
  expect(() =>
    projectGraphQL(bundle, {
      fields: { CustomerRecord: { missing: "legacy" } },
    }),
  ).toThrow("Unknown mapped field");
  expect(() =>
    projectGraphQL(bundle, { types: { CustomerRecord: "String" } }),
  ).toThrow();
  const projection = projectGraphQL(bundle, mapping);
  let calls = 0;
  const callable = {
    invoke: async () => {
      calls++;
      return { kind: "ok" as const, value: {} };
    },
  };
  const result = await executeGraphQL(projection, callable, {
    query:
      "{" +
      Array.from(
        { length: 51 },
        (_, i) => `x${i}:customers(limit:1){next}`,
      ).join(" ") +
      "}",
  });
  expect(result.errors?.[0]?.message).toContain("budget");
  expect(calls).toBe(0);
  expect(
    projection.diagnostics.some((d) => d.reason.includes("workflow")),
  ).toBe(true);
});
it("honors purpose surfaces and denies unauthorized writes through GraphQL", async () => {
  const { Effect } = await import("effect");
  const { localAuthorizer } = await import("@forgegraph/runtime");
  const governed = JSON.parse(
    readFileSync(
      new URL(
        "../../../conformance/fixtures/acme-next.app.json",
        import.meta.url,
      ),
      "utf8",
    ),
  ) as AppBundle;
  const engine = new Engine(
    new Model(governed),
    testLayer(new MemoryStorage()),
  );
  const n = "@acme/commerce-next/_",
    purpose = "@acme/governance/_/CustomerSupport";
  const seed = {
    tenant: "t",
    actor: "maintenance",
    requestId: "seed",
    maintenance: true,
  };
  const customer = await Effect.runPromise(
    engine.call(n + "/Customer.create", { code: "AAA", name: "A" }, seed),
  );
  const contact = await Effect.runPromise(
    engine.call(
      n + "/Contact.create",
      { customer: customer.id, name: "Ann", email: "ann@example.com" },
      seed,
    ),
  );
  engine.gatekeeper.authorizer = localAuthorizer({
    policies: [
      {
        id: "read",
        actions: [n + "/Contact.get"],
        purpose,
        requires: [],
        where: [],
      },
    ],
    pips: [],
    epoch: 1,
    knownObligations: [],
  });
  const projection = projectGraphQL(governed, {
    operations: {
      [n + "/Contact.get"]: "contact",
      [n + "/Contact.update"]: "contactUpdate",
    },
  });
  const call = localCallable(engine, {
    tenant: "t",
    actor: "reader",
    purposes: [purpose],
  });
  const result = await executeGraphQL(
    projection,
    call,
    {
      query: "query($id:String!){contact(id:$id){id email createdAt}}",
      variables: { id: contact.id },
    },
    { purpose },
  );
  expect(result.errors).toBeUndefined();
  expect(result.data!["contact"]).toMatchObject({
    email: "ann@example.com",
    createdAt: null,
  });
  const denied = await executeGraphQL(
    projection,
    call,
    {
      query:
        'mutation($id:String!){contactUpdate(id:$id,expectedVersion:1,input:{email:"evil@example.com"}){id}}',
      variables: { id: contact.id },
    },
    { purpose },
  );
  expect(denied.errors).toHaveLength(1);
  expect(
    (
      await Effect.runPromise(
        engine.call(n + "/Contact.get", { id: contact.id }, seed),
      )
    ).email,
  ).toBe("ann@example.com");
});
it("preserves a KanBanger/Linear-style Issue contract including state transitions", async () => {
  const fixture = JSON.parse(
    readFileSync(
      new URL("./fixtures/kanbanger.app.json", import.meta.url),
      "utf8",
    ),
  ) as AppBundle;
  const id = "@kanbanger/issues/_/Issue";
  const legacy = {
    operations: {
      [id + ".create"]: "issueCreate",
      [id + ".get"]: "issue",
      [id + ".list.byTeam"]: "issues",
      [id + ".status.complete"]: "issueComplete",
    },
    types: { IssueRecord: "Issue", IssueCreate: "IssueCreate" },
    fields: { IssueRecord: { status: "state" } },
  };
  const projection = projectGraphQL(fixture, legacy);
  const engine = new Engine(new Model(fixture), testLayer(new MemoryStorage()));
  const callable = localCallable(engine, {
    tenant: "kanbanger",
    actor: "member",
  });
  const created = await executeGraphQL(projection, callable, {
    query:
      'mutation {issueCreate(input:{identifier:"ENG-1",title:"Build GraphQL",team:"ENG"}){id identifier title state version}}',
  });
  expect(created.errors).toBeUndefined();
  const issue = created.data!["issueCreate"] as any;
  expect(issue.state).toBe("Forge_Open");
  const result = await executeGraphQL(projection, callable, {
    query: 'query{issues(team:"ENG",limit:1){items{identifier title} next}}',
  });
  expect(result.errors).toBeUndefined();
  expect((result.data!["issues"] as any).items).toEqual([
    { identifier: "ENG-1", title: "Build GraphQL" },
  ]);
  const completed = await executeGraphQL(projection, callable, {
    query:
      "mutation($id:String!){issueComplete(id:$id,expectedVersion:1){state version}}",
    variables: { id: issue.id },
  });
  expect(completed.errors).toBeUndefined();
  expect(completed.data!["issueComplete"]).toMatchObject({
    state: "Forge_Completed",
    version: 2,
  });
  const changed = projectGraphQL(fixture, {
    ...legacy,
    fields: { IssueRecord: { title: "state", status: "title" } },
  });
  expect(
    diffGraphQL(projection, changed).breaking.some(
      (c) => c.type === "BINDING_CHANGED",
    ),
  ).toBe(true);
});
it("maps function inputs to the canonical envelope without bypassing the callable", async () => {
  const id = "@acme/commerce/_/SubmitOrder";
  const projection = projectGraphQL(bundle, {
    operations: { [id]: "submitOrder" },
  });
  let input: unknown;
  const result = await executeGraphQL(
    projection,
    {
      invoke: async (operation, value) => {
        expect(operation).toBe(id);
        input = value;
        return { kind: "ok", value: { id: "order", version: 2 } };
      },
    },
    {
      query:
        'mutation {submitOrder(order:"order",input:{expectedVersion:1}){id version}}',
    },
  );
  expect(result.errors).toBeUndefined();
  expect(input).toEqual({ order: "order", expectedVersion: 1 });
});

it("rejects malformed/batched/oversized HTTP requests and unsafe integer coercion", async () => {
  const engine = new Engine(new Model(bundle), testLayer(new MemoryStorage()));
  const mount = graphqlHttp(engine, mapping);
  const principal = { tenant: "t", actor: "a" };
  const request = (body: string, method = "POST") =>
    new Request("http://local/forge/graphql", {
      method,
      ...(method === "POST" ? { body } : {}),
    });
  expect((await mount(request("", "GET"), principal, "r")).status).toBe(405);
  expect((await mount(request("[]"), principal, "r")).status).toBe(400);
  expect((await mount(request("{"), principal, "r")).status).toBe(400);
  expect(
    (await mount(request("x".repeat(1_048_577)), principal, "r")).status,
  ).toBe(413);
  let calls = 0;
  const callable = {
    invoke: async () => {
      calls++;
      return { kind: "ok" as const, value: {} };
    },
  };
  const result = await executeGraphQL(
    projectGraphQL(bundle, mapping),
    callable,
    {
      query:
        'mutation {customerUpdate(id:"x",expectedVersion:9007199254740992,input:{name:"No"}){id}}',
    },
  );
  expect(result.errors?.[0]?.message).toContain("safe integer");
  expect(calls).toBe(0);
});

it("detects canonical root rebinding even when GraphQL types stay the same", () => {
  const before = projectGraphQL(bundle, mapping);
  const after = projectGraphQL(bundle, {
    ...mapping,
    operations: {
      ...mapping.operations,
      [base + ".get"]: "customerFind",
      [base + ".find.byCode"]: "customer",
    },
  });
  expect(
    diffGraphQL(before, after).breaking.some(
      (change) =>
        change.type === "BINDING_CHANGED" &&
        change.description.includes("customer"),
    ),
  ).toBe(true);
  const reordered = structuredClone(bundle);
  const doc = reordered.openapi as { paths: Record<string, unknown> };
  doc.paths = Object.fromEntries(Object.entries(doc.paths).reverse());
  expect(projectGraphQL(reordered, mapping).sdl).toBe(before.sdl);
});
