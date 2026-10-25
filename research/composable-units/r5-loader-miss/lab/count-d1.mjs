// FORG-48 (local): counts the D1 statements acme's runtime issues for GET /v1/customers on a new runtime instance, then warm.
//   node lab/count-d1.mjs <repo root>   (after pnpm -r run build and units:build)
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
const root = process.argv[2];
const { createWorker } = await import(`${root}/packages/runtime/dist/hosts/cloudflare.js`);
const app = JSON.parse(readFileSync(`${root}/examples/acme/generated/app.json`, "utf8"));
const db = new DatabaseSync(":memory:");
for (const f of ["0001_init.sql","0002_documents.sql","0003_order_document.sql","0004_dispatch.sql","0005_temporal_hierarchy.sql","0006_artifact_publications.sql"]) { try { db.exec(readFileSync(`${root}/examples/acme/migrations/d1/${f}`, "utf8")); } catch (e) { console.error(f, String(e).slice(0,100)); } }
const log = [];
const stmt = (sql, params = []) => ({
  bind: (...v) => stmt(sql, v),
  first: async () => { log.push(sql + " " + JSON.stringify(params)); return db.prepare(sql).get(...params) ?? null; },
  all: async () => { log.push(sql); return { results: db.prepare(sql).all(...params), meta: { changes: 0 } }; },
  run: async () => { log.push(sql + " " + JSON.stringify(params).slice(0,120)); const r = db.prepare(sql).run(...params); return { meta: { changes: r.changes } }; },
  __s: { sql, params },
});
const DB = { prepare: (sql) => stmt(sql), batch: async (ss) => Promise.all(ss.map((s) => s.all())) };
const worker = createWorker(app, { functions: [], externals: {}, postCommit: async () => undefined });
const env = { DB, FORGE_AUTH: "dev-headers", CURSOR_SECRET: "x" };
for (const pass of ["first", "second", "third"]) {
  log.length = 0;
  const r = await worker.fetch(new Request("http://x/v1/customers", { headers: { "x-forge-tenant": "t1", "x-forge-actor": "a" } }), env);
  console.log(pass, r.status, log.length, log.map((s) => s.replace(/\s+/g, " ").slice(0, 260)));
}
