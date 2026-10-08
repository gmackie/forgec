import { describe, expect, it } from "vitest";
import { dump } from "js-yaml";
import { builtinPresets, type IntegrationPreset } from "../src/presets/catalog.js";
import { fetchSpec, loadSpecText, SPEC_BYTE_CAP } from "../src/presets/load.js";
import { parseOpenApiText } from "../src/presets/parse.js";
import { ForgeGraphRegistry, Integrations, integrationsFrom } from "../src/integrations.js";

const tiny = {
  openapi: "3.1.0",
  info: { title: "Tiny", version: "1" },
  paths: {
    "/widgets/{id}": {
      parameters: [{ $ref: "#/components/parameters/Id" }],
      get: {
        operationId: "widgets.get",
        summary: "Get a widget",
        tags: ["Widgets"],
        parameters: [{ name: "verbose", in: "query", schema: { type: "boolean" } }],
        responses: { "200": { description: "Success" } },
      },
    },
    "/widgets": {
      post: {
        operationId: "widgets.create",
        summary: "Create a widget",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: { type: "object", required: ["name"], properties: { name: { type: "string" } } },
            },
          },
        },
        responses: { "201": { description: "Created" } },
      },
    },
  },
  components: {
    parameters: { Id: { name: "id", in: "path", required: true, schema: { type: "string" } } },
    securitySchemes: { bearer: { type: "http", scheme: "bearer" } },
  },
  security: [{ bearer: [] }],
};

describe("preset specs", () => {
  it("parses YAML and JSON of the same spec into the same operations", () => {
    const json = parseOpenApiText(JSON.stringify(tiny));
    const yaml = parseOpenApiText(dump(tiny));
    expect(yaml.operations).toEqual(json.operations);
    expect(json.operations.map((op) => `${op.method} ${op.path}`)).toEqual(["post /widgets", "get /widgets/{id}"]);
    expect(json.operations.find((op) => op.operationId === "widgets.get")!.parameters).toEqual([
      { name: "id", in: "path", required: true, schema: { type: "string" } },
      { name: "verbose", in: "query", required: false, schema: { type: "boolean" } },
    ]);
    expect(json.operations.map((op) => op.schemes)).toEqual([["bearer"], ["bearer"]]);
    expect(json.operations[0]!.schemes).toEqual(["bearer"]);
    expect(json.operations[0]!.public).toBe(false);
  });

  it("refuses a spec whose digest does not match the pin", async () => {
    const text = JSON.stringify(tiny);
    await expect(loadSpecText(text, "a".repeat(64))).rejects.toMatchObject({
      status: 502,
      message: expect.stringContaining("Spec digest mismatch"),
    });
    const loaded = await loadSpecText(text, await digest(text));
    expect(loaded.operations).toHaveLength(2);
  });

  it("pins each bundled preset to the digest of its document", async () => {
    for (const preset of builtinPresets) {
      const loaded = await loadSpecText(preset.document, preset.sha256);
      expect(loaded.operations.length, preset.id).toBeGreaterThan(0);
    }
  });

  it("fetches a spec server-side and refuses redirects, oversize bodies, and private URLs", async () => {
    const text = dump(tiny);
    const sha = await digest(text);
    const ok = fetcher(() => new Response(text, { headers: { "content-type": "application/yaml" } }));
    expect((await fetchSpec("https://specs.example.com/tiny.yaml", sha, ok.fetch)).operations).toHaveLength(2);
    expect(ok.urls).toEqual(["https://specs.example.com/tiny.yaml"]);

    const redirected = fetcher(() => new Response(null, { status: 302, headers: { location: "https://elsewhere.example.com/spec.yaml" } }));
    await expect(fetchSpec("https://specs.example.com/tiny.yaml", sha, redirected.fetch)).rejects.toMatchObject({ status: 502 });

    const huge = fetcher(() => new Response("", { headers: { "content-length": String(SPEC_BYTE_CAP + 1) } }));
    await expect(fetchSpec("https://specs.example.com/tiny.yaml", sha, huge.fetch)).rejects.toMatchObject({
      status: 502,
      message: expect.stringContaining("1.5 MB"),
    });

    await expect(fetchSpec("https://metadata.google.internal/spec.yaml", sha, ok.fetch)).rejects.toMatchObject({ status: 502 });
    await expect(fetchSpec("http://specs.example.com/tiny.yaml", sha, ok.fetch)).rejects.toMatchObject({ status: 502 });
  });
});

