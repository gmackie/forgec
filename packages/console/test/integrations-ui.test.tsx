// @vitest-environment jsdom
import React from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { IntegrationsExplorer, integrationDraftsKey } from "../web/integrations.js";

afterEach(cleanup);
beforeEach(() => localStorage.clear());

const op = (operationId: string, method: string, path: string, extra: object = {}) => ({
  operationId,
  method,
  path,
  summary: operationId.split(".").slice(1).join("."),
  tags: [operationId.split(".")[1]],
  parameters: [],
  public: false,
  authentication: "user",
  schemes: ["bearer"],
  sample: { path: {}, query: {}, headers: {} },
  ...extra,
});
const operations = [
  op("notes.notes.get", "get", "/notes/{id}", {
    parameters: [
      { name: "id", in: "path", required: true, schema: { type: "string" } },
      { name: "view", in: "query", required: false, schema: { type: "string" } },
    ],
    sample: { path: { id: "" }, query: {}, headers: {} },
  }),
  op("notes.notes.create", "post", "/notes", {
    requestBody: { required: true, content: { "application/json": { schema: {} } } },
    sample: { path: {}, query: {}, headers: {}, body: { title: "" } },
  }),
  op("notes.admin.purge", "delete", "/admin/purge"),
];
function setup({ configured = true, writes = false } = {}) {
  const calls: { path: string; method?: string | undefined; body?: any }[] = [];
  const api = vi.fn(async (path: string, method?: string, body?: any) => {
    calls.push({ path, method, body });
    if (path === "/integrations")
      return {
        configured,
        integrations: configured
          ? [{ id: "notes", name: "Notes", app: "notes", description: null, baseUrl: "https://notes.example.com", auth: "bearer", writes }]
          : [],
      };
    if (path === "/integrations/notes")
      return {
        integration: { id: "notes", name: "Notes", app: "notes", description: null, baseUrl: "https://notes.example.com", auth: "bearer", writes },
        contract: { fingerprint: "sha256:abcdef0123456789", serviceId: "notes", operationCount: 3 },
        operations,
      };
    if (path.startsWith("/integrations/notes/openapi")) return { openapi: "3.1.0", paths: {} };
    if (path === "/integrations/notes/call")
      return { status: 200, ok: true, durationMs: 7, headers: { "x-request-id": "r1" }, body: { id: "n1" }, bodyKind: "json" };
    throw Error(`unexpected ${path}`);
  });
  const onUseInGraph = vi.fn();
  render(<IntegrationsExplorer api={api as any} onUseInGraph={onUseInGraph} />);
  return { calls, onUseInGraph };
}

it("opens a workspace app when pinned presets sort ahead of it", async () => {
  const calls: string[] = [];
  const api = vi.fn(async (path: string) => {
    calls.push(path);
    if (path === "/integrations")
      return {
        configured: true,
        forgegraph: true,
        integrations: [
          { id: "cloudflare", name: "Cloudflare", app: "cloudflare", description: null, baseUrl: "https://api.cloudflare.com", auth: "bearer", writes: false, source: "preset" },
          { id: "notes", name: "Notes", app: "notes", description: null, baseUrl: "https://notes.example.com", auth: "bearer", writes: false, source: "app" },
        ],
      };
    if (path === "/integrations/notes")
      return {
        integration: { id: "notes", name: "Notes", app: "notes", description: null, baseUrl: "https://notes.example.com", auth: "bearer", writes: false, source: "app" },
        contract: { fingerprint: "sha256:abcdef0123456789", serviceId: "notes", operationCount: 3 },
        operations,
      };
    throw Error(`unexpected ${path}`);
  });
  render(<IntegrationsExplorer api={api as any} />);
  await waitFor(() => {
    if (!calls.includes("/integrations/notes")) throw new Error(`calls=${calls.join("|")}`);
  });
  expect(await screen.findByRole("button", { name: /notes\.get.*GET \/notes\/\{id\}/ })).toBeInTheDocument();
  expect(calls).not.toContain("/integrations/cloudflare");
});

it("explains how to connect ForgeGraph when integrations are not configured", async () => {
  setup({ configured: false });
  expect(await screen.findByText("Connect ForgeGraph")).toBeInTheDocument();
});

