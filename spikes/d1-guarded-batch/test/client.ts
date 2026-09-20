import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/** Reads SPIKE_URL / SPIKE_TOKEN from the environment or a local `.spike-env` file (KEY=VALUE lines). */
function loadEnv(): { url: string; token: string } {
  const fromFile: Record<string, string> = {};
  try {
    for (const line of readFileSync(resolve(import.meta.dirname, "..", ".spike-env"), "utf8").split("\n")) {
      const m = /^([A-Z_]+)=(.*)$/.exec(line.trim());
      if (m) fromFile[m[1]!] = m[2]!;
    }
  } catch {
    /* no file */
  }
  const url = process.env["SPIKE_URL"] ?? fromFile["SPIKE_URL"];
  const token = process.env["SPIKE_TOKEN"] ?? fromFile["SPIKE_TOKEN"];
  if (!url || !token) throw new Error("SPIKE_URL and SPIKE_TOKEN are required (env or .spike-env)");
  return { url: url.replace(/\/$/, ""), token };
}

const env = loadEnv();

export interface Row {
  [k: string]: unknown;
}
export interface Dump {
  customer: Row[];
  audit: Row[];
  outbox: Row[];
  asserts: Row[];
}
export type Variant = "predicate-first" | "changes-after" | "unguarded";
export interface UpdateResult {
  ok: boolean;
  rowsChanged?: number | null;
  outcome?: string;
  error?: { name: string; message: string; cause?: string };
}

async function call<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${env.url}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-spike-token": env.token },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(`${path} -> HTTP ${res.status}: ${text}`);
  }
}

export const spike = {
  reset: () => call<{ ok: true }>("/reset", {}),
  seed: (tenant: string, id: string, name: string) => call<{ ok: true }>("/seed", { tenant, id, name }),
  update: (r: { tenant: string; id: string; expectedVersion: number; name: string; opId: string; variant: Variant }) =>
    call<UpdateResult>("/update", r),
  rollbackProof: (tenant: string, opId: string) => call<UpdateResult>("/rollback-proof", { tenant, opId }),
  dump: (tenant: string) => call<Dump>("/dump", { tenant }),
};
