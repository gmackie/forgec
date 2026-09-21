/**
 * RELEASE_MANIFEST.json (FORGE-091; PAR-176/179). Assembles, from retained
 * evidence only, the exact combinations this repository certifies: version
 * pins (compiler, runtime, drivers, protocol generators, taxonomy), each
 * advertised profile with its feature set and the evidence it rests on, the
 * profiles that are *not* certified with the reason, expiry and retest rules.
 * It refuses to say "all profiles passed" whenever any required profile was
 * skipped or failed, and it never turns bounded evidence into a blanket claim.
 *
 *   node --experimental-strip-types scripts/release-manifest.ts [--out RELEASE_MANIFEST.json]
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

export interface ManifestInput {
  root: string;
  now?: string;
  /** Override retained artifacts (tests). */
  certification?: Record<string, unknown> | null;
  differential?: { drift: string; profiles: { name: string; ran: boolean; reason?: string; failures: number }[] } | null;
  matrix?: { profiles: { id: string; tuple: Record<string, string>; status: string; evidence?: unknown[]; reason?: string; contract?: string }[] } | null;
  benchmarks?: Record<string, unknown> | null;
  status?: { milestones: Record<string, { status: string }> } | null;
}

const read = <T>(p: string): T | null => (existsSync(p) ? (JSON.parse(readFileSync(p, "utf8")) as T) : null);
const toml = (p: string, key: string): string | null => { const m = new RegExp(`^${key}\\s*=\\s*"([^"]+)"`, "m").exec(existsSync(p) ? readFileSync(p, "utf8") : ""); return m ? m[1]! : null; };

