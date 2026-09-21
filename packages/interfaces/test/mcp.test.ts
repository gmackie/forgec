/**
 * FORGE-054 / PAR-120, PAR-121: MCP tools and resources are generated from the
 * same contracts the HTTP binding serves. Listings are computed per identity
 * and purpose (a warm listing cache never serves another principal), direct
 * invocation re-checks authority, and client-supplied annotations are hints
 * the server ignores when deciding.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Effect } from "effect";
import { beforeEach, describe, expect, it } from "vitest";
import { Engine, MemoryStorage, Model, createHttpHandler, devHeaderAuth, localAuthorizer, testLayer, type AppBundle, type CallContext, type Policy, type Principal } from "@forgegraph/runtime";
import { createMcpServer, mcpHttp, type JsonRpcResponse, type McpServer } from "../src/mcp.js";

const bundle = JSON.parse(readFileSync(resolve(import.meta.dirname, "..", "..", "..", "conformance", "fixtures", "acme-next.app.json"), "utf8")) as AppBundle;
const N = "@acme/commerce-next/_";
const G = "@acme/governance/_";
const run = <A>(e: Effect.Effect<A, unknown, never>) => Effect.runPromise(e as Effect.Effect<A, never, never>);
const seed: CallContext = { tenant: "t", actor: "maintenance", requestId: "seed", maintenance: true };

const policies: Policy[] = [
  // agent-7 (the PIP marks it a writer) may do anything on contacts under CustomerSupport; agent-8 may only read them.
  // The CustomerSupport surface on Contact itself grants read/filter/order/update, so the writer sees `contact_update`
  // and nobody sees `contact_create`: purpose ceiling first, policy second.
  { id: "contacts-all", actions: [`${N}/Contact.*`], purpose: `${G}/CustomerSupport`, requires: [{ pip: "hr", attribute: "writer" }], where: [] },
  { id: "contacts-read", actions: [`${N}/Contact.get`, `${N}/Contact.find.*`, `${N}/Contact.list.*`], purpose: `${G}/CustomerSupport`, requires: [], where: [] },
  { id: "customers-read", actions: [`${N}/Customer.*`], purpose: `${G}/CustomerSupport`, requires: [], where: [] },
];

describe("MCP over the same contracts", () => {
  let engine: Engine;
  let server: McpServer;
  let contact: { id: string };
  const agent7: Principal = { tenant: "t", actor: "agent-7", purposes: [`${G}/CustomerSupport`] };
  const agent8: Principal = { tenant: "t", actor: "agent-8", purposes: [`${G}/CustomerSupport`] };
  const rpc = (p: Principal, method: string, params: unknown = {}, id = 1) => server.handle(p, { jsonrpc: "2.0", id, method, params }, { purpose: `${G}/CustomerSupport` });
  const result = (r: JsonRpcResponse | null) => (r as { result: Record<string, unknown> }).result;

  beforeEach(async () => {
    engine = new Engine(new Model(bundle), testLayer(new MemoryStorage()));
    engine.gatekeeper.authorizer = localAuthorizer({
      policies,
      pips: [{ name: "hr", attributes: { "agent-7": { writer: true }, "agent-8": {} }, freshnessMs: 60_000 }],
      epoch: 1,
      knownObligations: [],
    });
    const customer = await run(engine.call(`${N}/Customer.create`, { code: "AAA", name: "A" }, seed));
    contact = await run(engine.call(`${N}/Contact.create`, { customer: customer.id, name: "Ann", email: "ann@example.com" }, seed));
    server = createMcpServer({ engine });
  });

  it("initialize negotiates from the pinned protocol matrix and never invents a version", async () => {
    const ok = result(await rpc(agent7, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } }));
    expect(ok["protocolVersion"]).toBe("2025-06-18");
    expect(ok["capabilities"]).toEqual({ tools: { listChanged: false }, resources: { subscribe: false, listChanged: false } });
    const older = result(await rpc(agent7, "initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "t", version: "0" } }));
    expect(older["protocolVersion"]).toBe("2025-06-18"); // unsupported request: answer with the newest we support
  });

  it("PAR-120: two identities see different tool listings; a warm cache is never reused across them", async () => {
    const seven = result(await rpc(agent7, "tools/list")).tools as { name: string }[];
    const eight = result(await rpc(agent8, "tools/list")).tools as { name: string }[];
    const names = (t: { name: string }[]) => t.map((x) => x.name).sort();
    expect(names(seven)).toContain("contact_update");
    expect(names(seven)).toContain("contact_get");
    expect(names(eight)).toContain("contact_get");
    expect(names(eight)).not.toContain("contact_update");
    // the purpose ceiling hides what no surface grants, whatever the policy says
    expect(names(seven)).not.toContain("contact_create");
    expect(names(seven)).not.toContain("customer_create");
    // repeat (cache hit) still isolated
    expect(names(result(await rpc(agent8, "tools/list")).tools as { name: string }[])).toEqual(names(eight));
    expect(names(result(await rpc(agent7, "tools/list")).tools as { name: string }[])).toEqual(names(seven));
    // listing is also purpose-specific: no purpose on a purpose-scoped resource means no tools for it
    const noPurpose = result(await server.handle(agent8, { jsonrpc: "2.0", id: 9, method: "tools/list", params: {} }, {})).tools as { name: string }[];
    expect(names(noPurpose)).not.toContain("contact_get");
  });

  it("PAR-120: invoking a hidden tool by name re-checks authority and is refused without disclosure", async () => {
    const r = await rpc(agent8, "tools/call", { name: "contact_update", arguments: { id: contact.id, expectedVersion: 1, patch: { email: "hijacked@example.com" } } });
    const res = result(r);
    expect(res["isError"]).toBe(true);
    const text = (res["content"] as { text: string }[])[0]!.text;
    expect(JSON.parse(text)).toMatchObject({ code: "NotFound" }); // a denied write on an existing record reads as not found (plan §9.1)
    expect(text).not.toContain("hijacked");
    // nothing changed
    const current = await run(engine.call(`${N}/Contact.get`, { id: contact.id }, seed));
    expect(current).toMatchObject({ email: "ann@example.com", version: 1 });
    // a field the purpose surface does not grant is refused before any policy runs, for the writer too
    const outside = result(await rpc(agent7, "tools/call", { name: "contact_update", arguments: { id: contact.id, expectedVersion: 1, patch: { name: "Renamed" } } }));
    expect(JSON.parse((outside["content"] as { text: string }[])[0]!.text)).toMatchObject({ code: "NotPermitted" });
    // and an operation no surface grants is refused the same way for everyone
    const create = result(await rpc(agent7, "tools/call", { name: "contact_create", arguments: { customer: "x", name: "N", email: "n@example.com" } }));
    expect(create["isError"]).toBe(true);
    expect(JSON.parse((create["content"] as { text: string }[])[0]!.text)).toMatchObject({ code: "NotPermitted" });
  });

  it("PAR-121: client annotations are hints; the server contract and policy decide execution", async () => {
    // agent-8 claiming the tool is read-only changes nothing
    const denied = result(await rpc(agent8, "tools/call", { name: "contact_update", arguments: { id: contact.id, expectedVersion: 1, patch: { email: "nope@example.com" } }, annotations: { readOnlyHint: true }, _meta: { readOnlyHint: true } }));
    expect(denied["isError"]).toBe(true);
    // agent-7 claiming a write is read-only still performs the write the contract declares
    const done = result(await rpc(agent7, "tools/call", { name: "contact_update", arguments: { id: contact.id, expectedVersion: 1, patch: { email: "annie@example.com" } }, annotations: { readOnlyHint: true } }));
    expect(done["isError"]).toBeFalsy();
    expect(done["structuredContent"]).toMatchObject({ email: "annie@example.com" });
    expect((await run(engine.call(`${N}/Contact.get`, { id: contact.id }, seed))).version).toBe(2);
    // the advertised annotations come from the contract, not from callers
    const tool = (result(await rpc(agent7, "tools/list")).tools as { name: string; annotations: Record<string, boolean> }[]).find((t) => t.name === "contact_update")!;
    expect(tool.annotations).toEqual({ readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false });
    const get = (result(await rpc(agent7, "tools/list")).tools as { name: string; annotations: Record<string, boolean>; inputSchema: unknown }[]).find((t) => t.name === "contact_get")!;
    expect(get.annotations.readOnlyHint).toBe(true);
    expect(get.inputSchema).toMatchObject({ type: "object", required: ["id"] });
  });

  it("tool results carry the scoped value the HTTP binding would return, and business errors as isError problems", async () => {
    const got = result(await rpc(agent7, "tools/call", { name: "contact_get", arguments: { id: contact.id } }));
    // the surface projects the record: only granted read fields come back
    expect(Object.keys(got["structuredContent"] as object).sort()).toEqual(["customer", "email", "id", "name", "supportNotes", "version"]);
    const stale = result(await rpc(agent7, "tools/call", { name: "contact_update", arguments: { id: contact.id, expectedVersion: 5, patch: { email: "x@example.com" } } }));
    expect(stale["isError"]).toBe(true);
    expect(JSON.parse((stale["content"] as { text: string }[])[0]!.text)).toMatchObject({ code: "VersionConflict", status: 412 });
    const unknown = await rpc(agent7, "tools/call", { name: "nope" });
    expect((unknown as { error: { code: number } }).error.code).toBe(-32602);
  });

  it("resources: discovery and openapi are safe resources; records are templates read under the same gate", async () => {
    const list = result(await rpc(agent7, "resources/list"));
    expect((list["resources"] as { uri: string }[]).map((r) => r.uri)).toEqual(["forge://discovery", "forge://openapi"]);
    const tpl = result(await rpc(agent7, "resources/templates/list"));
    expect((tpl["resourceTemplates"] as { uriTemplate: string }[]).map((r) => r.uriTemplate)).toContain("forge://contact/{id}");
    const disc = result(await rpc(agent7, "resources/read", { uri: "forge://discovery" }));
    expect(JSON.parse((disc["contents"] as { text: string }[])[0]!.text).version).toBe("forge-discovery/1");
    const rec = result(await rpc(agent8, "resources/read", { uri: `forge://contact/${contact.id}` }));
    expect(JSON.parse((rec["contents"] as { text: string }[])[0]!.text)).toMatchObject({ name: "Ann" });
    const missing = await rpc(agent8, "resources/read", { uri: "forge://contact/nope" });
    expect((missing as { error: { code: number } }).error.code).toBe(-32002);
  });

  it("mounts on the HTTP handler at /forge/mcp behind the same authentication", async () => {
    const handler = createHttpHandler(engine.model, engine, { auth: devHeaderAuth(), mounts: { "/forge/mcp": mcpHttp(server) } });
    const anon = await handler(new Request("https://x/forge/mcp", { method: "POST", body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) }));
    expect(anon.status).toBe(401);
    const res = await handler(new Request("https://x/forge/mcp", { method: "POST", headers: { "content-type": "application/json", "x-forge-tenant": "t", "x-forge-actor": "agent-8", "x-forge-purpose": `${G}/CustomerSupport` }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) }));
    expect(res.status).toBe(200);
    const body = await res.json() as { result: { tools: { name: string }[] } };
    expect(body.result.tools.map((t) => t.name)).not.toContain("contact_update");
    expect(body.result.tools.map((t) => t.name)).toContain("contact_get");
    // notifications get 202 and no body
    const note = await handler(new Request("https://x/forge/mcp", { method: "POST", headers: { "content-type": "application/json", "x-forge-tenant": "t", "x-forge-actor": "agent-8" }, body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) }));
    expect(note.status).toBe(202);
  });
});
