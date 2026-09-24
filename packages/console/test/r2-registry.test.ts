/**
 * The R2 registry proved against the real client.
 *
 * The valuable assertion here is not that the server implements what I think the spec says —
 * it is that the *unchanged* `OciRegistry`, the same code that talks to CNCF Distribution in
 * production, can publish to this server and pull back what it published. So the client is
 * driven through its normal path and its requests are dispatched into `createRegistryHttp`
 * over an in-memory bucket, rather than against a restatement of the protocol.
 */
import { readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";
import { generateSigner } from "@forgegraph/registry/artifacts";
import type { AppBundle } from "@forgegraph/runtime";
import { OciRegistry } from "../src/oci.js";
import { R2Oci, type R2Like } from "../src/r2-oci.js";
import { createRegistryHttp } from "../src/registry-http.js";

const bundle = JSON.parse(
  readFileSync(
    new URL("../../../conformance/fixtures/acme.app.json", import.meta.url),
    "utf8",
  ),
) as AppBundle;

/** Enough of the R2 binding to exercise the layout, including listing semantics. */
export function memoryBucket(): R2Like & { objects: Map<string, string> } {
  const objects = new Map<string, string>();
  return {
    objects,
    async get(key) {
      const value = objects.get(key);
      return value === undefined ? null : { text: async () => value };
    },
    async head(key) {
      return objects.has(key) ? {} : null;
    },
    async put(key, value) {
      objects.set(key, value);
      return {};
    },
    async delete(key) {
      objects.delete(key);
    },
    async list({ prefix, limit = 1000, cursor, startAfter }) {
      const keys = [...objects.keys()].filter((k) => k.startsWith(prefix)).sort();
      const after = cursor ?? startAfter;
      const from = after ? keys.findIndex((k) => k > after) : 0;
      const start = from < 0 ? keys.length : from;
      const page = keys.slice(start, start + limit);
      const truncated = start + limit < keys.length;
      return {
        objects: page.map((key) => ({ key })),
        truncated,
        ...(truncated ? { cursor: page[page.length - 1]! } : {}),
      };
    },
  };
}

function serve(bucket: R2Like, scopes = ["pull", "push"]) {
  const registry = new R2Oci({
    bucket,
    repository: "forge",
    url: "https://registry.example",
  });
  const handle = createRegistryHttp({
    registry,
    service: "registry.example",
    authorize: async () => ({ scopes }),
  });
  const requests: string[] = [];
  const fetcher: typeof fetch = async (input, init) => {
    const request = new Request(
      typeof input === "string" ? input : (input as Request).url,
      init as RequestInit,
    );
    requests.push(request.url);
    return handle(request);
  };
  return { registry, fetcher, requests };
}

describe("R2-backed OCI registry", () => {
  it("serves the real client: publish, list and digest-pinned pull round-trip", async () => {
    const bucket = memoryBucket();
    const { fetcher } = serve(bucket);
    const signer = await generateSigner("release");
    const registry = new OciRegistry({
      url: "https://registry.example",
      repository: "forge",
      authority: "independent.example",
      signer,
      fetch: fetcher,
    });

    const result = await registry.publish({
      name: "@acme/commerce",
      version: "0.1.0",
      bundle,
      owner: "Commerce",
      commit: "abc123",
    });

    expect((await registry.list())[0]?.entry.name).toBe("@acme/commerce");
    // Pinning by digest is what proves the manifest bytes survived storage unchanged.
    expect((await registry.pull(result.ociDigest)).pulled.bundle).toEqual(bundle);

    // Republishing the same version must be refused, not silently overwritten.
    await expect(
      registry.publish({
        name: "@acme/commerce",
        version: "0.1.0",
        bundle,
        owner: "Commerce",
        commit: "abc123",
      }),
    ).rejects.toThrow(/already published/i);

    const keys = [...bucket.objects.keys()];
    expect(keys.some((k) => k.startsWith("oci/forge/blobs/sha256/"))).toBe(true);
    expect(keys.some((k) => k.startsWith("oci/forge/manifests/sha256/"))).toBe(true);
    expect(keys.some((k) => k.startsWith("oci/forge/tags/forge-"))).toBe(true);
  });

  it("returns a tag and its digest byte-identically, so a pinned pull cannot drift", async () => {
    const bucket = memoryBucket();
    const { registry, fetcher } = serve(bucket);
    const body = JSON.stringify({ schemaVersion: 2, note: "verbatim" });
    await fetcher("https://registry.example/v2/forge/manifests/forge-tag", {
      method: "PUT",
      headers: { "content-type": "application/vnd.oci.image.manifest.v1+json" },
      body,
    });
    const digest = `sha256:${[...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(body)))].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
    expect(await registry.getManifest("forge-tag", 8_000_000)).toBe(body);
    expect(await registry.getManifest(digest, 8_000_000)).toBe(body);
  });

  it("uses the exact status codes and headers the client depends on", async () => {
    const bucket = memoryBucket();
    const { fetcher } = serve(bucket);
    const at = (p: string) => `https://registry.example${p}`;

    expect((await fetcher(at("/v2/"))).status).toBe(200);

    // A blob HEAD must be strictly 200 or 404; anything else is a protocol failure client-side.
    const absent = "sha256:" + "0".repeat(64);
    expect((await fetcher(at(`/v2/forge/blobs/${absent}`), { method: "HEAD" })).status).toBe(404);

    const begun = await fetcher(at("/v2/forge/blobs/uploads/"), { method: "POST" });
    expect(begun.status).toBe(202);
    const location = begun.headers.get("location");
    expect(location).toMatch(/^\/v2\/forge\/blobs\/uploads\//); // origin-absolute

    const text = "layer-bytes";
    const hex = [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)))]
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
    const put = await fetcher(at(`${location}?digest=sha256:${hex}`), {
      method: "PUT",
      headers: { "content-type": "application/octet-stream" },
      body: text,
    });
    expect(put.status).toBe(201); // exactly 201, not 200 or 204
    expect((await fetcher(at(`/v2/forge/blobs/sha256:${hex}`), { method: "HEAD" })).status).toBe(200);

    // A mismatched digest must be refused rather than stored under a name it does not have.
    const bad = await fetcher(at(`${location}?digest=sha256:${"1".repeat(64)}`), {
      method: "PUT",
      body: text,
    });
    expect(bad.status).toBe(400);

    // An absent manifest is 404, never 401 — authentication already succeeded.
    expect((await fetcher(at("/v2/forge/manifests/forge-missing"))).status).toBe(404);

    // Chunked upload is refused loudly rather than silently misbehaving.
    expect((await fetcher(at(`${location}`), { method: "PATCH", body: "x" })).status).toBe(405);

    // Another repository in the same bucket is not ours to serve.
    expect((await fetcher(at("/v2/other/tags/list"))).status).toBe(404);
  });

  it("paginates tags with a Link header the client's parser actually accepts", async () => {
    const bucket = memoryBucket();
    const { registry, fetcher } = serve(bucket);
    for (let i = 0; i < 5; i++)
      await bucket.put(registry.tagKey(`forge-${String(i).repeat(64).slice(0, 64)}`), "sha256:" + "a".repeat(64));

    const first = await fetcher("https://registry.example/v2/forge/tags/list?n=2");
    const link = first.headers.get("link") ?? "";
    // The client extracts the next URL with exactly this pattern.
    const next = link.match(/<([^>]+)>;\s*rel="next"/)?.[1];
    expect(next).toBeTruthy();
    expect(next!.startsWith("/v2/forge/tags/list")).toBe(true);
    expect((await first.json() as { tags: string[] }).tags).toHaveLength(2);

    const second = await fetcher(new URL(next!, "https://registry.example").href);
    expect((await second.json() as { tags: string[] }).tags).toHaveLength(2);
  });

  it("challenges an unauthenticated client instead of failing it opaquely", async () => {
    const bucket = memoryBucket();
    const registry = new R2Oci({ bucket, repository: "forge", url: "https://registry.example" });
    const handle = createRegistryHttp({
      registry,
      service: "registry.example",
      authorize: async () => null,
    });
    const response = await handle(new Request("https://registry.example/v2/"));
    expect(response.status).toBe(401);
    // Without this header docker cannot discover where to get a token.
    expect(response.headers.get("www-authenticate")).toMatch(
      /^Bearer realm="https:\/\/registry\.example\/v2\/token",service="registry\.example"/,
    );
  });

  it("refuses a push with a pull-only credential", async () => {
    const bucket = memoryBucket();
    const { fetcher } = serve(bucket, ["pull"]);
    const response = await fetcher("https://registry.example/v2/forge/blobs/uploads/", {
      method: "POST",
    });
    expect(response.status).toBe(403);
  });
});
