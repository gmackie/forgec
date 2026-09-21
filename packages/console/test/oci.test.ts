import { readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";
import { generateSigner, digestOf } from "@forgegraph/registry/artifacts";
import type { AppBundle } from "@forgegraph/runtime";
import { OciRegistry } from "../src/oci.js";
const bundle = JSON.parse(
  readFileSync(
    new URL("../../../conformance/fixtures/acme.app.json", import.meta.url),
    "utf8",
  ),
) as AppBundle;
// Protocol fixture: enforces OCI upload/digest semantics rather than mocking domain methods.
function distribution() {
  const blobs = new Map<string, string>(),
    manifests = new Map<string, string>();
  const requests: string[] = [];
  const fetcher: typeof fetch = async (input, init) => {
    if (init?.redirect === "error")
      throw new TypeError("Workers does not implement redirect:error");
    const req = new Request(input, init),
      u = new URL(req.url);
    requests.push(req.url);
    const tail = u.pathname.replace("/v2/forge/", "");
    if (tail === "tags/list")
      return Response.json({
        name: "forge",
        tags: [...manifests.keys()].filter((x) => !x.startsWith("sha256:")),
      });
    if (tail === "blobs/uploads/" && req.method === "POST")
      return new Response(null, {
        status: 202,
        headers: { Location: "/v2/forge/blobs/uploads/1" },
      });
    if (tail === "blobs/uploads/1" && req.method === "PUT") {
      const text = await req.text(),
        digest = u.searchParams.get("digest")!;
      if (digestOf(text) !== digest) return new Response(null, { status: 400 });
      blobs.set(digest, text);
      return new Response(null, { status: 201 });
    }
    const [kind, ref] = tail.split("/");
    const map = kind === "blobs" ? blobs : manifests;
    if (req.method === "PUT") {
      const text = await req.text();
      map.set(ref!, text);
      map.set(digestOf(text), text);
      return new Response(null, { status: 201 });
    }
    const text = map.get(ref!);
    return new Response(req.method === "HEAD" ? null : (text ?? null), {
      status: text ? 200 : 404,
    });
  };
  return { blobs, manifests, requests, fetcher };
}
describe("OCI registry", () => {
  it("stores signed artifacts and metadata as standard OCI manifests, with verified digest-pinned pulls", async () => {
    const server = distribution(),
      signer = await generateSigner("release");
    const registry = new OciRegistry({
      url: "https://registry.example",
      repository: "forge",
      authority: "independent.example",
      signer,
      fetch: server.fetcher,
    });
    const result = await registry.publish({
      name: "@acme/commerce",
      version: "0.1.0",
      bundle,
      owner: "Commerce",
      commit: "abc123",
    });
    const manifest = JSON.parse(server.manifests.get(result.ociDigest)!);
    expect(manifest.schemaVersion).toBe(2);
    expect(manifest.mediaType).toBe(
      "application/vnd.oci.image.manifest.v1+json",
    );
    expect(manifest.artifactType).toBe("application/vnd.forgegraph.package.v1");
    expect((await registry.list())[0]?.entry.name).toBe("@acme/commerce");
    expect((await registry.pull(result.ociDigest)).pulled.bundle).toEqual(
      bundle,
    );
    expect(
      server.requests.every((u) => u.startsWith("https://registry.example/")),
    ).toBe(true);
    server.blobs.set(manifest.layers[0].digest, "{}");
    await expect(registry.pull(result.ociDigest)).rejects.toThrow(/digest/i);
  });
  it("refuses version replacement and never sends credentials to an off-origin upload location", async () => {
    const server = distribution(),
      signer = await generateSigner("release");
    const options = {
      url: "https://registry.example",
      repository: "forge",
      authority: "independent.example",
      signer,
      fetch: server.fetcher,
    };
    const registry = new OciRegistry(options);
    await registry.publish({
      name: "commerce",
      version: "1.0.0",
      bundle,
      owner: "",
      commit: "a",
    });
    await expect(
      registry.publish({
        name: "commerce",
        version: "1.0.0",
        bundle,
        owner: "",
        commit: "b",
      }),
    ).rejects.toThrow(/already|immutable/i);
    const hostile = new OciRegistry({
      ...options,
      authorization: "Bearer private",
      fetch: async () =>
        new Response(null, {
          status: 202,
          headers: { Location: "https://attacker.example/upload" },
        }),
    });
    await expect(
      hostile.publish({
        name: "other",
        version: "1.0.0",
        bundle,
        owner: "",
        commit: "c",
      }),
    ).rejects.toThrow();
  });
});
it("follows allowed object-storage blob redirects without sending registry credentials", async () => {
  const server = distribution(),
    signer = await generateSigner("release");
  const registry = new OciRegistry({
    url: "https://registry.example",
    repository: "forge",
    authority: "independent.example",
    signer,
    fetch: server.fetcher,
  });
  const published = await registry.publish({
    name: "commerce",
    version: "1.0.0",
    owner: "",
    commit: "test",
    bundle,
  });
  const credentials: (string | null)[] = [];
  const redirected: typeof fetch = async (input, init) => {
    const req = new Request(input, init),
      url = new URL(req.url);
    if (url.origin === "https://storage.example") {
      credentials.push(req.headers.get("authorization"));
      const text = server.blobs.get(url.pathname.slice(1));
      return new Response(req.method === "HEAD" ? null : (text ?? null), {
        status: text ? 200 : 404,
      });
    }
    if (url.pathname.includes("/blobs/sha256:"))
      return new Response(null, {
        status: 307,
        headers: {
          location: `https://storage.example/${url.pathname.split("/").at(-1)}`,
        },
      });
    return server.fetcher(input, init);
  };
  const reader = new OciRegistry({
    url: "https://registry.example",
    repository: "forge",
    authority: "independent.example",
    signer,
    fetch: redirected,
    authorization: "Bearer secret",
    blobHosts: ["storage.example"],
  });
  expect((await reader.pull(published.ociDigest)).pulled.bundle).toEqual(
    bundle,
  );
  await reader.publish({
    name: "commerce",
    version: "1.1.0",
    owner: "",
    commit: "next",
    bundle,
  });
  expect(credentials.length).toBeGreaterThan(0);
  expect(credentials.every((v) => v === null)).toBe(true);
});
