import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
const dir = mkdtempSync(join(tmpdir(), "forge-console-test-"));
// Stand-ins for ForgeGraph's contract registry and one app's API, so the Integrations tab can be
// exercised end to end. The contract is the synthetic fixture the unit tests use.
const contract = JSON.parse(readFileSync(new URL("../test/fixtures/contract-ir.json", import.meta.url), "utf8"));
const stubs = createServer((req, res) => {
  const url = new URL(req.url, "http://127.0.0.1");
  const send = (status, body) => {
    res.writeHead(status, { "content-type": "application/json", "x-request-id": "stub-1" });
    res.end(body === undefined ? "" : JSON.stringify(body));
  };
  if (url.pathname.startsWith("/api/fg/") && req.headers.authorization !== "Bearer stub-forgegraph-token")
    return send(401, { error: "unauthorized" });
  if (url.pathname === "/api/fg/apps")
    return send(200, { apps: [{ slug: "notes", name: "Notes", description: "Stub notes service", healthCheckUrl: null }, { slug: "quiet", name: "Quiet" }] });
  if (url.pathname === "/api/fg/contracts")
    return url.searchParams.get("appSlug") === "notes" ? send(200, { ir: contract }) : send(404, { error: "no contract published" });
  if (url.pathname.startsWith("/notes-api/")) {
    if (req.headers.authorization !== "Bearer stub-notes-secret") return send(401, { error: "unauthorized" });
    const id = decodeURIComponent(url.pathname.slice("/notes-api/notes/".length));
    if (req.method === "GET" && id) return send(200, { id, title: `Note ${id}`, view: url.searchParams.get("view") });
  }
  send(404, { error: "not found" });
});
await new Promise((resolve) => stubs.listen(8789, "127.0.0.1", resolve));
const key = await crypto.subtle.generateKey({ name: "Ed25519" }, true, [
  "sign",
  "verify",
]);
const settings = {
  ADMIN_TOKEN: "local-console-test-token-1234567890",
  INSTANCE_AUTHORITY: "local-forge.test",
  INSTANCE_NAME: "Forge Local",
  OCI_URL: process.env.OCI_TEST_URL ?? "http://127.0.0.1:15000",
  OCI_REPOSITORY: `console-${Date.now()}`,
  OCI_ALLOW_HTTP: "true",
  FORGEGRAPH_URL: "http://127.0.0.1:8789",
  FORGEGRAPH_TOKEN: "stub-forgegraph-token",
  INTEGRATIONS_JSON: JSON.stringify([{ app: "notes", baseUrl: "http://127.0.0.1:8789/notes-api", auth: { kind: "bearer", secret: "INTEGRATION_NOTES" } }]),
  INTEGRATION_NOTES: "stub-notes-secret",
  INTEGRATIONS_ALLOW_HTTP: "true",
  SIGNING_KEY_JWK: JSON.stringify(
    await crypto.subtle.exportKey("jwk", key.privateKey),
  ),
  DATA_PATH: join(dir, "console.sqlite"),
  HOST: "127.0.0.1",
  PORT: "8787",
};
writeFileSync(join(dir, "env.json"), JSON.stringify(settings), { mode: 0o600 });
console.log("Disposable test data:", dir);
const child = spawn(process.execPath, ["dist/server.mjs"], {
  env: { ...process.env, ...settings },
  stdio: "inherit",
});
for (const signal of ["SIGINT", "SIGTERM"])
  process.on(signal, () => {
    stubs.close();
    child.kill(signal);
  });
