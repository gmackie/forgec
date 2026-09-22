import { it, expect } from "vitest";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { CloudflareProvider } from "../src/runner/cloudflare.js";
it("uploads a digest-verified module with secret bindings and controls only its owned Worker", async () => {
  const dir = await mkdtemp(join(tmpdir(), "forge-cf-"));
  const module = join(dir, "worker.mjs");
  const source = "export default {fetch(){return Response.json({ok:true})}}";
  await writeFile(module, source);
  const calls: { url: string; init?: RequestInit }[] = [];
  const fetcher: typeof fetch = async (url, init) => {
    calls.push({ url: String(url), ...(init ? { init } : {}) });
    return Response.json({ success: true, result: {} });
  };
  const provider = new CloudflareProvider(
    async () => "private-token",
    fetcher,
    async () => {},
  );
  const target = {
    id: "demo",
    name: "Demo",
    kind: "cloudflare" as const,
    cloudflare: {
      accountId: "a".repeat(32),
      subdomain: "demo-account",
      prefix: "forge-demo",
    },
    environment: { RUNTIME_TOKEN: "private-runtime" },
    releases: [],
  };
  const release = {
    id: "v1",
    name: "1",
    artifact: "sha256:contract",
    createdAt: "now",
    module,
    moduleDigest: "sha256:" + createHash("sha256").update(source).digest("hex"),
  };
  const instance = await provider.deploy(
    release,
    "12345678-1234-1234-1234-123456789012",
    target,
  );
  expect(instance.url).toBe(
    "https://forge-demo-12345678123412341234123456789012.demo-account.workers.dev",
  );
  const upload = calls.find((c) => c.init?.method === "PUT")!;
  const form = upload.init!.body as FormData;
  expect(JSON.parse(String(form.get("metadata")))).toMatchObject({
    main_module: "worker.mjs",
    bindings: [
      { name: "RUNTIME_TOKEN", type: "secret_text", text: "private-runtime" },
    ],
  });
  await provider.stop(instance);
  expect(JSON.parse(String(calls.at(-1)?.init?.body))).toMatchObject({
    enabled: false,
  });
  await provider.restart(instance);
  expect(JSON.parse(String(calls.at(-1)?.init?.body))).toMatchObject({
    enabled: true,
  });
  await writeFile(module, "tampered");
  await expect(provider.deploy(release, "other", target)).rejects.toThrow(
    /digest/i,
  );
  expect(calls.filter((c) => c.init?.method === "PUT")).toHaveLength(1);
  await rm(dir, { recursive: true });
});
it("cleans interrupted candidates but retains the active paused Worker", async () => {
  const dir = await mkdtemp(join(tmpdir(), "forge-cf-recovery-"));
  const { mkdir } = await import("node:fs/promises");
  await mkdir(join(dir, "demo"));
  const active = {
    kind: "cloudflare" as const,
    accountId: "a".repeat(32),
    handle: "forge-demo-" + "1".repeat(32),
    url: "https://active.example",
  };
  const orphan = { ...active, handle: "forge-demo-" + "2".repeat(32) };
  await writeFile(
    join(dir, "demo", "1".repeat(32) + ".json"),
    JSON.stringify(active),
  );
  await writeFile(
    join(dir, "demo", "2".repeat(32) + ".json"),
    JSON.stringify(orphan),
  );
  const deleted: string[] = [];
  const provider = new CloudflareProvider(
    async () => "secret",
    async (url, init) => {
      if (init?.method === "DELETE") deleted.push(String(url));
      return Response.json({ success: true, result: {} });
    },
    async () => {},
    dir,
  );
  await provider.reconcile(
    {
      id: "demo",
      name: "Demo",
      releases: [],
      cloudflare: {
        accountId: "a".repeat(32),
        prefix: "forge-demo",
        subdomain: "example",
      },
    },
    active,
  );
  expect(deleted).toHaveLength(1);
  expect(deleted[0]).toContain(orphan.handle);
  await rm(dir, { recursive: true });
});
it("removes an unhealthy upload and reports no credentials in provider errors", async () => {
  const dir = await mkdtemp(join(tmpdir(), "forge-cf-failure-"));
  const module = join(dir, "worker.mjs");
  await writeFile(module, "source");
  const calls: string[] = [];
  const provider = new CloudflareProvider(
    async () => "never-disclose",
    async (url, init) => {
      calls.push(init?.method || "GET");
      return Response.json({ success: true, result: {} });
    },
    async () => {
      throw Error("Health check failed");
    },
  );
  await expect(
    provider.deploy(
      {
        id: "v1",
        name: "1",
        artifact: "contract",
        createdAt: "now",
        module,
        moduleDigest:
          "sha256:" + createHash("sha256").update("source").digest("hex"),
      },
      "3".repeat(32),
      {
        id: "demo",
        name: "Demo",
        releases: [],
        cloudflare: {
          accountId: "a".repeat(32),
          prefix: "forge-demo",
          subdomain: "example",
        },
      },
    ),
  ).rejects.toThrow("Health check failed");
  expect(calls).toEqual(["PUT", "POST", "DELETE"]);
  await rm(dir, { recursive: true });
});
it("restores a paused endpoint when resume health fails and reconciles interrupted resumes", async () => {
  const toggles: boolean[] = [];
  const instance = {
    kind: "cloudflare" as const,
    accountId: "a".repeat(32),
    handle: "forge-demo-" + "1".repeat(32),
    url: "https://active.example",
  };
  const dir = await mkdtemp(join(tmpdir(), "forge-cf-resume-"));
  const { mkdir } = await import("node:fs/promises");
  await mkdir(join(dir, "demo"));
  await writeFile(
    join(dir, "demo", "1".repeat(32) + ".json"),
    JSON.stringify(instance),
  );
  const provider = new CloudflareProvider(
    async () => "secret",
    async (_url, init) => {
      if (init?.method === "POST")
        toggles.push(JSON.parse(String(init.body)).enabled);
      return Response.json({ success: true, result: {} });
    },
    async () => {
      throw Error("Health check failed");
    },
    dir,
  );
  await expect(
    provider.restart(instance, { wasStopped: true }),
  ).rejects.toThrow("Health check failed");
  expect(toggles).toEqual([true, false]);
  toggles.length = 0;
  await provider.reconcile(
    {
      id: "demo",
      name: "Demo",
      releases: [],
      cloudflare: {
        accountId: "a".repeat(32),
        prefix: "forge-demo",
        subdomain: "example",
      },
    },
    instance,
    true,
  );
  expect(toggles).toEqual([false]);
  await rm(dir, { recursive: true });
});
