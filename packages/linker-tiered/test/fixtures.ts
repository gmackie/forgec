// Shared by the workerd tests, the differential and the research run: builds what a tiered link needs
// (acme sealed, linker B's libraries), links acme with its policy, and serves it in Miniflare.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { readJsonc, type Environment } from "@forgegraph/linker-packed";
import type { ClosureManifest } from "@forgegraph/units";
import { linkTiered, type TieredLink } from "../src/link.ts";
import { hostFetcher, linkDynamic, seedKit, serve, tieredScriptsOf, type Served, type TierOptions } from "../src/local.ts";
import type { DynamicPolicy } from "../src/policy.ts";
// @ts-expect-error untyped harness module
import * as harness from "../../linker-dynamic/scripts/harness.mjs";

export const root = resolve(import.meta.dirname, "../../..");
export const acme = join(root, "examples/acme");
export const unitsOut = join(acme, "generated/units");
export const envPath = join(acme, "deploy/cloudflare/wrangler.jsonc");
export const env = () => readJsonc(envPath) as Environment;
export const policy = () => JSON.parse(readFileSync(join(acme, "deploy/cloudflare/tiered-policy.json"), "utf8")) as DynamicPolicy;
export const acmeManifestText = () => readFileSync(join(unitsOut, "manifest.json"), "utf8");
export const acmeManifest = () => JSON.parse(acmeManifestText()) as ClosureManifest;

/** Re-seals acme with an edited copy of impl/ (linker B's harness): `{ dir, manifest, text }`, dir holding manifest.json and modules/. */
export const sealVariant = (edit: (implDir: string) => void) => (harness as { sealVariant(e: (d: string) => void): Promise<{ dir: string; manifest: ClosureManifest; text: string }> }).sealVariant(edit);

/** forgec build --units + seal for acme (when absent), and linker B's libraries. */
export function prepare(): void {
  if (!existsSync(join(unitsOut, "manifest.json")) || !existsSync(join(acme, "generated/app.json"))) execFileSync("pnpm", ["--filter", "@acme/commerce-deploy", "units:build"], { cwd: root, stdio: "inherit" });
  if (!existsSync(join(root, "packages/linker-dynamic/generated/libs/libs.json"))) execFileSync("node", [join(root, "packages/linker-dynamic/scripts/build-libs.mjs")], { stdio: "inherit" });
}

export async function linkAcme(out: string, p: DynamicPolicy = policy()): Promise<TieredLink> {
  return linkTiered({ app: acme, manifestDir: unitsOut, environment: envPath, out, policy: p });
}

export interface Tier {
  served: Served;
  host: Awaited<ReturnType<typeof hostFetcher>>;
  /** Module digests already in the unit store. */
  known: Set<string>;
  close(): Promise<void>;
}

/** Serves a tiered link; `seed` uploads the kit and links the sealed acme manifest into the dynamic tier. */
export async function serveTier(t: TieredLink, dir: string, o: TierOptions & { seed?: boolean } = {}): Promise<Tier> {
  const served = await serve(tieredScriptsOf(t, dir, o), env(), { secret: "t5-local-cursor-secret", migrations: join(acme, "migrations/d1") });
  const host = await hostFetcher(served, t.host.name);
  const known = new Set<string>();
  if (o.seed !== false) {
    await seedKit(host, join(acme, "generated/app.json"));
    const r = await linkDynamic(host, { manifestText: acmeManifestText(), modulesDir: join(unitsOut, "modules"), known });
    if (r.status !== 200) throw new Error(`dynamic link failed: ${JSON.stringify(r.body)}`);
  }
  return { served, host, known, close: () => served.close() };
}

/** sha256 of every worker.js under a link directory, by script: what a deploy would compare to decide uploads. */
export function scriptDigests(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (d: string) => {
    for (const f of readdirSync(d)) {
      const p = join(d, f);
      if (statSync(p).isDirectory()) walk(p);
      else if (f === "worker.js") out[p.slice(dir.length + 1, -"/worker.js".length)] = createHash("sha256").update(readFileSync(p)).digest("hex");
    }
  };
  walk(dir);
  return out;
}

/** The AuthorizePayment limit raised from 1000 to 2000 (FORG-30's swap). */
export const raiseLimit = (impl: string) => {
  const f = join(impl, "payment-adapter.ts");
  writeFileSync(f, readFileSync(f, "utf8").replace("amount >= 1000", "amount >= 2000"));
};

/** An AuthorizePayment module that throws while it is evaluated: a child holding it cannot start. */
export const breakModule = (impl: string) => {
  const f = join(impl, "payment-adapter.ts");
  writeFileSync(f, `${readFileSync(f, "utf8")}\nif (!(globalThis as Record<string, unknown>)["forgeNever"]) throw new Error("payment adapter failed to initialise");\n`);
};
