/**
 * FORGE-055 / PAR-122: the generic API CLI has a stable machine contract.
 * Input from flags, a JSON file or stdin canonicalizes identically; stdout
 * carries only data, stderr only diagnostics; exit codes are fixed; mutations
 * are guarded; credentials never come from argv in the default profile.
 */
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFileSync, chmodSync } from "node:fs";
import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MemoryStorage, type AppBundle } from "@forge/runtime";
import { createNodeHost, type NodeHost } from "@forge/runtime/node";
import { externals, functions } from "../../../examples/acme/impl/index.js";
import { EXIT, runCli, type CliIo } from "../src/cli.js";

const bundle = JSON.parse(readFileSync(resolve(import.meta.dirname, "..", "..", "..", "conformance", "fixtures", "acme.app.json"), "utf8")) as AppBundle;

describe("PAR-122: CLI stable machine contract", () => {
  let host: NodeHost;
  let base: string;
  const dir = mkdtempSync(join(tmpdir(), "forge-cli-"));
  beforeAll(async () => {
    host = createNodeHost({ bundle, store: new MemoryStorage(), functions, externals, cursorSecret: "cli-test", sweepIntervalMs: 0, telemetryFormat: "silent" });
    base = (await host.listen(0)).url;
  });
  afterAll(async () => { await host?.stop(); });

  const run = async (argv: string[], o: { stdin?: string; env?: Record<string, string> } = {}) => {
    let out = "";
    let err = "";
    const io: CliIo = {
      stdin: async () => o.stdin ?? "",
      stdout: (s) => { out += s; },
      stderr: (s) => { err += s; },
      env: { FORGE_API_URL: base, FORGE_API_DEV_TENANT: "cli", FORGE_API_DEV_ACTOR: "operator", ...(o.env ?? {}) },
      fetch,
    };
    const code = await runCli(argv, io);
    return { code, out, err };
  };

  it("flags, a JSON file and stdin canonicalize to the same request; stdout is data only", async () => {
    const file = join(dir, "customer.json");
    writeFileSync(file, JSON.stringify({ name: "From File", code: "file" }));
    const a = await run(["Customer.create", "--set", "code=flags", "--set", "name=From Flags", "--yes"]);
    const b = await run(["Customer.create", "--file", file, "--yes"]);
    const c = await run(["Customer.create", "--stdin", "--yes"], { stdin: JSON.stringify({ code: "stdin", name: "From Stdin" }) });
    for (const r of [a, b, c]) {
      expect(r.code).toBe(EXIT.OK);
      expect(r.err).toBe("");
      const parsed = JSON.parse(r.out) as { code: string; version: number };
      expect(parsed.version).toBe(1);
      // canonical JSON: sorted keys, one trailing newline, nothing else on stdout
      expect(r.out).toBe(JSON.stringify(parsed, Object.keys(parsed).sort()) + "\n");
    }
    expect(JSON.parse(a.out).code).toBe("FLAGS");
    expect(JSON.parse(b.out).code).toBe("FILE");
    expect(JSON.parse(c.out).code).toBe("STDIN");
    // --dry-run prints the canonical request instead of sending it, identical for all three input modes
    const d1 = await run(["Customer.create", "--set", "code=same", "--set", "name=Same", "--dry-run"]);
    const d2 = await run(["Customer.create", "--stdin", "--dry-run"], { stdin: '{"name":"Same","code":"same"}' });
    expect(d1.out).toBe(d2.out);
    expect(JSON.parse(d1.out)).toEqual({ operation: "@acme/commerce/_/Customer.create", method: "POST", path: "/v1/customers", input: { code: "same", name: "Same" } });
  });

  it("typed flags: --set parses numbers, booleans, null and nested paths; --set-string keeps text", async () => {
    const r = await run(["Customer.update", "--set", "id=cus_0001", "--set", "expectedVersion=1", "--set", "patch.tier=gold", "--set-string", "patch.name=42", "--dry-run"]);
    expect(r.code).toBe(EXIT.OK);
    expect(JSON.parse(r.out).input).toEqual({ id: "cus_0001", expectedVersion: 1, patch: { tier: "gold", name: "42" } });
  });

  it("failures: stdout stays empty, stderr carries the Problem as one JSON line, exit codes are stable", async () => {
    const bad = await run(["Customer.create", "--set", "code=x", "--set", "name=", "--yes"]);
    expect(bad.code).toBe(EXIT.PROBLEM);
    expect(bad.out).toBe("");
    const line = bad.err.trim().split("\n").at(-1)!;
    expect(JSON.parse(line)).toMatchObject({ code: "ValidationFailed", status: 422 });
    const usage = await run(["--nope"]);
    expect(usage.code).toBe(EXIT.USAGE);
    expect(usage.out).toBe("");
    const unknown = await run(["Nope.go", "--yes"]);
    expect(unknown.code).toBe(EXIT.USAGE);
    expect(unknown.err).toMatch(/unknown operation/);
    const dead = await run(["Customer.get", "--set", "id=x"], { env: { FORGE_API_URL: "http://127.0.0.1:9" } });
    expect(dead.code).toBe(EXIT.TRANSPORT);
    expect(dead.out).toBe("");
  });

  it("guarded mutations: a write without --yes (or FORGE_API_YES) is refused before any request; reads need no guard", async () => {
    const refused = await run(["Customer.create", "--set", "code=guard", "--set", "name=Guard"]);
    expect(refused.code).toBe(EXIT.REFUSED);
    expect(refused.out).toBe("");
    expect(refused.err).toMatch(/--yes/);
    const notCreated = await run(["Customer.find.byCode", "--set", "params.code=guard"]);
    expect(notCreated.code).toBe(EXIT.PROBLEM);
    expect(JSON.parse(notCreated.err.trim().split("\n").at(-1)!).code).toBe("NotFound");
    const viaEnv = await run(["Customer.create", "--set", "code=guard", "--set", "name=Guard"], { env: { FORGE_API_YES: "1" } });
    expect(viaEnv.code).toBe(EXIT.OK);
    const read = await run(["Customer.find.byCode", "--set", "params.code=guard"]);
    expect(read.code).toBe(EXIT.OK);
    expect(JSON.parse(read.out).code).toBe("GUARD");
  });

  it("contract expectation: a digest mismatch is a distinct exit and no operation runs", async () => {
    const r = await run(["Customer.create", "--set", "code=never", "--set", "name=Never", "--yes", "--expect-wire", "deadbeef"]);
    expect(r.code).toBe(EXIT.CONTRACT);
    expect(r.out).toBe("");
    expect(r.err).toMatch(/forge compat/);
    const ok = await run(["Customer.find.byCode", "--set", "params.code=never", "--expect-wire", bundle.digests!["wire"]!]);
    expect(ok.code).toBe(EXIT.PROBLEM); // NotFound: nothing was created by the refused call
  });

  it("credentials: bearer token comes from the environment or a private file, never from argv", async () => {
    const tokenFile = join(dir, "token");
    writeFileSync(tokenFile, "abc.def.ghi\n");
    chmodSync(tokenFile, 0o644);
    const loose = await run(["Customer.list.all", "--token-file", tokenFile], { env: { FORGE_API_DEV_TENANT: "", FORGE_API_DEV_ACTOR: "" } });
    expect(loose.code).toBe(EXIT.USAGE);
    expect(loose.err).toMatch(/readable by others/);
    const argv = await run(["Customer.list.all", "--token", "abc"]);
    expect(argv.code).toBe(EXIT.USAGE);
    expect(argv.err).toMatch(/FORGE_API_TOKEN/);
    chmodSync(tokenFile, 0o600);
    const strict = await run(["Customer.list.all", "--token-file", tokenFile], { env: { FORGE_API_DEV_TENANT: "", FORGE_API_DEV_ACTOR: "" } });
    // the dev-header host does not accept bearer tokens: an authentication failure, reported as such
    expect(strict.code).toBe(EXIT.AUTH);
  });

  it("`operations` lists the deployment's operations from its OpenAPI projection, as data", async () => {
    const r = await run(["operations"]);
    expect(r.code).toBe(EXIT.OK);
    const ops = JSON.parse(r.out) as { operation: string; method: string; path: string; kind: string }[];
    expect(ops.find((o) => o.operation === "@acme/commerce/_/Customer.update")).toEqual({ operation: "@acme/commerce/_/Customer.update", method: "PATCH", path: "/v1/customers/{id}", kind: "update", mutation: true });
  });
});
