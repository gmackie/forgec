// Manifest fixtures for the tests: the sealed acme manifest, variants re-sealed from an edited
// copy of impl/ (through @forgegraph/units, so their hashes are the sealer's), and edits that
// re-hash only what a hand edit would need to stay well-formed.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { digest, stableJson } from "@forgegraph/units";
import type { ClosureManifest } from "../src/manifest.ts";
// @ts-expect-error untyped harness module
import * as harness from "../scripts/harness.mjs";

export const h = harness as {
  root: string;
  acme: string;
  unitsOut: string;
  prepare(o?: { force?: boolean }): void;
  startWorker(o: { kind?: "host" | "whole-app"; port: number; vars?: Record<string, string>; log?: (s: string) => void }): Promise<{ base: string; state: string; output(): string; stop(): Promise<void> }>;
  seedKit(base: string): Promise<{ libraries: Record<string, string>; apps: Record<string, string> }>;
  linkManifest(base: string, o?: { manifestText?: string; modulesDir?: string | null; skipModules?: string[] }): Promise<{ status: number; body: Record<string, unknown> }>;
  stats(base: string): Promise<{ manifestHash: string; closures: Array<{ id: string; closureHash: string; label: string; cold: number; warm: number; buildMs: number[] }>; denials: string[]; fallbacks: string[]; refused: string[] }>;
  resetStats(base: string): Promise<void>;
  evictHostCache(base: string): Promise<void>;
  sealVariant(edit: (implDir: string) => void): Promise<{ dir: string; manifest: ClosureManifest; text: string }>;
};

export const acmeManifestText = () => readFileSync(join(h.unitsOut, "manifest.json"), "utf8");
export const acmeManifest = () => JSON.parse(acmeManifestText()) as ClosureManifest;
export const appBundle = () =>
  JSON.parse(readFileSync(join(h.acme, "generated/app.json"), "utf8")) as {
    buildHash: string;
    sql: { tables: Array<{ name: string; resource: string; foreignKeys?: Array<{ references: string }> }>; systemTables: Array<{ name: string }> };
  };

/** Recomputes closure hashes and the manifest hash after a hand edit, as the sealer would. */
export function rehash(m: ClosureManifest, { closures = true } = {}): ClosureManifest {
  if (closures) for (const e of m.entryPoints) e.closureHash = digest("forge:closure:", e.closure);
  const { manifestHash: _, ...body } = m;
  return { ...body, manifestHash: digest("forge:closure-manifest:", body) } as ClosureManifest;
}

export const entry = (m: ClosureManifest, id: string) => {
  const e = m.entryPoints.find((x) => x.id === id);
  if (!e) throw new Error(`no entry point ${id}`);
  return e;
};

/** Re-seals acme with an edited copy of impl/ (see scripts/harness.mjs). */
export const sealVariant = (edit: (implDir: string) => void) => h.sealVariant(edit);

export { stableJson };

/** The hostile AuthorizePayment body: probes its isolate and reports through the error detail. */
export const hostileAdapter = (target: string) => `// Sandbox probe (FORG-30 tests): not an adapter.
export const authorizePayment = async (input: { amount: unknown; reference: unknown }) => {
  const probe: Record<string, unknown> = {};
  const spec = "cloudflare:" + "workers";
  const { env } = (await import(spec)) as { env: Record<string, any> };
  probe.envKeys = Object.keys(env).sort();
  probe.hostGlobals = ["LOADER", "UNITS", "DB", "BLOBS", "WF_PROCESS_ORDER", "Q_FULFILL_ORDER", "CURSOR_SECRET", "LINKER_ADMIN_TOKEN"].filter((k) => k in globalThis);
  try {
    const r = await fetch(${JSON.stringify(target)});
    probe.fetch = "status:" + r.status + ":" + (r.headers.get("x-forge-egress") ?? (await r.text()).slice(0, 40));
  } catch (e) {
    probe.fetch = "threw:" + String((e as Error).message).slice(0, 160);
  }
  try {
    const r = await fetch("https://example.com/");
    probe.fetchOther = "status:" + r.status + ":" + (r.headers.get("x-forge-egress") ?? "");
  } catch (e) {
    probe.fetchOther = "threw:" + String((e as Error).message).slice(0, 160);
  }
  const sql = async (label: string, f: () => Promise<unknown>) => {
    try {
      await f();
      probe[label] = "allowed";
    } catch (e) {
      probe[label] = "denied:" + String((e as Error).message).slice(0, 200);
    }
  };
  await sql("readOrder", () => env.DB.all("SELECT id FROM order_ LIMIT 1", []));
  await sql("readSite", () => env.DB.all("SELECT id FROM site LIMIT 1", []));
  await sql("readDepartment", () => env.DB.all("SELECT id FROM department LIMIT 1", []));
  await sql("readSitePolicy", () => env.DB.all("SELECT id FROM site_policy LIMIT 1", []));
  await sql("writeSite", () => env.DB.run("DELETE FROM site WHERE id = ?", ["none"]));
  await sql("sqliteMaster", () => env.DB.all("SELECT name FROM sqlite_master", []));
  await sql("pragma", () => env.DB.all("PRAGMA table_list", []));
  await sql("readSystem", () => env.DB.all("SELECT kind FROM forge_document LIMIT 1", []));
  probe.blobs = typeof env.BLOBS;
  probe.amount = input.amount;
  return { ok: false as const, code: "PaymentUnavailable", detail: JSON.stringify(probe) };
};
`;
