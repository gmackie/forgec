// Runs linked scripts locally in workerd through Miniflare: every script in one instance, sharing one
// D1 database, R2 bucket, queues, Workflows and Durable Objects, wired exactly as the scripts'
// wrangler configs say (service bindings for the router and the dispatch owner, `script_name` for the
// workflow class and the realtime object). The first worker is the entry: the router when there is
// one, otherwise the single script. FORGE_MINIFLARE_LOG=1 prints workerd's request and error log.
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { convertV4MiniflareOptions, Log, LogLevel, Miniflare, type V4MiniflareOptions } from "miniflare";

type WorkerOptions = Record<string, unknown> & { name: string };
import { bindingOf, type Environment, type Link } from "./link.ts";

export interface LocalScript {
  name: string;
  scriptPath: string;
  /** Env binding names the script is given. */
  bindings: string[];
  queues: string[];
  classes: { workflows: Array<{ className: string }>; realtime: string | null };
  services: Record<string, string>;
}

export function scriptsOf(l: Link, dir: string): LocalScript[] {
  const scripts: LocalScript[] = l.scripts.map((s) => ({
    name: s.name,
    scriptPath: join(dir, s.name, "worker.js"),
    bindings: s.capabilities.injected.map((b) => b.name),
    queues: s.queues,
    classes: s.classes,
    services: Object.fromEntries(s.linkerBindings.map((b) => [b.name, b.script])),
  }));
  // FORG-42: the shared runtime Worker holds no bindings; scripts reach it by service binding.
  if (l.runtime) scripts.push({ name: l.runtime.name, scriptPath: join(dir, l.runtime.name, "worker.js"), bindings: [], queues: [], classes: { workflows: [], realtime: null }, services: {} });
  if (!l.router) return scripts;
  const targets = [...new Set([...l.router.table.map((r) => r.script), l.router.fallback])];
  return [{ name: l.router.name, scriptPath: join(dir, l.router.name, "worker.js"), bindings: [], queues: [], classes: { workflows: [], realtime: null }, services: Object.fromEntries(targets.map((t) => [bindingOf(t), t])) }, ...scripts];
}

export interface Served {
  url: string;
  mf: Miniflare;
  close(): Promise<void>;
}

export async function serve(scripts: LocalScript[], env: Environment, opts: { secret: string; migrations: string; port?: number }): Promise<Served> {
  const owner = (pred: (s: LocalScript) => boolean) => scripts.find(pred)?.name;
  const workers: WorkerOptions[] = scripts.map((s) => {
    const has = (n: string) => s.bindings.includes(n);
    const vars: Record<string, string> = Object.fromEntries(Object.entries(env.vars ?? {}).filter(([k]) => has(k)));
    if (has("CURSOR_SECRET")) vars["CURSOR_SECRET"] = opts.secret;
    // FORG-42 research: shared scripts log RPC calls per request when this is set (never a manifest binding).
    if (process.env["FORGE_RPC_TRACE"]) vars["FORGE_RPC_TRACE"] = "1";
    // rootPath: Miniflare 5 (alpha) fails to load a module script by absolute path without one, as wrangler always passes it.
    const w: WorkerOptions = { name: s.name, rootPath: dirname(s.scriptPath), modules: true, scriptPath: s.scriptPath, compatibilityDate: env.compatibility_date, ...(env.compatibility_flags?.length ? { compatibilityFlags: env.compatibility_flags } : {}), bindings: vars };
    const d1 = (env.d1_databases ?? []).filter((d) => has(d.binding));
    if (d1.length) w.d1Databases = Object.fromEntries(d1.map((d) => [d.binding, d.database_name]));
    const r2 = (env.r2_buckets ?? []).filter((d) => has(d.binding));
    if (r2.length) w.r2Buckets = Object.fromEntries(r2.map((d) => [d.binding, d.bucket_name]));
    const producers = (env.queues?.producers ?? []).filter((q) => has(q.binding));
    if (producers.length) w.queueProducers = Object.fromEntries(producers.map((q) => [q.binding, { queueName: q.queue }]));
    const consumers = (env.queues?.consumers ?? []).filter((q) => s.queues.includes(q.queue));
    if (consumers.length) {
      w.queueConsumers = Object.fromEntries(
        consumers.map((q) => [q.queue, { maxBatchSize: Number(q["max_batch_size"] ?? 10), maxBatchTimeout: 0, maxRetries: Number(q["max_retries"] ?? 3), ...(q["dead_letter_queue"] ? { deadLetterQueue: String(q["dead_letter_queue"]) } : {}) }]),
      );
    }
    const dos = (env.durable_objects?.bindings ?? []).filter((d) => has(d.name) || s.classes.realtime === d.class_name);
    if (dos.length) w.durableObjects = Object.fromEntries(dos.map((d) => [d.name, { className: d.class_name, scriptName: owner((x) => x.classes.realtime === d.class_name) ?? s.name, useSQLite: true }]));
    const wfs = (env.workflows ?? []).filter((x) => has(x.binding) || s.classes.workflows.some((c) => c.className === x.class_name));
    if (wfs.length) w.workflows = Object.fromEntries(wfs.map((x) => [x.binding, { name: x.name, className: x.class_name, scriptName: owner((y) => y.classes.workflows.some((c) => c.className === x.class_name)) ?? s.name }]));
    if (Object.keys(s.services).length) w.serviceBindings = s.services;
    return w;
  });
  const mf = new Miniflare(convertV4MiniflareOptions({ workers, host: "127.0.0.1", ...(process.env["FORGE_MINIFLARE_LOG"] ? { log: new Log(LogLevel.DEBUG) } : {}), ...(opts.port ? { port: opts.port } : {}) } as V4MiniflareOptions));
  const url = await mf.ready;
  // Apply the app's D1 migrations through any script holding DB (they all share one database).
  const holder = scripts.find((s) => s.bindings.includes("DB"));
  if (holder) {
    const db = await mf.getD1Database("DB", holder.name);
    for (const f of readdirSync(opts.migrations).filter((x) => x.endsWith(".sql")).sort()) {
      const sql = readFileSync(join(opts.migrations, f), "utf8")
        .split("\n")
        .filter((l) => !l.trim().startsWith("--"))
        .join("\n");
      const statements = sql.split(/;\s*\n/).map((x) => x.trim()).filter((x) => x && !/^PRAGMA/i.test(x));
      await db.batch(statements.map((x) => db.prepare(x)));
    }
  }
  return { url: url.toString().replace(/\/$/, ""), mf, close: () => mf.dispose() };
}
