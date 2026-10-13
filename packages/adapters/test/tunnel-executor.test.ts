import { expect, it } from "vitest";
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import { CloudflareTunnelApi, reconcileTunnel, type TunnelJournal, type TunnelRecord, type TunnelProvider } from "../src/tunnel-reconcile.js";
import { startTunnelConnector } from "../src/tunnel-connector-node.js";
import type { CloudflareTunnelProjection } from "../src/tunnels.js";

const id = "11111111-2222-3333-4444-555555555555";
const desired: CloudflareTunnelProjection = {
  id: "tunnel-gateway", name: "forgegraph-beta-tunnel-gateway", ownership: "managed", retain: true,
  create: { name: "forgegraph-beta-tunnel-gateway", config_src: "cloudflare" },
  config: { ingress: [{ hostname: "beta.example.com", service: "http://localhost:8080" }, { service: "http_status:404" }] },
  connector: { executable: "cloudflared", args: [], credential: { source: "external-secret-store", path: "forgegraph/beta/tunnel", file: "/run/secrets/ignored.token", mode: "0600" } },
};
function fixture() {
  let record: TunnelRecord | null = null;
  let creates = 0, updates = 0;
  let config: unknown = {};
  const journal: TunnelJournal = { exclusive: async (_key, action) => action(), read: async () => record, write: async (_key, value) => { record = value; } };
  const provider: TunnelProvider = {
    find: async () => [], create: async () => { creates++; return { id }; },
    inspect: async () => ({ id, name: desired.name, config_src: "cloudflare" }),
    configuration: async () => config, configure: async (_id: string, value: unknown) => { updates++; config = value; }, token: async () => "private-test-token",
  };
  return { journal, provider, counts: () => ({ creates, updates }), record: () => record, config: (value: unknown) => { config = value; } };
}
it("journals identity before secret failure and reconciles retries without duplicate creation", async () => {
  const f = fixture();
  await expect(reconcileTunnel(desired, { ...f, secrets: { put: async () => { throw new Error("private-test-token"); } } })).rejects.toThrow("credential could not be stored");
  expect(f.record()?.tunnelId).toBe(id);
  const credentials: string[] = [];
  const result = await reconcileTunnel(desired, { ...f, secrets: { put: async (path, value) => { expect(path).toBe(desired.connector.credential.path); credentials.push(value); } } });
  expect(f.counts()).toEqual({ creates: 1, updates: 1 });
  expect(result).toEqual({ tunnelId: id, configurationChanged: false, dns: "external", access: "external" });
  expect(JSON.stringify(result)).not.toContain(credentials[0]);
});
it("refuses orphan-name collisions and adopted rules outside the declared ingress scope", async () => {
  const f = fixture();
  f.provider.find = async () => [{ id }];
  await expect(reconcileTunnel(desired, { ...f, secrets: { put: async () => {} } })).rejects.toThrow("explicit adoption");
  f.config({ ingress: [{ hostname: "production.example.com", service: "http://localhost:9000" }, { service: "http_status:404" }] });
  await expect(reconcileTunnel({ ...desired, ownership: "adopted", tunnelId: id }, { ...f, secrets: { put: async () => {} } })).rejects.toThrow("outside the declared ownership");
  expect(f.counts()).toEqual({ creates: 0, updates: 0 });
});
it("adopts remote tunnels but refuses local-management mode and changed journal ownership", async () => {
  const f = fixture();
  f.config(desired.config);
  await reconcileTunnel({ ...desired, ownership: "adopted", tunnelId: id }, { ...f, secrets: { put: async () => {} } });
  expect(f.counts()).toEqual({ creates: 0, updates: 0 });
  await expect(reconcileTunnel(desired, { ...f, secrets: { put: async () => {} } })).rejects.toThrow("ownership");
  f.provider.inspect = async () => ({ id, name: desired.name, config_src: "local" });
  await expect(reconcileTunnel({ ...desired, ownership: "adopted", tunnelId: id }, { ...f, secrets: { put: async () => {} } })).rejects.toThrow("management mode");
});
it("preserves provider settings and treats reordered configuration as unchanged", async () => {
  const f = fixture();
  f.config({ "warp-routing": { enabled: false }, ingress: [{ service: "http://localhost:8080", hostname: "beta.example.com" }, { service: "http_status:404" }] });
  const result = await reconcileTunnel({ ...desired, ownership: "adopted", tunnelId: id }, { ...f, secrets: { put: async () => {} } });
  expect(result.configurationChanged).toBe(false);
  expect(f.counts().updates).toBe(0);
});
it("calls Cloudflare with private credentials, bounded requests and sanitized API errors", async () => {
  const requests: { url: string; method: string; body?: unknown }[] = [];
  let failure = false;
  const api = new CloudflareTunnelApi({ accountId: "a".repeat(32), apiToken: async () => "api-secret", fetch: async (input, init) => {
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer api-secret");
    expect(init?.redirect).toBe("error");
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    requests.push({ url: String(input), method: init?.method ?? "GET", ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}) });
    return failure ? new Response("api-secret", { status: 403 }) : Response.json({ success: true, result: { id } });
  } });
  await api.create(desired.name);
  expect(requests[0]?.body).toEqual({ name: desired.name, config_src: "cloudflare" });
  await api.configure(id, desired.config);
  expect(requests[1]?.body).toEqual({ config: desired.config });
  failure = true;
  await expect(api.token(id)).rejects.toThrow(/^Cloudflare tunnel HTTP 403$/);
  expect(() => api.inspect("bad/id")).toThrow("Invalid tunnel ID");
});
async function port() {
  const server = createServer();
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const value = (server.address() as { port: number }).port;
  await new Promise<void>(resolve => server.close(() => resolve()));
  return value;
}
it("starts an actual child with a private token file and cleans up on abort and failed startup", async () => {
  const directory = await mkdtemp(join(tmpdir(), "forge-connector-test-"));
  const executable = join(directory, "fake-cloudflared");
  await writeFile(executable, `#!${process.execPath}
const fs=require('node:fs'),http=require('node:http');
const args=process.argv.slice(2),file=args[args.indexOf('--token-file')+1];
fs.writeFileSync(${JSON.stringify(join(directory, "observed.json"))},JSON.stringify({pid:process.pid,args,file,mode:fs.statSync(file).mode&511,parentMode:fs.statSync(require('node:path').dirname(file)).mode&511}));
process.on('SIGTERM',()=>{});
http.createServer((req,res)=>{res.writeHead(200);res.end('ready')}).listen(Number(args[args.indexOf('--metrics')+1].split(':')[1]),'127.0.0.1');
`, { mode: 0o700 });
  const controller = new AbortController();
  try {
    const metricsPort = await port();
    const connector = await startTunnelConnector(desired, { secret: async () => "connector-secret", metricsPort, executable, temporaryDirectory: directory, signal: controller.signal, stopTimeoutMs: 50 });
    const observed = JSON.parse(await readFile(join(directory, "observed.json"), "utf8"));
    expect(observed.mode).toBe(0o600);
    expect(observed.parentMode).toBe(0o700);
    expect(JSON.stringify(observed.args)).not.toContain("connector-secret");
    expect(await readFile(observed.file, "utf8")).toBe("connector-secret");
    expect(await connector.ready()).toBe(true);
    await expect(startTunnelConnector(desired, { secret: async () => "connector-secret", metricsPort, executable, temporaryDirectory: directory })).rejects.toThrow("metrics port unavailable");
    controller.abort();
    expect((await connector.exited).signal).toBe("SIGKILL");
    await connector.stop();
    await expect(stat(observed.file)).rejects.toThrow();
    // Owner-controlled restart after an unexpected crash; each launch gets a new file.
    const recovered = await startTunnelConnector(desired, { secret: async () => "connector-secret", metricsPort, executable, temporaryDirectory: directory, stopTimeoutMs: 50 });
    const recovery = JSON.parse(await readFile(join(directory, "observed.json"), "utf8"));
    expect(recovery.file).not.toBe(observed.file);
    process.kill(recovery.pid, "SIGKILL");
    await recovered.exited;
    expect(await recovered.ready()).toBe(false);
    await expect(stat(recovery.file)).rejects.toThrow();
    await expect(startTunnelConnector(desired, { secret: async () => "connector-secret", metricsPort: await port(), executable: join(directory, "missing"), temporaryDirectory: directory })).rejects.toThrow("could not start");
    expect((await readdir(directory)).filter(name => name.startsWith("forge-tunnel-"))).toEqual([]);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