it("lists operations by group, filters them, and sends a read with path and query values", async () => {
  const { calls } = setup();
  await screen.findByRole("button", { name: /notes\.get.*GET \/notes\/\{id\}/ });
  expect(screen.getByRole("group", { name: "admin" })).toBeInTheDocument();
  fireEvent.change(screen.getByLabelText("Filter operations"), { target: { value: "purge" } });
  expect(screen.queryByRole("button", { name: /notes\.get/ })).not.toBeInTheDocument();
  fireEvent.change(screen.getByLabelText("Filter operations"), { target: { value: "" } });
  fireEvent.click(screen.getByRole("button", { name: /notes\.get/ }));
  fireEvent.change(screen.getByLabelText("Path id"), { target: { value: "n1" } });
  fireEvent.click(screen.getByRole("button", { name: "Send request" }));
  expect(await screen.findByRole("region", { name: "Response" })).toHaveTextContent('"id": "n1"');
  // An empty optional query value is not sent.
  expect(calls.at(-1)).toMatchObject({ path: "/integrations/notes/call", method: "POST", body: { operationId: "notes.notes.get", path: { id: "n1" }, query: {} } });
  expect(calls.at(-1)!.body.confirmWrite).toBeUndefined();
  expect(screen.getByRole("region", { name: "History" })).toHaveTextContent("GET notes.notes.get → 200");
});

it("keeps a draft per operation across reloads", async () => {
  setup();
  fireEvent.click(await screen.findByRole("button", { name: /notes\.get/ }));
  fireEvent.change(screen.getByLabelText("Path id"), { target: { value: "kept" } });
  expect(JSON.parse(localStorage.getItem(integrationDraftsKey)!)).toMatchObject({ '["notes","notes.notes.get"]': { path: { id: "kept" } } });
  cleanup();
  setup();
  fireEvent.click(await screen.findByRole("button", { name: /notes\.get/ }));
  expect(screen.getByLabelText("Path id")).toHaveValue("kept");
});

it("blocks writes on a read-only integration", async () => {
  const { calls } = setup({ writes: false });
  fireEvent.click(await screen.findByRole("button", { name: /notes\.create/ }));
  expect(screen.getByRole("note")).toHaveTextContent("Writes are not enabled");
  expect(screen.getByRole("button", { name: "Send request" })).toBeDisabled();
  expect(calls.some((c) => c.path.endsWith("/call"))).toBe(false);
});

it("asks for confirmation before a write and sends it with confirmWrite", async () => {
  const { calls } = setup({ writes: true });
  fireEvent.click(await screen.findByRole("button", { name: /notes\.create/ }));
  expect(screen.getByLabelText("Request body")).toHaveValue('{\n  "title": ""\n}');
  fireEvent.change(screen.getByLabelText("Request body"), { target: { value: '{"title":"Hi"}' } });
  fireEvent.click(screen.getByRole("button", { name: "Send request" }));
  expect(await screen.findByText("Send this write?")).toBeInTheDocument();
  expect(calls.some((c) => c.path.endsWith("/call"))).toBe(false);
  fireEvent.click(screen.getByRole("button", { name: "Send write" }));
  await waitFor(() => expect(calls.at(-1)).toMatchObject({ body: { operationId: "notes.notes.create", body: { title: "Hi" }, confirmWrite: true } }));
});

it("refuses invalid JSON bodies before calling", async () => {
  const { calls } = setup({ writes: true });
  fireEvent.click(await screen.findByRole("button", { name: /notes\.create/ }));
  fireEvent.change(screen.getByLabelText("Request body"), { target: { value: "{nope" } });
  fireEvent.click(screen.getByRole("button", { name: "Send request" }));
  fireEvent.click(await screen.findByRole("button", { name: "Send write" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("not valid JSON");
  expect(calls.some((c) => c.path.endsWith("/call"))).toBe(false);
});

it("hands the selected operation's OpenAPI to the graph importer, pinned to the integration host", async () => {
  const { calls, onUseInGraph } = setup();
  fireEvent.click(await screen.findByRole("button", { name: /notes\.get/ }));
  fireEvent.click(screen.getByRole("button", { name: "Use in graph" }));
  await waitFor(() => expect(onUseInGraph).toHaveBeenCalled());
  expect(calls.at(-1)!.path).toBe("/integrations/notes/openapi?operation=notes.notes.get");
  expect(onUseInGraph.mock.calls[0]![0]).toMatchObject({ packageName: "@external/notes", host: "notes.example.com" });
});