export function buildManifest(i: ManifestInput): Record<string, unknown> {
  const root = i.root;
  const certification = i.certification === undefined ? read<Record<string, unknown>>(resolve(root, "conformance", "certification", "latest.json")) : i.certification;
  const differential = i.differential === undefined ? read<NonNullable<ManifestInput["differential"]>>(resolve(root, "conformance", "reports", "differential.json")) : i.differential;
  const matrix = i.matrix === undefined ? read<NonNullable<ManifestInput["matrix"]>>(resolve(root, "specs", "profiles", "matrix.json")) : i.matrix;
  const benchmarks = i.benchmarks === undefined ? read<Record<string, unknown>>(resolve(root, "conformance", "benchmarks", "governance-overhead.json")) : i.benchmarks;
  const status = i.status === undefined ? read<NonNullable<ManifestInput["status"]>>(resolve(root, "docs", "post-m8", "STATUS.json")) : i.status;
  const pkg = (p: string) => read<{ version?: string; dependencies?: Record<string, string>; devDependencies?: Record<string, string> }>(resolve(root, p));
  const runtimePkg = pkg("packages/runtime/package.json");
  const interfacesPkg = pkg("packages/interfaces/package.json");
  const now = i.now ?? new Date().toISOString();

  const pins = {
    compiler: { crate: "forge-cli", version: toml(resolve(root, "Cargo.toml"), "version"), rustVersion: toml(resolve(root, "Cargo.toml"), "rust-version"), ir: "domain-ir/1", contracts: "contracts/1", bundle: "app-bundle/1", knownFeatures: ["governance/1"] },
    runtime: { package: "@forge/runtime", version: runtimePkg?.version ?? null, effect: runtimePkg?.dependencies?.["effect"] ?? null, typescript: runtimePkg?.devDependencies?.["typescript"] ?? null, node: process.version, pg: runtimePkg?.dependencies?.["pg"] ?? null, drizzle: runtimePkg?.dependencies?.["drizzle-orm"] ?? null, awsSdk: runtimePkg?.dependencies?.["@aws-sdk/client-dynamodb"] ?? null },
    interfaces: { package: "@forge/interfaces", version: interfacesPkg?.version ?? null, openapi: "3.1.0", smithy: "2.0", mcp: ["2025-06-18", "2025-03-26"], discovery: "forge-discovery/1", sdks: { python: "stdlib (>= 3.10)", go: "module forge.dev/interfaces/sdk-go (go 1.22)" } },
    governance: { taxonomy: read<{ version: string }>(resolve(root, "packages", "contracts", "data-core", "taxonomy.json"))?.version ?? null, capabilityManifests: ["d1", "dynamodb"], policy: "forge-policies (local authorizer) / opaque bundles compared by digest", grants: "dependency-grant/1", snapshots: "snapshot/1" },
    iac: { terraform: { cloudflare: "5.4.0", aws: "5.100.0" }, cdk: read<{ dependencies?: Record<string, string> }>(resolve(root, "examples", "acme", "package.json"))?.dependencies?.["aws-cdk-lib"] ?? null, wrangler: runtimePkg?.devDependencies?.["wrangler"] ?? null },
  };

  const required = ["cloudflare-d1", "aws-dynamodb", "node-postgres", "sqlite-node", "runtime-memory"];
  const combos: Record<string, unknown>[] = [];
  const targets = (certification?.["targets"] ?? {}) as Record<string, { scenarios: { ok: boolean; count: number; steps: number }; realtime: boolean; bench?: unknown }>;
  const certAt = certification?.["at"] as string | undefined;
  // Live evidence is bound to the build it ran against: a different current build makes it stale, not transferable.
  const currentBuild = read<{ buildHash: string }>(resolve(root, "conformance", "fixtures", "acme.app.json"))?.buildHash ?? null;
  const certBuild = (certification?.["buildHash"] as string | undefined) ?? null;
  const buildMatches = currentBuild !== null && certBuild === currentBuild;
  const expired = certAt ? Date.parse(now) - Date.parse(certAt) > 90 * 86_400_000 : true;
  for (const name of ["cloudflare-d1", "aws-dynamodb"]) {
    const t = targets[name];
    const m = matrix?.profiles.find((p) => p.tuple["engine"] === name || p.id.startsWith(name));
    const passed = Boolean(t && t.scenarios.ok && t.realtime && certification?.["certified"]);
    const reason = !t ? "no live certification run retained for this target" : !passed ? "the retained live run did not pass" : !buildMatches ? `live certification is for build ${certBuild?.slice(0, 12)}; the current build is ${currentBuild?.slice(0, 12)}: re-run pnpm certify` : expired ? "live certification is older than the 90-day retest window" : null;
    combos.push({ profile: name, tuple: m?.tuple ?? null, status: reason ? "unverified" : "certified", features: ["crud", "changesets", "blobs", "imports", "messaging", "views/projections/caches", "workflows", "schedules", "realtime", "portability", "interfaces"], evidence: t ? [{ suite: "conformance (live)", scenarios: t.scenarios.count, steps: t.scenarios.steps, realtime: t.realtime, at: certAt, build: certBuild, ref: "conformance/certification/latest.json" }] : [], ...(reason ? { reason } : {}) });
  }
  const diffProfile = (name: string) => differential?.profiles.find((p) => p.name === name);
  for (const name of ["node-postgres", "sqlite-node", "runtime-memory"]) {
    const d = diffProfile(name);
    const m = matrix?.profiles.find((p) => p.id.startsWith(name === "node-postgres" ? "postgres-17" : name));
    const ok = Boolean(d && d.ran && d.failures === 0 && differential?.drift === "none");
    combos.push({ profile: name, tuple: m?.tuple ?? null, status: ok ? "certified" : "unverified", features: name === "runtime-memory" ? ["semantic reference"] : ["crud", "changesets", "blobs", "imports", "messaging", "views/projections/caches", "workflows", "schedules", "portability", "interfaces", ...(name === "node-postgres" ? ["realtime", "durable restart (PAR-153)"] : [])], evidence: d && d.ran ? [{ suite: "differential", failures: d.failures, drift: differential?.drift, ref: "conformance/reports/differential.json" }, ...(m?.evidence ?? [])] : [], ...(d && !d.ran ? { reason: d.reason } : {}), ...(m?.contract ? { contract: m.contract } : {}) });
  }
  // everything else in the matrix that is not certified is listed as such, with its reason
  const notCertified = (matrix?.profiles ?? []).filter((p) => p.status !== "certified").map((p) => ({ profile: p.id, status: p.status, reason: p.reason ?? null }));
  const requiredMissing = required.filter((r) => combos.find((c) => c["profile"] === r)?.["status"] !== "certified");
  const milestones = status?.milestones ?? {};
  const partialTickets = Object.entries(milestones).filter(([, m]) => m.status !== "done").map(([k, m]) => `${k}: ${m.status}`);

  return {
    version: "release-manifest/1",
    generatedAt: now,
    allRequiredProfilesCertified: requiredMissing.length === 0,
    ...(requiredMissing.length ? { incomplete: { requiredNotCertified: requiredMissing, note: "this release does not claim full profile support; see each entry's reason" } } : {}),
    pins,
    combinations: combos,
    notCertified,
    milestones: { done: Object.entries(milestones).filter(([, m]) => m.status === "done").map(([k]) => k), other: partialTickets },
    benchmarks: benchmarks ? { ref: "conformance/benchmarks/governance-overhead.json", at: benchmarks["at"], note: "per-profile measurements with workload definitions and limits; no cross-machine or parity claim" } : null,
    migration: { fromM8: "docs/upgrade-edition.md (forge upgrade-edition proposals; old edition stays explicit)", provider: "docs/provider-cutover.md", grants: "docs/grant-lifecycle.md" },
    retest: { expiryDays: 90, rule: "evidence older than 90 days is stale: the combination drops to unverified until the suites run again on the pinned versions; any pin change (compiler, runtime, driver, provider version, taxonomy, protocol) requires a retest before the combination is advertised", signing: "sign this manifest with the release key in CI (signEvidence); an unsigned manifest is a draft" },
    disclaimer: "Certified means the listed suites passed on the listed versions in the listed window. It is not a statement of regulatory compliance and does not extend to combinations not listed here.",
  };
}

if (process.argv[1] && /release-manifest\.ts$/.test(process.argv[1])) {
  const root = resolve(import.meta.dirname, "..");
  const out = process.argv.includes("--out") ? process.argv[process.argv.indexOf("--out") + 1]! : resolve(root, "RELEASE_MANIFEST.json");
  const manifest = buildManifest({ root });
  writeFileSync(out, JSON.stringify(manifest, null, 2) + "\n");
  console.error(JSON.stringify({ allRequiredProfilesCertified: manifest["allRequiredProfilesCertified"], incomplete: manifest["incomplete"] ?? null, combinations: (manifest["combinations"] as { profile: string; status: string }[]).map((c) => `${c.profile}: ${c.status}`) }, null, 2));
}
