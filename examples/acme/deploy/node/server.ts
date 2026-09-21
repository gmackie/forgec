// Node + PostgreSQL entrypoint for the Acme reference application (plan §5.4).
// Same bundle, same impl/ as the Cloudflare and AWS deployments; only this file differs.
//   FORGE_PG_URL=postgres://... CURSOR_SECRET=... PORT=8080 node --experimental-strip-types deploy/node/server.ts
import pg from "pg";
import { createPostgresStorage } from "@forge/runtime/postgres";
import { createNodeHost } from "@forge/runtime/node";
import { Model, type AppBundle } from "@forge/runtime";
import bundle from "../../generated/app.json" with { type: "json" };
import { externals, functions } from "../../impl/index.js";

const app = bundle as unknown as AppBundle;
const pool = new pg.Pool({ connectionString: process.env["FORGE_PG_URL"], max: Number(process.env["FORGE_PG_POOL"] ?? 10) });
const host = createNodeHost({
  bundle: app,
  store: createPostgresStorage(pool, new Model(app)),
  functions,
  externals,
  cursorSecret: process.env["CURSOR_SECRET"] ?? "dev-cursor-secret-change-me",
  objects: { directory: process.env["FORGE_OBJECTS_DIR"] ?? "./.forge-objects" },
  ...(process.env["FORGE_PUBLIC_URL"] ? { publicUrl: process.env["FORGE_PUBLIC_URL"] } : {}),
  cors: (process.env["FORGE_CORS"] ?? "http://localhost:5173").split(","),
  sweepIntervalMs: Number(process.env["FORGE_SWEEP_MS"] ?? 5000),
  telemetryFormat: (process.env["FORGE_TELEMETRY"] as "json" | "emf" | "silent" | undefined) ?? "json",
});
const bound = await host.listen(Number(process.env["PORT"] ?? 8080), process.env["HOST"] ?? "0.0.0.0");
console.error(`forge-acme listening on ${bound.url}`);
for (const sig of ["SIGTERM", "SIGINT"] as const) {
  process.on(sig, () => {
    host.stop().then(() => pool.end()).then(() => process.exit(0), () => process.exit(1));
  });
}
