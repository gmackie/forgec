// Node + PostgreSQL entrypoint for the Acme reference application (plan §5.4).
// Same bundle, same impl/ as the Cloudflare and AWS deployments; only this file differs.
//
//   production:  FORGE_PG_URL=postgres://...  CURSOR_SECRET=<32+ random bytes> \
//                FORGE_JWT_ISSUER=https://issuer.example  FORGE_JWT_AUDIENCE=forge-acme \
//                FORGE_JWT_SECRET=<hmac secret>  PORT=8080  node deploy/node/server.ts
//   development: FORGE_AUTH=dev-headers  CURSOR_SECRET=dev  FORGE_PG_URL=...  node deploy/node/server.ts
//
// There is no default credential here on purpose: a missing secret stops the process rather than
// shipping a known one, and a missing auth host makes createNodeHost refuse to start.
import pg from "pg";
import { createPostgresStorage } from "@forgegraph/runtime/postgres";
import { createNodeHost } from "@forgegraph/runtime/node";
import { jwtAuth, Model, type AppBundle } from "@forgegraph/runtime";
import bundle from "../../generated/app.json" with { type: "json" };
import { externals, functions } from "../../impl/index.js";

const required = (name: string): string => {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is required; refusing to start with a default or empty value`);
  return v;
};
const app = bundle as unknown as AppBundle;
// A real auth host when the issuer is configured; otherwise the host enforces FORGE_AUTH=dev-headers.
const auth = process.env["FORGE_JWT_ISSUER"]
  ? jwtAuth({
      issuer: required("FORGE_JWT_ISSUER"),
      audience: required("FORGE_JWT_AUDIENCE"),
      secret: required("FORGE_JWT_SECRET"),
      claims: { tenant: process.env["FORGE_JWT_TENANT_CLAIM"] ?? "tid", actor: "sub", purposes: "purposes" },
    })
  : undefined;
const pool = new pg.Pool({ connectionString: process.env["FORGE_PG_URL"], max: Number(process.env["FORGE_PG_POOL"] ?? 10) });
const host = createNodeHost({
  bundle: app,
  store: createPostgresStorage(pool, new Model(app)),
  functions,
  externals,
  ...(auth ? { auth } : {}),
  cursorSecret: required("CURSOR_SECRET"),
  objects: { directory: process.env["FORGE_OBJECTS_DIR"] ?? "./.forge-objects" },
  ...(process.env["FORGE_PUBLIC_URL"] ? { publicUrl: process.env["FORGE_PUBLIC_URL"] } : {}),
  cors: (process.env["FORGE_CORS"] ?? "http://localhost:5173").split(","),
  sweepIntervalMs: Number(process.env["FORGE_SWEEP_MS"] ?? 5000),
  telemetryFormat: (process.env["FORGE_TELEMETRY"] as "json" | "emf" | "silent" | "otlp" | undefined) ?? "json",
});
const bound = await host.listen(Number(process.env["PORT"] ?? 8080), process.env["HOST"] ?? "0.0.0.0");
console.error(`forge-acme listening on ${bound.url}`);
for (const sig of ["SIGTERM", "SIGINT"] as const) {
  process.on(sig, () => {
    host.stop().then(() => pool.end()).then(() => process.exit(0), () => process.exit(1));
  });
}
