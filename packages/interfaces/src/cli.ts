/**
 * Generic API CLI (FORGE-055, PAR-122). One binary for every Forge
 * deployment: it learns the operations from the deployment's own OpenAPI
 * projection and speaks the unary envelope through the HTTP callable.
 *
 * Machine contract:
 *   stdout  – canonical JSON of the result (sorted keys, one trailing newline) and nothing else
 *   stderr  – diagnostics; on a Problem outcome the last line is the Problem as one JSON object
 *   exit    – 0 ok, 2 usage, 3 Problem (business outcome), 4 transport/invocation failure,
 *             5 contract mismatch, 6 mutation refused by the guard, 7 authentication
 *
 * Input: `--set path=value` (typed), `--set-string path=value`, `--file f.json`, `--stdin`,
 * combined left to right; `--dry-run` prints the canonical request instead of sending it.
 * Mutations need `--yes` (or FORGE_API_YES=1). Credentials come from FORGE_API_TOKEN, a
 * private `--token-file`, or the development header pair; `--token` on argv is refused.
 */
import { readFileSync, statSync } from "node:fs";
import { httpCallable, toHttpRequest, type Credential, type Outcome } from "./rpc.js";

export const EXIT = { OK: 0, USAGE: 2, PROBLEM: 3, TRANSPORT: 4, CONTRACT: 5, REFUSED: 6, AUTH: 7 } as const;

export interface CliIo {
  stdin(): Promise<string>;
  stdout(s: string): void;
  stderr(s: string): void;
  env: Record<string, string | undefined>;
  fetch: typeof fetch;
}

/** Canonical JSON: keys sorted at every level, no whitespace. */
export function canonical(v: unknown): string {
  return JSON.stringify(sortKeys(v));
}
function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v as object).sort()) out[k] = sortKeys((v as Record<string, unknown>)[k]);
    return out;
  }
  return v;
}

function setPath(target: Record<string, unknown>, path: string, value: unknown): void {
  const parts = path.split(".");
  let cur = target;
  for (let i = 0; i < parts.length - 1; i++) {
    const p = parts[i]!;
    if (typeof cur[p] !== "object" || cur[p] === null) cur[p] = {};
    cur = cur[p] as Record<string, unknown>;
  }
  cur[parts[parts.length - 1]!] = value;
}

function typed(raw: string): unknown {
  if (raw === "null") return null;
  if (raw === "true") return true;
  if (raw === "false") return false;
  if (/^-?\d+(\.\d+)?$/.test(raw)) return Number(raw);
  if ((raw.startsWith("{") && raw.endsWith("}")) || (raw.startsWith("[") && raw.endsWith("]"))) {
    try { return JSON.parse(raw); } catch { /* literal text */ }
  }
  return raw;
}

const MUTATIONS = new Set(["create", "update", "delete", "restore", "transition", "move", "beginUpload", "finalizeUpload", "function", "workflow.start", "workflow.cancel", "workflow.signal", "projection.rebuild", "schedule.tick", "changeset.propose", "changeset.approve", "changeset.commit", "import.stage", "admin.import", "admin.fence"]);

const USAGE = `usage: forge-api <operation> [--set path=value]... [--set-string path=value]... [--file f.json] [--stdin]
                 [--purpose P] [--idempotency-key K] [--yes] [--dry-run] [--expect-contracts V] [--expect-wire D]
       forge-api operations
       forge-api discovery
environment: FORGE_API_URL, FORGE_API_TOKEN | --token-file <private file> | FORGE_API_DEV_TENANT + FORGE_API_DEV_ACTOR, FORGE_API_YES
`;

interface Args { positional: string[]; sets: [string, unknown][]; file?: string; stdin: boolean; purpose?: string; idempotencyKey?: string; yes: boolean; dryRun: boolean; expectContracts?: string; expectWire?: string; tokenFile?: string; url?: string }