describe("preset catalog", () => {
  const apps = [{ slug: "notes", name: "Notes", description: "Note service", healthCheckUrl: "https://notes.example.com/.well-known/forge-health" }];

  function registry() {
    return new ForgeGraphRegistry("https://fg.example.com", "fg-read-token", (async (input: string | URL) => {
      const url = String(input);
      if (url.endsWith("/api/fg/apps")) return Response.json({ apps });
      return new Response("no", { status: 404 });
    }) as typeof fetch);
  }

  it("lists presets beside ForgeGraph apps, and an override base URL wins", async () => {
    const integrations = new Integrations(registry(), [{ app: "stripe", baseUrl: "https://proxy.example.com/stripe", name: "Stripe proxy" }], {}, fetch, () => 1, false, builtinPresets);
    const listed = await integrations.list();
    expect(listed.map((item) => item.id)).toEqual(["cloudflare", "github", "linear", "notes", "stripe"]);
    expect(listed.find((item) => item.id === "notes")).toMatchObject({ source: "app", baseUrl: "https://notes.example.com" });
    expect(listed.find((item) => item.id === "stripe")).toMatchObject({
      source: "preset",
      name: "Stripe proxy",
      baseUrl: "https://proxy.example.com/stripe",
      auth: "bearer",
    });
    expect(listed.find((item) => item.id === "github")!.baseUrl).toBe("https://api.github.com");
  });

  it("keeps a ForgeGraph app when a preset reuses its id, and hides a preset on request", async () => {
    const preset: IntegrationPreset = { ...builtinPresets[0]!, id: "notes", name: "Not Notes" };
    const integrations = new Integrations(registry(), [{ app: "github", hidden: true }], {}, fetch, () => 1, false, [preset, ...builtinPresets]);
    const listed = await integrations.list();
    const ids = listed.map((item) => item.id);
    expect(ids.filter((id) => id === "notes")).toEqual(["notes"]);
    expect(listed.find((item) => item.id === "notes")).toMatchObject({ source: "app", name: "Notes", description: "Note service" });
    expect(ids).not.toContain("github");
    await expect(integrations.describe("github")).rejects.toMatchObject({ status: 404 });
  });

  it("calls a preset with its pinned base URL and bearer token", async () => {
    const seen: { url: string; method: string; authorization: string | null }[] = [];
    const integrations = new Integrations(
      null,
      [],
      { INTEGRATION_GITHUB: "gh-token" },
      (async (input: string | URL | Request, init?: RequestInit) => {
        const headers = new Headers(init?.headers);
        seen.push({ url: String(input), method: init?.method ?? "GET", authorization: headers.get("authorization") });
        return Response.json({ login: "octocat" });
      }) as typeof fetch,
      () => 1,
      false,
      builtinPresets,
    );
    expect(integrations.forgegraph).toBe(false);
    const described = await integrations.describe("github");
    expect(described.operations.map((op) => op.operationId)).toContain("github.user.get");
    expect(described.contract.fingerprint.startsWith("sha256:")).toBe(true);
    const result = await integrations.call("github", { operationId: "github.user.get" });
    expect(seen).toEqual([{ url: "https://api.github.com/user", method: "GET", authorization: "Bearer gh-token" }]);
    expect(result.body).toEqual({ login: "octocat" });
    expect(JSON.stringify(result)).not.toContain("gh-token");
    const doc = (await integrations.openapi("github", ["github.repos.get"])) as { paths: Record<string, unknown>; servers: { url: string }[] };
    expect(Object.keys(doc.paths)).toEqual(["/repos/{owner}/{repo}"]);
    expect(doc.servers).toEqual([{ url: "https://api.github.com" }]);
  });

  it("treats Linear's GraphQL POST as a write", async () => {
    const locked = new Integrations(null, [], { INTEGRATION_LINEAR: "lin" }, fetch, () => 1, false, builtinPresets);
    await expect(locked.call("linear", { operationId: "linear.graphql", body: { query: "{ viewer { id } }" }, confirmWrite: true })).rejects.toMatchObject({ status: 403 });
    const open = new Integrations(null, [{ app: "linear", writes: true }], { INTEGRATION_LINEAR: "lin" }, (async () => Response.json({ data: { viewer: { id: "1" } } })) as typeof fetch, () => 1, false, builtinPresets);
    await expect(open.call("linear", { operationId: "linear.graphql", body: { query: "{ viewer { id } }" } })).rejects.toMatchObject({ status: 428 });
    const result = await open.call("linear", { operationId: "linear.graphql", body: { query: "{ viewer { id } }" }, confirmWrite: true });
    expect(result.body).toEqual({ data: { viewer: { id: "1" } } });
  });

  it("refuses a preset whose bundled document does not match its pin, before calling", async () => {
    const broken: IntegrationPreset = { ...builtinPresets[0]!, sha256: "b".repeat(64) };
    const seen: string[] = [];
    const integrations = new Integrations(null, [], {}, (async (input: string | URL) => {
      seen.push(String(input));
      return Response.json({});
    }) as typeof fetch, () => 1, false, [broken]);
    await expect(integrations.describe("github")).rejects.toMatchObject({ status: 502, message: expect.stringContaining("digest mismatch") });
    expect(seen).toEqual([]);
  });

  it("lists presets when ForgeGraph is not configured", async () => {
    const integrations = integrationsFrom({});
    expect(integrations.forgegraph).toBe(false);
    expect((await integrations.list()).map((item) => item.id)).toEqual(["cloudflare", "github", "linear", "stripe"]);
    expect(() => integrationsFrom({ FORGEGRAPH_URL: "https://fg.example.com" })).toThrow(/FORGEGRAPH_TOKEN/);
  });
});

async function digest(text: string): Promise<string> {
  const bytes = new TextEncoder().encode(text);
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(hash)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function fetcher(respond: () => Response) {
  const urls: string[] = [];
  const fetchSpecBytes = (async (input: string | URL) => {
    urls.push(String(input));
    return respond();
  }) as typeof fetch;
  return { fetch: fetchSpecBytes, urls };
}
