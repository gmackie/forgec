/**
 * FORGE-074/075 / PAR-151, PAR-152, PAR-154: one resolved plan feeds the native
 * and Terraform projections (same resources, bindings, ownership, one state
 * owner); Docker/Nix artifacts carry only secret references; adopted or
 * authoritative resources are retained on destroy unless explicitly approved.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import type { AppBundle } from "@forgegraph/runtime";
import { destroyPlan, resolvePlan } from "../src/deployment-plan.js";
import { emitSelfHosted } from "../src/self-hosted.js";
import { emitTerraform, nativeProjection, terraformProjection } from "../src/terraform.js";

const bundle = JSON.parse(readFileSync(resolve(import.meta.dirname, "..", "..", "..", "conformance", "fixtures", "acme.app.json"), "utf8")) as AppBundle;

function has(cmd: string): boolean {
  try { execFileSync(cmd, ["version"], { stdio: "ignore" }); return true; } catch { return false; }
}

describe("PAR-151: Terraform and native projections satisfy the same resolved plan", () => {
  for (const target of ["cloudflare", "aws"] as const) {
    it(`${target}: same resources, bindings and ownership; exactly one state owner; adopted resources are imported, not created`, () => {
      const plan = resolvePlan(bundle, { target, stage: "dev", stateOwner: "terraform", adopt: target === "cloudflare" ? { database: "00000000-0000-0000-0000-000000000000" } : { table: "arn:aws:dynamodb:us-east-1:123:table/existing" } });
      const pack = emitTerraform(plan);
      const native = nativeProjection(plan);
      const tf = terraformProjection(plan, pack);
      // what the provider cannot express is named, and everything else matches the native projection exactly
      const gaps = new Set(pack.unsupported.map((u) => u.id));
      if (target === "cloudflare") expect(pack.unsupported.map((u) => u.kind)).toEqual(["cloudflare_workflow"]);
      else expect(pack.unsupported).toEqual([]);
      expect(tf.resources).toEqual(native.resources.filter((r) => !gaps.has(r.id)));
      const nativeBindings = Object.fromEntries(Object.entries(native.bindings).filter(([, v]) => !v.startsWith("workflow:")));
      expect(tf.bindings).toEqual(nativeBindings);
      // the plan names one owner; the native emitter would refuse the same plan
      expect(plan.stateOwner).toBe("terraform");
      expect(() => emitTerraform({ ...plan, stateOwner: "native" })).toThrow(/state owner/);
      // adopted resources: import block + prevent_destroy, never a fresh create without adoption
      const resources = JSON.parse(pack.files["resources.tf.json"]!) as { resource: Record<string, Record<string, { lifecycle?: { prevent_destroy: boolean } }>>; import?: { to: string; id: string }[] };
      expect(resources.import).toHaveLength(1);
      const adopted = plan.resources.find((r) => r.ownership === "adopted")!;
      expect(resources.import![0]!.id).toBe(adopted.adoptId);
      expect(resources.resource[adopted.kind]![adopted.id]!.lifecycle).toEqual({ prevent_destroy: true });
      // providers are pinned and secrets are sensitive variables with references only
      const providers = JSON.parse(pack.files["providers.tf.json"]!) as { terraform: { required_providers: Record<string, { version: string }> } };
      for (const p of Object.values(providers.terraform.required_providers)) expect(p.version).toMatch(/^\d+\.\d+\.\d+$/);
      const variables = JSON.parse(pack.files["variables.tf.json"]!) as { variable: Record<string, { sensitive?: boolean; default?: unknown; description?: string }> };
      for (const s of plan.secrets) {
        expect(variables.variable[s.env.toLowerCase()]).toMatchObject({ sensitive: true });
        expect(variables.variable[s.env.toLowerCase()]!.default).toBeUndefined();
      }
      // migrations are a separate job driven by the ledger, keyed by the artifact digest
      const mig = JSON.parse(pack.files["migrations.tf.json"]!) as { resource: { null_resource: Record<string, { triggers: { artifact: string } }> } };
      expect(Object.values(mig.resource.null_resource)[0]!.triggers.artifact).toBe(bundle.buildHash);
      // every file is valid JSON in Terraform's JSON syntax (validated with the CLI when providers are available offline)
      for (const [name, text] of Object.entries(pack.files)) if (name.endsWith(".json")) JSON.parse(text);
    });
  }

  for (const target of ["aws", "cloudflare"] as const) it.skipIf(!has("terraform") || !process.env["FORGE_TF_VALIDATE"])(`terraform validate accepts the ${target} pack (FORGE_TF_VALIDATE=1; needs provider plugins)`, () => {
    const plan = resolvePlan(bundle, { target, stage: "dev", stateOwner: "terraform" });
    const pack = emitTerraform(plan);
    const dir = mkdtempSync(join(tmpdir(), "forge-tf-"));
    for (const [name, text] of Object.entries(pack.files)) { mkdirSync(join(dir, dirname(name)), { recursive: true }); writeFileSync(join(dir, name), text); }
    execFileSync("terraform", ["init", "-backend=false", "-input=false"], { cwd: dir, stdio: "ignore" });
    const out = execFileSync("terraform", ["validate", "-json"], { cwd: dir, encoding: "utf8" });
    expect(JSON.parse(out).valid).toBe(true);
  }, 120_000);
});

describe("PAR-154: imported resource retention", () => {
  it("destroy never includes adopted or authoritative resources without explicit per-resource approval", () => {
    const plan = resolvePlan(bundle, { target: "aws", stage: "preview-42", stateOwner: "terraform", adopt: { bucket: "customer-blobs" } });
    const d = destroyPlan(plan);
    expect(d.retained.map((r) => r.id).sort()).toEqual(["blobs", "dlq", "table"]);
    expect(d.retained.find((r) => r.id === "blobs")!.reason).toMatch(/adopted/);
    expect(d.destroy).toContain("api");
    expect(d.destroy).not.toContain("table");
    // an explicit approval names the resource; nothing else changes
    const approved = destroyPlan(plan, { approveDestroy: ["table"] });
    expect(approved.destroy).toContain("table");
    expect(approved.retained.map((r) => r.id).sort()).toEqual(["blobs", "dlq"]);
  });
});

describe("PAR-152: secret-free Docker and Nix artifacts", () => {
  it("the pack references secrets by name/file only; a secret value handed to the operator never appears in any artifact", () => {
    const plan = resolvePlan(bundle, { target: "self-hosted", stage: "prod", stateOwner: "self-hosted", secrets: ["FORGE_CURSOR_SECRET", "FORGE_JWT_SECRET", "SIGNING_KEY"] });
    const pack = emitSelfHosted(plan);
    // the emitter has no parameter that could carry a value; simulate an operator's real secrets and scan
    const values = ["s3cr3t-cursor-value", "jwt-hmac-9f8e7d", "-----BEGIN PRIVATE KEY-----", "postgres://forge:hunter2@db/forge"];
    for (const text of Object.values(pack.files)) for (const v of values) expect(text).not.toContain(v);
    expect(pack.files["Dockerfile"]).toMatch(/USER forge/);
    expect(pack.files["Dockerfile"]).toMatch(/FORGE_JWT_SECRET_FILE=\/run\/secrets\/FORGE_JWT_SECRET/);
    expect(pack.files["Dockerfile"]).not.toMatch(/ARG .*SECRET|ENV .*SECRET=(?!.*_FILE)/);
    const compose = JSON.parse(pack.files["compose.yaml"]!) as { services: Record<string, { secrets: string[] }>; secrets: Record<string, { external: boolean }>; "x-forge": { workflows: string } };
    expect(compose.secrets["SIGNING_KEY"]).toEqual({ external: true });
    expect(compose.services["api"]!.secrets).toContain("FORGE_PG_URL");
    // Compose does not claim a workflow engine
    expect(compose["x-forge"].workflows).toMatch(/no workflow engine/);
    expect(emitSelfHosted(plan, { temporal: true }).files["compose.yaml"]).toContain("temporalio/auto-setup:1.25.0");
    // the Nix module loads credentials with systemd, never from the store
    expect(pack.files["flake.nix"]).toMatch(/LoadCredential/);
    expect(pack.files["flake.nix"]).not.toMatch(/password|token=/i);
    expect(pack.secrets.map((s) => s.name)).toEqual(["FORGE_CURSOR_SECRET", "FORGE_JWT_SECRET", "SIGNING_KEY"]);
  });

  it.skipIf(!has("nix") || !process.env["FORGE_NIX_EVAL"])("the flake evaluates (FORGE_NIX_EVAL=1)", () => {
    const plan = resolvePlan(bundle, { target: "self-hosted", stage: "prod", stateOwner: "self-hosted" });
    const pack = emitSelfHosted(plan);
    const dir = mkdtempSync(join(tmpdir(), "forge-nix-"));
    writeFileSync(join(dir, "flake.nix"), pack.files["flake.nix"]!);
    execFileSync("nix", ["flake", "show", "--no-write-lock-file", dir], { stdio: "ignore" });
  });
});