function parse(argv: string[], io: CliIo): Args | { error: string } {
  const a: Args = { positional: [], sets: [], stdin: false, yes: false, dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const x = argv[i]!;
    const next = () => { const v = argv[++i]; if (v === undefined) throw new Error(`${x} needs a value`); return v; };
    try {
      switch (x) {
        case "--set": { const kv = next(); const eq = kv.indexOf("="); if (eq < 0) return { error: `--set expects path=value, got ${kv}` }; a.sets.push([kv.slice(0, eq), typed(kv.slice(eq + 1))]); break; }
        case "--set-string": { const kv = next(); const eq = kv.indexOf("="); if (eq < 0) return { error: `--set-string expects path=value, got ${kv}` }; a.sets.push([kv.slice(0, eq), kv.slice(eq + 1)]); break; }
        case "--file": a.file = next(); break;
        case "--stdin": a.stdin = true; break;
        case "--purpose": a.purpose = next(); break;
        case "--idempotency-key": a.idempotencyKey = next(); break;
        case "--yes": a.yes = true; break;
        case "--dry-run": a.dryRun = true; break;
        case "--expect-contracts": a.expectContracts = next(); break;
        case "--expect-wire": a.expectWire = next(); break;
        case "--token-file": a.tokenFile = next(); break;
        case "--url": a.url = next(); break;
        case "--token": return { error: "credentials are not accepted on the command line (they leak into process listings and shell history); set FORGE_API_TOKEN or use --token-file" };
        case "--help": case "-h": io.stderr(USAGE); return { error: "" };
        default:
          if (x.startsWith("--")) return { error: `unknown flag ${x}` };
          a.positional.push(x);
      }
    } catch (e) {
      return { error: (e as Error).message };
    }
  }
  return a;
}

function credential(a: Args, io: CliIo): Credential | { error: string } {
  if (a.tokenFile) {
    const mode = statSync(a.tokenFile).mode & 0o777;
    if (mode & 0o077) return { error: `${a.tokenFile} is readable by others (mode ${mode.toString(8)}); chmod 600 it` };
    return { kind: "bearer", token: readFileSync(a.tokenFile, "utf8").trim() };
  }
  if (io.env["FORGE_API_TOKEN"]) return { kind: "bearer", token: io.env["FORGE_API_TOKEN"] };
  if (io.env["FORGE_API_DEV_TENANT"] && io.env["FORGE_API_DEV_ACTOR"]) return { kind: "dev-header", tenant: io.env["FORGE_API_DEV_TENANT"], actor: io.env["FORGE_API_DEV_ACTOR"] };
  return { error: "no credential: set FORGE_API_TOKEN, pass --token-file, or FORGE_API_DEV_TENANT/FORGE_API_DEV_ACTOR against a development host" };
}

