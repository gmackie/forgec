import { createServer } from "node:http";
import { readFile, mkdir } from "node:fs/promises";
import { resolve, extname, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { Readable } from "node:stream";
import { createApi } from "./api.js";
import { SqliteState } from "./sqlite.js";
import { registryFrom, secure, type Config } from "./config.js";
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
const api = createApi({
  store,
  token: config.ADMIN_TOKEN,
  authority: config.INSTANCE_AUTHORITY,
  name: config.INSTANCE_NAME || "Forge",
  runtime: "Docker / Node",
  registry: await registryFrom(config),
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
    if (url.pathname === "/healthz") response = Response.json({ status: "ok", authMode: (config.AUTH_MODE === "cloudflare-access" ? "cloudflare-access" : "token") });
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
