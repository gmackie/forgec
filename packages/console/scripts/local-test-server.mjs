import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const dir = mkdtempSync(join(tmpdir(), "forge-console-test-"));
const key = await crypto.subtle.generateKey({ name: "Ed25519" }, true, [
  "sign",
  "verify",
]);
const settings = {
  ADMIN_TOKEN: "local-console-test-token-1234567890",
  INSTANCE_AUTHORITY: "local-forge.test",
  INSTANCE_NAME: "Forge Local",
  OCI_URL: "http://127.0.0.1:15000",
  OCI_REPOSITORY: `console-${Date.now()}`,
  OCI_ALLOW_HTTP: "true",
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
  process.on(signal, () => child.kill(signal));
