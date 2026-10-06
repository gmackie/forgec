import { sqliteStudio } from "./studio-sqlite.js";
import studioMigration from "../migrations/0003_studio.sql";
import credentialsMigration from "../migrations/0003_registry_credentials.sql";
import { credentialStore, type SqlLike } from "./credentials.js";
import {runtimeConnections} from "./runtime-control.js";
import {integrationsFrom} from "./integrations.js";
import {deploymentConnections} from "./deployment-control.js";
import { createServer } from "node:http";
import { readFile, mkdir } from "node:fs/promises";
import { resolve, extname, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { Readable } from "node:stream";
import { gitRepositories } from "./git.js";
import { createApi } from "./api.js";
import { SqliteState } from "./sqlite.js";
import { missingConfiguration, registryFrom, secure, type Config } from "./config.js";
const config = process.env as Config;
if (
  !config.ADMIN_TOKEN ||
  config.ADMIN_TOKEN.length < 32 ||
  !config.INSTANCE_AUTHORITY
)
  throw new Error(
    "Set ADMIN_TOKEN (at least 32 characters) and INSTANCE_AUTHORITY before starting.",
  );
const dbPath = resolve(process.env.DATA_PATH || "./data/console.sqlite");
await mkdir(dirname(dbPath), { recursive: true });
const db = new DatabaseSync(dbPath);
const store = new SqliteState(db);
// Registry credentials are not Workers-only. A self-hosted instance mints them for exactly the
// same reason: `docker login` cannot authenticate any other way. Leaving this unwired made the
// credentials panel answer 503 on every Docker deployment, and on the Playwright suite, which
// runs this host rather than the Worker.
db.exec(credentialsMigration);
const credentialSql: SqlLike = {
  async all(text, params) {
    return db.prepare(text).all(...(params as never[])) as Record<string, unknown>[];
  },
  async run(text, params) {
    return { changes: Number(db.prepare(text).run(...(params as never[])).changes) };
  },
};
const api = createApi({
  store,
  studio: sqliteStudio(db,studioMigration,config.ADMIN_TOKEN),
  credentials: credentialStore(credentialSql),
  token: config.ADMIN_TOKEN,
  authority: config.INSTANCE_AUTHORITY,
  name: config.INSTANCE_NAME || "Forge",
  runtime: "Docker / Node",
  registry: await registryFrom(config),
  git: gitRepositories(config),
  runtimes: runtimeConnections(config),
  deployments: deploymentConnections(config),
  integrations: integrationsFrom(config),
});
const root = resolve(dirname(fileURLToPath(import.meta.url)), "web");
const types: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".css": "text/css",
  ".svg": "image/svg+xml",
  ".wasm": "application/wasm",
  ".ico": "image/x-icon",
};
const server = createServer(async (req, res) => {
  try {
    // Preserve the externally observed origin for same-origin checks behind a TLS reverse proxy.
    const scheme = process.env.PUBLIC_ORIGIN
      ? new URL(process.env.PUBLIC_ORIGIN).protocol
      : "http:";
    const url = new URL(
      req.url || "/",
      `${scheme}//${req.headers.host || "localhost"}`,
    );
    let response: Response;
    if (url.pathname === "/healthz") {
      // Same contract as the Worker: a probe that cannot fail cannot report an instance that
      // came up without its configuration.
      const missing = missingConfiguration(config);
      const authMode = config.AUTH_MODE === "cloudflare-access" ? "cloudflare-access" : "token";
      response = Response.json(
        missing.length ? { status: "unconfigured", missing, authMode } : { status: "ok", authMode },
        { status: missing.length ? 503 : 200 },
      );
    }
    else if (url.pathname.startsWith("/api/")) {
      const headers = new Headers();
      for (const [key, value] of Object.entries(req.headers))
        if (value)
          headers.set(key, Array.isArray(value) ? value.join(",") : value);
      const request = new Request(url, {
        method: req.method || "GET",
        headers,
        ...(!["GET", "HEAD"].includes(req.method || "GET")
          ? { body: Readable.toWeb(req) as ReadableStream, duplex: "half" }
          : {}),
      } as RequestInit);
      response = await api(request);
    } else if (req.method !== "GET" && req.method !== "HEAD")
      response = new Response("Method not allowed", { status: 405 });
    else {
      const pathname = decodeURIComponent(url.pathname);
      const file = resolve(root, `.${pathname}`);
      if (file !== root && !file.startsWith(root + "/"))
        response = new Response("Not found", { status: 404 });
      else {
        try {
          response = new Response(new Uint8Array(await readFile(file)), {
            headers: {
              "content-type":
                types[extname(file)] || "application/octet-stream",
              "cache-control": pathname.startsWith("/assets/")
                ? "public,max-age=31536000,immutable"
                : "no-cache, no-transform",
            },
          });
        } catch {
          response = pathname.startsWith("/assets/")
            ? new Response("Not found", { status: 404 })
            : new Response(
                new Uint8Array(await readFile(resolve(root, "index.html"))),
                {
                  headers: {
                    "content-type": "text/html; charset=utf-8",
                    "cache-control": "no-cache, no-transform",
                  },
                },
              );
        }
      }
    }
    response = secure(response);
    res.writeHead(response.status, Object.fromEntries(response.headers));
    if (req.method === "HEAD" || !response.body) res.end();
    else
      Readable.fromWeb(
        response.body as import("node:stream/web").ReadableStream,
      ).pipe(res);
  } catch {
    res.writeHead(500, { "content-type": "text/plain" });
    res.end("Request failed");
  }
});
server.listen(
  Number(process.env.PORT || 8787),
  process.env.HOST || "0.0.0.0",
  () =>
    console.log("Forge console listening on port", process.env.PORT || 8787),
);
for (const signal of ["SIGINT", "SIGTERM"])
  process.on(signal, () =>
    server.close(() => {
      db.close();
      process.exit(0);
    }),
  );
