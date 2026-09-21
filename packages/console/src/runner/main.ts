import { createServer } from "node:http";
import { readFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { timingSafeEqual } from "node:crypto";
import { DeploymentController, type RunnerTarget } from "./controller.js";
import { DockerProvider } from "./docker.js";
import { Problem } from "../model.js";
const token = process.env.RUNNER_TOKEN;
if (!token || token.length < 32)
  throw Error("Set RUNNER_TOKEN (32+ characters)");
const targets = JSON.parse(
  await readFile(
    process.env.RUNNER_TARGETS_FILE || "/config/targets.json",
    "utf8",
  ),
) as RunnerTarget[];
const ids = new Set();
for (const t of targets) {
  if (!/^[a-z0-9-]+$/.test(t.id) || ids.has(t.id) || !Array.isArray(t.releases))
    throw Error("Invalid runner target");
  ids.add(t.id);
  if (new Set(t.releases.map((r) => r.id)).size !== t.releases.length)
    throw Error("Duplicate release IDs");
}
const database = process.env.RUNNER_DB || "/data/deployments.sqlite";
await mkdir(dirname(database), { recursive: true });
const db = new DatabaseSync(database);
const provider = new DockerProvider(process.env.DOCKER_SOCKET);
const controller = new DeploymentController(db, targets, provider);
for (const target of targets)
  await provider.reconcile(target.id, controller.retainedInstance(target.id));
createServer(async (req, res) => {
  const respond = (status: number, data: unknown) => {
    res.writeHead(status, {
      "content-type": "application/json",
      "cache-control": "no-store",
    });
    res.end(JSON.stringify(data));
  };
  try {
    const path = new URL(req.url || "/", "http://runner").pathname;
    if (path === "/healthz") return respond(200, { status: "ok" });
    const runtime = path.match(/^\/runtime\/([a-z0-9-]+)(\/.*)$/);
    if (runtime) {
      const headers: Record<string, string> = {};
      for (const name of [
        "authorization",
        "content-type",
        "x-forge-purpose",
        "idempotency-key",
        "x-forge-if-build",
      ]) {
        const v = req.headers[name];
        if (typeof v === "string") headers[name] = v;
      }
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of req) {
        size += chunk.length;
        if (size > 1_000_000) throw new Problem(413, "Input is too large.");
        chunks.push(chunk);
      }
      const revision = controller.inspect(runtime[1]!).activeDeployment;
      if (
        req.headers["x-forge-if-deployment"] &&
        req.headers["x-forge-if-deployment"] !== revision
      )
        return respond(409, {
          code: "DeploymentChanged",
          detail: "Reload the runtime contract before invoking.",
        });
      const instance = controller.runtime(runtime[1]!);
      if (!instance)
        return respond(503, {
          code: "Unavailable",
          detail: "App is not running",
        });
      const response = await fetch(
        instance.url + runtime[2] + new URL(req.url!, "http://runner").search,
        {
          method: req.method || "GET",
          headers,
          redirect: "manual",
          signal: AbortSignal.timeout(20000),
          ...(!["GET", "HEAD"].includes(req.method || "GET")
            ? { body: Buffer.concat(chunks) }
            : {}),
        },
      );
      res.writeHead(response.status, {
        "content-type":
          response.headers.get("content-type") || "application/json",
        "cache-control": "no-store",
        "x-forge-deployment": revision || "",
      });
      if (response.body)
        for await (const chunk of response.body as any) {
          if (!res.write(chunk)) await new Promise((r) => res.once("drain", r));
        }
      res.end();
      return;
    }
    const actual = Buffer.from(req.headers.authorization || ""),
      expected = Buffer.from(`Bearer ${token}`);
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected))
      return respond(401, { error: "Unauthorized" });
    const match = path.match(/^\/targets\/([a-z0-9-]+)(\/actions)?$/);
    if (!match) return respond(404, { error: "Unknown runner route" });
    if (req.method === "GET" && !match[2])
      return respond(200, controller.inspect(match[1]!));
    if (req.method === "POST" && match[2]) {
      let text = "";
      for await (const chunk of req) {
        text += chunk;
        if (text.length > 10000) throw new Problem(413, "Request too large");
      }
      let input;
      try {
        input = JSON.parse(text);
      } catch {
        throw new Problem(400, "Invalid JSON");
      }
      return respond(202, controller.action(match[1]!, input));
    }
    respond(405, { error: "Method not allowed" });
  } catch (e) {
    if (res.headersSent) {
      res.destroy();
      return;
    }
    respond(e instanceof Problem ? e.status : 400, {
      error:
        e instanceof Problem
          ? e.message
          : "Runner action failed. Check configuration and request.",
    });
  }
}).listen(Number(process.env.PORT || 8790), "0.0.0.0");
console.log("Forge deployment controller started");
