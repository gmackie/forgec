import { spawn } from "node:child_process";
import { mkdtemp, chmod, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createServer } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import type { CloudflareTunnelProjection } from "./tunnels.js";

export interface TunnelConnector {
  /** Observed child termination; credentials are removed before this resolves. */
  exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  ready(): Promise<boolean>;
  stop(): Promise<void>;
}
/** One supervised connector. The owner may restart after exited; no unbounded restart loop. */
export async function startTunnelConnector(
  desired: CloudflareTunnelProjection,
  options: {
    secret: (path: string) => Promise<string>;
    metricsPort: number;
    signal?: AbortSignal;
    startupTimeoutMs?: number;
    stopTimeoutMs?: number;
    /** Trusted operator configuration, never a value from an app request. */
    executable?: string;
    temporaryDirectory?: string;
    fetch?: typeof fetch;
  },
): Promise<TunnelConnector> {
  const startupTimeoutMs = options.startupTimeoutMs ?? 30_000;
  const stopTimeoutMs = options.stopTimeoutMs ?? 5_000;
  if (!Number.isInteger(options.metricsPort) || options.metricsPort < 1 || options.metricsPort > 65535 ||
    !Number.isFinite(startupTimeoutMs) || startupTimeoutMs < 1 || startupTimeoutMs > 300_000 ||
    !Number.isFinite(stopTimeoutMs) || stopTimeoutMs < 1 || stopTimeoutMs > 30_000) throw new Error("Invalid connector lifecycle limits");
  if (options.signal?.aborted) throw new Error("Tunnel connector start cancelled");
  if (options.executable !== undefined && (!options.executable || options.executable.includes("\0"))) throw new Error("Invalid connector executable");
  // An occupied metrics port could report a different connector's readiness.
  const probe = createServer();
  try {
    await new Promise<void>((resolve, reject) => {
      probe.once("error", reject);
      probe.listen({ port: options.metricsPort, host: "127.0.0.1", exclusive: true }, resolve);
    });
    await new Promise<void>((resolve, reject) => probe.close(error => error ? reject(error) : resolve()));
  } catch { throw new Error("Tunnel connector metrics port unavailable"); }
  let token: string;
  try { token = await options.secret(desired.connector.credential.path); }
  catch { throw new Error("Tunnel connector credential unavailable"); }
  if (typeof token !== "string" || !token || token.length > 16_384 || /[\s\x00-\x1f]/.test(token)) throw new Error("Invalid tunnel connector credential");
  if (options.signal?.aborted) throw new Error("Tunnel connector start cancelled");
  const directory = await mkdtemp(join(options.temporaryDirectory ?? tmpdir(), "forge-tunnel-"));
  const file = join(directory, "connector.token");
  try {
    await chmod(directory, 0o700);
    await writeFile(file, token, { mode: 0o600, flag: "wx" });
  } catch {
    await rm(directory, { recursive: true, force: true });
    throw new Error("Tunnel connector credential file unavailable");
  }
  // Token never appears in argv, environment, child logs or returned evidence.
  const child = spawn(options.executable ?? "cloudflared", [
    "tunnel", "--no-autoupdate", "--metrics", `127.0.0.1:${options.metricsPort}`,
    "run", "--token-file", file,
  ], { stdio: "ignore", shell: false });
  let finished = false;
  let spawnFailed = false;
  child.once("error", () => { spawnFailed = true; });
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    child.once("close", async (code, signal) => {
      finished = true;
      options.signal?.removeEventListener("abort", abort);
      try {
        await rm(directory, { recursive: true, force: true });
        resolve({ code, signal });
      } catch { reject(new Error("Tunnel connector credential cleanup failed")); }
    });
  });
  let stopping: Promise<void> | undefined;
  function stop(): Promise<void> {
    return stopping ??= (async () => {
      if (!finished) {
        child.kill("SIGTERM");
        const timer = setTimeout(() => { if (!finished) child.kill("SIGKILL"); }, stopTimeoutMs);
        try { await exited; } finally { clearTimeout(timer); }
      } else await exited;
    })();
  }
  const abort = () => { void stop().catch(() => {}); };
  options.signal?.addEventListener("abort", abort, { once: true });
  if (options.signal?.aborted) abort();
  async function ready(): Promise<boolean> {
    if (finished || stopping) return false;
    try {
      const response = await (options.fetch ?? fetch)(`http://127.0.0.1:${options.metricsPort}/ready`, {
        redirect: "error", signal: AbortSignal.timeout(1_000),
      });
      await response.body?.cancel();
      return response.status === 200 && !finished && !stopping;
    } catch { return false; }
  }
  const deadline = Date.now() + startupTimeoutMs;
  while (Date.now() < deadline && !finished && !stopping) {
    if (await ready()) return { exited, ready, stop };
    await Promise.race([delay(100), exited]);
  }
  await stop();
  throw new Error(spawnFailed ? "Tunnel connector could not start" : "Tunnel connector did not become ready");
}
