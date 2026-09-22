import { request } from "node:http";
import type {
  Provider,
  RunnerRelease,
  RunnerTarget,
  Instance,
} from "./controller.js";
export class DockerProvider implements Provider {
  constructor(private readonly socket = "/var/run/docker.sock") {}
  private call(method: string, path: string, body?: unknown): Promise<any> {
    return new Promise((resolve, reject) => {
      const req = request(
        {
          socketPath: this.socket,
          path: "/v1.47" + path,
          method,
          headers: { "content-type": "application/json" },
          timeout: 30000,
        },
        (res) => {
          let text = "";
          res.on("data", (chunk) => {
            text += chunk;
            if (text.length > 2_000_000)
              req.destroy(Error("Docker response too large"));
          });
          res.on("end", () => {
            if ((res.statusCode || 500) >= 400 && res.statusCode !== 304)
              return reject(
                Error(
                  `Docker request failed (${res.statusCode}). Check the runner log.`,
                ),
              );
            try {
              resolve(text ? JSON.parse(text) : null);
            } catch {
              reject(Error("Invalid Docker response"));
            }
          });
        },
      );
      req.on("timeout", () => req.destroy(Error("Docker request timed out")));
      req.on("error", reject);
      if (body) req.write(JSON.stringify(body));
      req.end();
    });
  }
  private async healthy(instance: Instance, path = "/healthz") {
    for (let n = 0; n < 30; n++) {
      try {
        const r = await fetch(instance.url + path, {
          redirect: "manual",
          signal: AbortSignal.timeout(2000),
        });
        await r.body?.cancel();
        if (r.ok) return;
      } catch {}
      await new Promise((r) => setTimeout(r, 1000));
    }
    throw Error("Candidate did not become healthy within 30 seconds.");
  }
  async reconcile(target: string, active: Instance | null) {
    const filters = encodeURIComponent(
      JSON.stringify({
        label: ["forge.managed=true", `forge.target=${target}`],
      }),
    );
    const containers = await this.call(
      "GET",
      `/containers/json?all=true&filters=${filters}`,
    );
    for (const container of containers)
      if (container.Id !== active?.handle)
        await this.call(
          "DELETE",
          `/containers/${encodeURIComponent(container.Id)}?force=true`,
        );
  }
  async deploy(
    release: RunnerRelease,
    id: string,
    target: RunnerTarget,
  ): Promise<Instance> {
    // Images are installed by the release pipeline, and only configured immutable image IDs are accepted.
    if (
      !/^sha256:[a-f0-9]{64}$/.test(release.image || "") &&
      !/@sha256:[a-f0-9]{64}$/.test(release.image || "")
    )
      throw Error("Docker releases must use immutable image digests.");
    const name = `forge-managed-${target.id}-${id.slice(0, 8)}`;
    const created = await this.call("POST", `/containers/create?name=${name}`, {
      Image: release.image,
      Env: Object.entries(target.environment || {}).map(
        ([k, v]) => `${k}=${v}`,
      ),
      Labels: {
        "forge.managed": "true",
        "forge.target": target.id,
        "forge.release": release.id,
      },
      HostConfig: {
        NetworkMode: target.network || "forge-console_default",
        ReadonlyRootfs: true,
        Tmpfs: { "/tmp": "rw,noexec,nosuid,size=67108864" },
        RestartPolicy: { Name: "unless-stopped" },
        Memory: 268435456,
        NanoCpus: 1000000000,
        CapDrop: ["ALL"],
        SecurityOpt: ["no-new-privileges:true"],
      },
    });
    const instance = {
      handle: created.Id,
      url: `http://${name}:${target.port || 8080}`,
      healthPath: target.healthPath || "/healthz",
    };
    try {
      await this.call("POST", `/containers/${created.Id}/start`);
      await this.healthy(instance, target.healthPath || "/healthz");
      return instance;
    } catch (e) {
      try {
        await this.call("DELETE", `/containers/${created.Id}?force=true`);
      } catch {}
      throw e;
    }
  }
  async stop(instance: Instance) {
    await this.call(
      "POST",
      `/containers/${encodeURIComponent(instance.handle)}/stop?t=15`,
    );
  }
  async restart(instance: Instance) {
    await this.call(
      "POST",
      `/containers/${encodeURIComponent(instance.handle)}/restart?t=15`,
    );
    await this.healthy(instance, instance.healthPath);
  }
}