export async function runCli(argv: string[], io: CliIo): Promise<number> {
  const args = parse(argv, io);
  if ("error" in args) {
    if (args.error) io.stderr(`forge-api: ${args.error}\n${USAGE}`);
    return EXIT.USAGE;
  }
  const base = (args.url ?? io.env["FORGE_API_URL"] ?? "").replace(/\/$/, "");
  if (!base) { io.stderr("forge-api: FORGE_API_URL (or --url) is required\n"); return EXIT.USAGE; }
  const cred = credential(args, io);
  if ("error" in cred) { io.stderr(`forge-api: ${cred.error}\n`); return EXIT.USAGE; }
  const command = args.positional[0];
  if (!command) { io.stderr(USAGE); return EXIT.USAGE; }
  const headers = cred.kind === "bearer" ? { authorization: `Bearer ${cred.token}` } : { "x-forge-tenant": cred.tenant, "x-forge-actor": cred.actor };

  // Route table from the deployment's own projection (the same one httpCallable uses).
  const load = async (): Promise<{ discovery: Record<string, unknown>; ops: { operation: string; method: string; path: string; kind: string; mutation: boolean }[] } | number> => {
    let d: Response;
    try {
      d = await io.fetch(`${base}/forge/discovery`, { headers });
    } catch (e) {
      io.stderr(`forge-api: cannot reach ${base}: ${(e as Error).message}\n`);
      return EXIT.TRANSPORT;
    }
    if (d.status === 401 || d.status === 403) { io.stderr(`forge-api: the credential is not accepted (${d.status})\n`); return EXIT.AUTH; }
    if (!d.ok) { io.stderr(`forge-api: discovery answered ${d.status}\n`); return EXIT.TRANSPORT; }
    const discovery = (await d.json()) as Record<string, unknown>;
    const digests = (discovery["digests"] ?? {}) as Record<string, string>;
    const contracts = (discovery["contracts"] ?? {}) as { version?: string };
    const mismatch: string[] = [];
    if (args.expectContracts && contracts.version !== args.expectContracts) mismatch.push(`contracts ${String(contracts.version)} != ${args.expectContracts}`);
    if (args.expectWire && digests["wire"] !== args.expectWire) mismatch.push(`wire digest ${String(digests["wire"])} != ${args.expectWire}`);
    if (mismatch.length) { io.stderr(`forge-api: contract mismatch: ${mismatch.join("; ")}\nrun \`forge compat\` against this deployment before invoking it\n`); return EXIT.CONTRACT; }
    const s = await io.fetch(`${base}/forge/openapi.json`, { headers });
    if (!s.ok) { io.stderr(`forge-api: openapi answered ${s.status}\n`); return EXIT.TRANSPORT; }
    const doc = (await s.json()) as { paths: Record<string, Record<string, { operationId: string; "x-forge-kind"?: string }>> };
    const ops: { operation: string; method: string; path: string; kind: string; mutation: boolean }[] = [];
    for (const [path, byMethod] of Object.entries(doc.paths)) {
      for (const [method, op] of Object.entries(byMethod)) {
        const kind = op["x-forge-kind"] ?? "function";
        ops.push({ operation: op.operationId, method: method.toUpperCase(), path, kind, mutation: MUTATIONS.has(kind) || method.toUpperCase() !== "GET" });
      }
    }
    ops.sort((x, y) => x.operation.localeCompare(y.operation));
    return { discovery, ops };
  };

  const table = await load();
  if (typeof table === "number") return table;
  if (command === "discovery") { io.stdout(canonical(table.discovery) + "\n"); return EXIT.OK; }
  if (command === "operations") { io.stdout(canonical(table.ops) + "\n"); return EXIT.OK; }

  // Operation resolution: full id, or the part after `/_/` (`Customer.create`, `SubmitOrder`).
  const op = table.ops.find((o) => o.operation === command) ?? table.ops.find((o) => o.operation.slice(o.operation.lastIndexOf("/_/") + 3) === command);
  if (!op) { io.stderr(`forge-api: unknown operation ${command} (see \`forge-api operations\`)\n`); return EXIT.USAGE; }

  // Input assembly, left to right: file, stdin, then --set overrides.
  let input: Record<string, unknown> = {};
  const merge = (v: unknown, from: string) => {
    if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error(`${from} must be a JSON object`);
    input = { ...input, ...(v as Record<string, unknown>) };
  };
  try {
    if (args.file) merge(JSON.parse(readFileSync(args.file, "utf8")), args.file);
    if (args.stdin) { const text = await io.stdin(); if (text.trim()) merge(JSON.parse(text), "stdin"); }
  } catch (e) {
    io.stderr(`forge-api: ${(e as Error).message}\n`);
    return EXIT.USAGE;
  }
  for (const [path, value] of args.sets) setPath(input, path, value);
  input = sortKeys(input) as Record<string, unknown>;

  if (args.dryRun) {
    io.stdout(canonical({ operation: op.operation, method: op.method, path: op.path, input }) + "\n");
    return EXIT.OK;
  }
  if (op.mutation && !args.yes && io.env["FORGE_API_YES"] !== "1") {
    io.stderr(`forge-api: ${op.operation} is a mutation (${op.method} ${op.path}); pass --yes or set FORGE_API_YES=1 to run it\n`);
    return EXIT.REFUSED;
  }

  const callable = httpCallable({ baseUrl: base, credential: cred, fetch: io.fetch });
  const outcome: Outcome = await callable.invoke(op.operation, input, { ...(args.purpose ? { purpose: args.purpose } : {}), ...(args.idempotencyKey ? { idempotencyKey: args.idempotencyKey } : {}) });
  switch (outcome.kind) {
    case "ok":
      io.stdout(canonical(outcome.value) + "\n");
      return EXIT.OK;
    case "error":
      io.stderr(`forge-api: ${outcome.problem.code}: ${outcome.problem.detail ?? outcome.problem.title ?? ""}\n${canonical(outcome.problem)}\n`);
      return EXIT.PROBLEM;
    case "invocationFailed":
      io.stderr(`forge-api: ${outcome.reason}: ${outcome.detail}\n`);
      return outcome.reason === "contract-mismatch" ? EXIT.CONTRACT : outcome.reason === "unauthenticated" ? EXIT.AUTH : EXIT.TRANSPORT;
  }
}

/** Preview of the HTTP request an input would produce (used by `--dry-run` consumers and tests). */
export { toHttpRequest };
