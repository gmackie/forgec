import { readFile, mkdir, writeFile, readdir, unlink } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type {
  Provider,
  RunnerTarget,
  RunnerRelease,
  Instance,
} from "./controller.js";
const exec = promisify(execFile);
let authQueue: Promise<unknown> = Promise.resolve();
/** Let Wrangler own OAuth refresh and credential persistence. Never include its output in errors. */
export function cloudflareToken(): Promise<string> {
  const work = authQueue.then(async () => {
    if (process.env.CLOUDFLARE_API_TOKEN)
      return process.env.CLOUDFLARE_API_TOKEN;
    try {
      const { stdout } = await exec("wrangler", ["auth", "token", "--json"], {
        timeout: 60000,
        maxBuffer: 100000,
        env: { ...process.env, WRANGLER_SEND_METRICS: "false", CI: "true" },
      });
      const value = JSON.parse(stdout);
      if (typeof value.token !== "string" || !value.token) throw Error();
      return value.token as string;
    } catch {
      throw Error(
        "Cloudflare authentication unavailable. Run wrangler login for the runner credential profile.",
      );
    }
  });
  authQueue = work.catch(() => {});
  return work;
}
export class CloudflareProvider implements Provider {
  constructor(
    private readonly token: () => Promise<string> = cloudflareToken,
    private readonly fetcher: typeof fetch = fetch,
    private readonly probe: (i: Instance) => Promise<void> = async (i) => {
      for (let n = 0; n < 45; n++) {
        try {
          const res = await fetch(i.url + (i.healthPath || "/healthz"), {
            redirect: "manual",
            signal: AbortSignal.timeout(3000),
          });
          await res.body?.cancel();
          if (res.ok) return;
        } catch {}
        await new Promise((r) => setTimeout(r, 2000));
      }
      throw Error(
        "Worker did not become healthy within the deployment deadline.",
      );
    },
    private readonly journal?: string,
  ) {}
  private async call(
    account: string,
    path: string,
    method = "GET",
    body?: FormData | Record<string, unknown>,
  ) {
    const response = await this.fetcher(
      "https://api.cloudflare.com/client/v4/accounts/" +
        account +
        "/workers/" +
        path,
      {
        method,
        redirect: "error",
        signal: AbortSignal.timeout(60000),
        headers: {
          authorization: "Bearer " + (await this.token()),
          ...(body instanceof FormData
            ? {}
            : { "content-type": "application/json" }),
        },
        ...(body
          ? { body: body instanceof FormData ? body : JSON.stringify(body) }
          : {}),
      },
    );
    if (method === "DELETE" && response.status === 404) return;
    const data = (await response.json()) as any;
    if (!response.ok || data.success === false)
      throw Error(
        "Cloudflare request failed (" +
          response.status +
          "). Verify Workers permissions and configured bindings.",
      );
    return data.result;
  }
  private owned(i: Instance) {
    if (
      i.kind !== "cloudflare" ||
      !i.accountId ||
      !/^[a-f0-9]{32}$/.test(i.accountId) ||
      !/^forge-[a-z0-9-]+-[a-f0-9]{32}$/.test(i.handle)
    )
      throw Error("Invalid owned Worker identity");
  }
  private async enabled(i: Instance, enabled: boolean) {
    this.owned(i);
    await this.call(
      i.accountId!,
      "scripts/" + i.handle + "/subdomain",
      "POST",
      { enabled, previews_enabled: false },
    );
  }
  async deploy(
    release: RunnerRelease,
    id: string,
    target: RunnerTarget,
  ): Promise<Instance> {
    const config = target.cloudflare;
    if (
      !config ||
      !/^[a-f0-9]{32}$/.test(config.accountId) ||
      !/^forge-[a-z0-9-]{1,20}$/.test(config.prefix) ||
      !/^[a-z0-9-]+$/.test(config.subdomain)
    )
      throw Error("Invalid Cloudflare target");
    if (!release.module || !release.moduleDigest)
      throw Error("Worker release requires a module and digest");
    const source = await readFile(release.module);
    if (
      "sha256:" + createHash("sha256").update(source).digest("hex") !==
      release.moduleDigest
    )
      throw Error("Worker module digest mismatch");
    const suffix = id.replace(/-/g, "");
    if (!/^[a-f0-9]{32}$/.test(suffix)) throw Error("Invalid deployment ID");
    const name = config.prefix + "-" + suffix;
    const instance: Instance = {
      kind: "cloudflare",
      accountId: config.accountId,
      handle: name,
      url: "https://" + name + "." + config.subdomain + ".workers.dev",
      healthPath: target.healthPath || "/healthz",
    };
    const bindings = [...(config.bindings || [])];
    for (const [key, value] of Object.entries(target.environment || {})) {
      if (bindings.some((b) => b.name === key))
        throw Error(
          "Configuration conflicts with a protected Cloudflare binding",
        );
      bindings.push({ name: key, type: "secret_text", text: value });
    }
    const form = new FormData();
    form.set(
      "metadata",
      JSON.stringify({
        main_module: "worker.mjs",
        compatibility_date: config.compatibilityDate || "2026-09-21",
        compatibility_flags: ["nodejs_compat"],
        bindings,
        tags: ["forge-managed", target.id],
      }),
    );
    form.set(
      "worker.mjs",
      new Blob([source], { type: "application/javascript+module" }),
      "worker.mjs",
    );
    const directory = this.journal ? join(this.journal, target.id) : undefined;
    const file = directory ? join(directory, suffix + ".json") : undefined;
    if (file) {
      await mkdir(directory!, { recursive: true });
      await writeFile(file, JSON.stringify(instance), { mode: 0o600 });
    }
    try {
      await this.call(config.accountId, "scripts/" + name, "PUT", form);
      await this.enabled(instance, true);
      await this.probe(instance);
      return instance;
    } catch (e) {
      try {
        await this.call(config.accountId, "scripts/" + name, "DELETE");
        if (file) await unlink(file);
      } catch {}
      throw e;
    }
  }
  async retire(instance: Instance) {
    this.owned(instance);
    await this.call(
      instance.accountId!,
      "scripts/" + instance.handle,
      "DELETE",
    );
  }
  async stop(instance: Instance) {
    await this.enabled(instance, false);
  }
  async restart(instance: Instance, options?: { wasStopped: boolean }) {
    try {
      await this.enabled(instance, true);
      await this.probe(instance);
    } catch (e) {
      if (options?.wasStopped) await this.enabled(instance, false);
      throw e;
    }
  }
  async reconcile(
    target: RunnerTarget,
    retained: Instance | null,
    paused = false,
  ) {
    if (retained && paused) await this.enabled(retained, false);
    if (!this.journal) return;
    const directory = join(this.journal, target.id);
    await mkdir(directory, { recursive: true });
    for (const file of await readdir(directory)) {
      if (!/^[a-f0-9]{32}\.json$/.test(file)) continue;
      const path = join(directory, file);
      const instance = JSON.parse(await readFile(path, "utf8")) as Instance;
      this.owned(instance);
      if (
        instance.accountId !== target.cloudflare?.accountId ||
        !instance.handle.startsWith(target.cloudflare?.prefix + "-")
      )
        throw Error("Worker ownership journal mismatch");
      if (instance.handle === retained?.handle) continue;
      await this.call(
        instance.accountId!,
        "scripts/" + instance.handle,
        "DELETE",
      );
      await unlink(path);
    }
  }
}
