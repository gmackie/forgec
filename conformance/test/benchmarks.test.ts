/**
 * FORGE-089 / PAR-177: measured, per-profile overhead of governance. The
 * same workload runs with governance off (edition 2026 acme, no authorizer)
 * and on (edition 2027 acme-next: purpose surfaces + authorizer + PIP), on the
 * memory and sqlite-node profiles. Figures are recorded as observed with the
 * workload definition; nothing infers equal latency, and write amplification
 * is counted from the commit plans themselves.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { Effect } from "effect";
import { localAuthorizer, type AppBundle, type CallContext, type Policy } from "@forge/runtime";
import { ProfileTarget } from "../src/profile-target.js";

const acme = JSON.parse(readFileSync(resolve(import.meta.dirname, "..", "fixtures", "acme.app.json"), "utf8")) as AppBundle;
const next = JSON.parse(readFileSync(resolve(import.meta.dirname, "..", "fixtures", "acme-next.app.json"), "utf8")) as AppBundle;
const ddl = resolve(import.meta.dirname, "..", "fixtures", "acme-next.0001_init.sql");
const N = "@acme/commerce-next/_";
const G = "@acme/governance/_";

function stats(xs: number[]) {
  const s = [...xs].sort((a, b) => a - b);
  const q = (p: number) => s[Math.min(s.length - 1, Math.floor(p * s.length))]!;
  return { n: s.length, p50: +q(0.5).toFixed(3), p95: +q(0.95).toFixed(3), p99: +q(0.99).toFixed(3), max: +(s[s.length - 1] ?? 0).toFixed(3) };
}

describe("governance overhead benchmarks", () => {
  it("records baseline vs governed latency, PIP/decision cache behaviour and write amplification per profile", async () => {
    const WARM = 50;
    const ITER = 300;
    const out: Record<string, unknown> = { version: "benchmarks/1", at: new Date().toISOString(), node: process.version, workload: { warmup: WARM, iterations: ITER, ops: ["Contact.get (point read)", "Contact.update (write)"], note: "single process, in-memory object store, one tenant; latencies are wall-clock per engine.call in ms; not comparable across machines" }, profiles: {} as Record<string, unknown> };
    for (const profile of ["runtime-memory", "sqlite-node"] as const) {
      // baseline: acme (edition 2026), no purposes, no authorizer
      const base = new ProfileTarget({ bundle: acme, profile });
      const bctx = { tenant: "b", actor: "a" };
      const bc = (await base.call("@acme/commerce/_/Customer.create", { code: "BENCH", name: "B" }, bctx)) as { ok: true; value: { id: string } };
      const readBase: number[] = [];
      const writeBase: number[] = [];
      let version = 1;
      for (let i = 0; i < WARM + ITER; i++) {
        let t = performance.now();
        await base.call("@acme/commerce/_/Customer.get", { id: bc.value.id }, bctx);
        if (i >= WARM) readBase.push(performance.now() - t);
        t = performance.now();
        const r = (await base.call("@acme/commerce/_/Customer.update", { id: bc.value.id, expectedVersion: version, patch: { name: `B${i}` } }, bctx)) as { ok: boolean; value?: { version: number } };
        if (r.ok) version = r.value!.version;
        if (i >= WARM) writeBase.push(performance.now() - t);
      }
      // same app, two modes: acme-next (edition 2027) unguarded (maintenance context, no authorizer) vs governed
      // (purpose surface + authorizer with a PIP requirement). Only this pair isolates the cost of governance;
      // the acme baseline above differs in downstream work (change events, projections) and is reported as context.
      const gov = new ProfileTarget({ bundle: next, profile, ddlFile: ddl });
      const seed: CallContext & { maintenance: true } = { tenant: "g", actor: "maintenance", requestId: "seed", maintenance: true };
      const c = (await gov.call(`${N}/Customer.create`, { code: "BENCH", name: "B" }, seed)) as { ok: true; value: { id: string } };
      const k = (await gov.call(`${N}/Contact.create`, { customer: c.value.id, name: "Pat", email: "pat@example.com" }, seed)) as { ok: true; value: { id: string } };
      const loop = async (ctx: object, label: string) => {
        const reads: number[] = [];
        const writes: number[] = [];
        let failures = 0;
        let v = ((await gov.call(`${N}/Contact.get`, { id: k.value.id }, seed)) as { ok: true; value: { version: number } }).value.version;
        for (let i = 0; i < WARM + ITER; i++) {
          let t = performance.now();
          const g = await gov.call(`${N}/Contact.get`, { id: k.value.id }, ctx as never);
          if (i >= WARM) reads.push(performance.now() - t);
          if (!g.ok) failures++;
          t = performance.now();
          const r = (await gov.call(`${N}/Contact.update`, { id: k.value.id, expectedVersion: v, patch: { email: `${label}${i}@example.com` } }, ctx as never)) as { ok: boolean; value?: { version: number } };
          if (r.ok) v = r.value!.version;
          else failures++;
          if (i >= WARM) writes.push(performance.now() - t);
        }
        // every measured call must have succeeded: a fast failure is not a fast operation
        expect(failures).toBe(0);
        return { read: stats(reads), write: stats(writes) };
      };
      const unguardedFirst = await loop(seed, "u");
      const policies: Policy[] = [{ id: "support", actions: [`${N}/Contact.*`], purpose: `${G}/CustomerSupport`, requires: [{ pip: "hr", attribute: "team" }], where: [] }];
      gov.engine.gatekeeper.authorizer = localAuthorizer({ policies, pips: [{ name: "hr", attributes: { agent: { team: "support" } }, freshnessMs: 60_000 }], epoch: 1, knownObligations: [] });
      const gctx = { tenant: "g", actor: "agent", purpose: `${G}/CustomerSupport` };
      const governed = await loop(gctx, "g");
      const cache = gov.engine.gatekeeper.cacheStats();
      // a second unguarded pass after the governed one: JIT/GC order effects are visible as the two unguarded passes
      gov.engine.gatekeeper.authorizer = null;
      const unguarded = await loop(seed, "u2");
      // write amplification: physical rows touched by one logical update (record + audit + claims + outbox), from the plan
      const current = (await gov.call(`${N}/Contact.get`, { id: k.value.id }, seed)) as { ok: true; value: { version: number } };
      const plan = await Effect.runPromise(gov.engine.planFor(`${N}/Contact.update`, { id: k.value.id, expectedVersion: current.value.version, patch: { email: "amp@example.com" } }, { ...gctx, requestId: "amp" }).pipe(Effect.provide(gov.engine.layer)) as unknown as Effect.Effect<{ claims: unknown[]; outbox: unknown[] }, never, never>);
      const amplification = { record: 1, audit: 1, claims: plan.claims.length, outbox: plan.outbox.length, total: 2 + plan.claims.length + plan.outbox.length };
      (out["profiles"] as Record<string, unknown>)[profile] = {
        context: { app: "@acme/commerce (edition 2026)", baseline: { read: stats(readBase), write: stats(writeBase) }, note: "different downstream work (change events, projections): context only, not a governance ratio" },
        sameApp: { app: "@acme/commerce-next (edition 2027)", order: ["unguardedFirst", "governed", "unguarded"], unguardedFirst, governed, unguarded, governanceOverheadRatio: { readP50: +(governed.read.p50 / Math.max(unguarded.read.p50, 0.001)).toFixed(2), writeP50: +(governed.write.p50 / Math.max(unguarded.write.p50, 0.001)).toFixed(2) } },
        decisionCache: cache,
        writeAmplification: amplification,
      };
      // decision-cache figures are recorded as observed: a workload that bumps the revision on every write
      // sees a miss per revision, which is the design (decisions are keyed by record revision)
      expect(amplification.total).toBeGreaterThanOrEqual(2);
    }
    out["limits"] = [
      "decision cache is bounded by TTL (60s) and epoch only; its size grows with distinct (record, revision) keys decided within the TTL — a write-heavy workload on many records needs the host to size memory accordingly",
      "PIP attributes are gathered per decision from static providers here; a remote PIP adds its own latency per miss",
      "single-process, in-memory object store; no network, no TLS, no cold start: absolute numbers are not deployment latencies",
    ];
    mkdirSync(resolve(import.meta.dirname, "..", "benchmarks"), { recursive: true });
    writeFileSync(resolve(import.meta.dirname, "..", "benchmarks", "governance-overhead.json"), JSON.stringify(out, null, 2) + "\n");
    // figures are recorded, never asserted equal
    expect(JSON.stringify(out)).not.toMatch(/parity|equal latency|no overhead/i);
  }, 120_000);

  it("records catalog rebuild and erasure job cost with their workload definitions", async () => {
    const { MemoryArtifactStore, Registry, generateSigner } = await import("@forge/registry/artifacts");
    const { Catalog } = await import("@forge/registry/catalog");
    const signer = await generateSigner("bench");
    const registry = new Registry({ authority: "bench", store: new MemoryArtifactStore(), trust: { authority: "bench", signers: { bench: signer.publicKey } } });
    const ARTIFACTS = 25;
    for (let i = 0; i < ARTIFACTS; i++) await registry.publish({ name: `@bench/pkg-${i}`, version: "1.0.0", bundle: acme, provenance: { builder: "bench", commit: "c", built_at: "2026-09-21T00:00:00Z" }, signer });
    const t0 = performance.now();
    const catalog = new Catalog({ authority: "bench" });
    const n = await catalog.rebuild(registry);
    const rebuildMs = performance.now() - t0;
    const t1 = performance.now();
    const hits = catalog.search("Customer", { subject: "b", namespaces: ["*"], audiences: ["*"] }).length;
    const searchMs = performance.now() - t1;
    const { planDisposition } = await import("@forge/governance");
    const { RightsExecutor } = await import("@forge/governance");
    const edu = JSON.parse(readFileSync(resolve(import.meta.dirname, "..", "fixtures", "education.app.json"), "utf8")) as AppBundle;
    const t = new ProfileTarget({ bundle: edu, profile: "runtime-memory" });
    const E = "@fixtures/education/_";
    const ctx = { tenant: "e", actor: "dpo" };
    const g = (await t.call(`${E}/Guardian.create`, { name: "Pat", email: "pat@example.com" }, ctx)) as { ok: true; value: { id: string } };
    const s = (await t.call(`${E}/Student.create`, { name: "Ada", guardian: g.value.id }, ctx)) as { ok: true; value: { id: string } };
    const RECORDS = 200;
    for (let i = 0; i < RECORDS; i++) await t.call(`${E}/AttendanceRecord.create`, { student: s.value.id, date: `2026-01-${String((i % 28) + 1).padStart(2, "0")}`, status: "Present", healthNote: `n${i}` }, ctx);
    const ectx: CallContext = { tenant: "e", actor: "dpo", requestId: "erase" };
    const t2 = performance.now();
    const plan = await planDisposition(t.engine, { subject: { kind: "person", resource: `${E}/Student`, id: s.value.id }, disposition: "erasure", ctx: ectx });
    const exec = new RightsExecutor(t.engine, { retention: { stagedArtifacts: "delete-on-revocation" }, chunkSize: 50 });
    await exec.open(ectx, { job: "bench", plan, approval: { by: "dpo", at: "2026-09-21T00:00:00Z" } });
    const report = await exec.advance(ectx, "bench", { check: async () => ({ allowed: true }) });
    const eraseMs = performance.now() - t2;
    expect(report.state).toBe("completed");
    const out = { version: "benchmarks/1", at: new Date().toISOString(), node: process.version, catalog: { workload: `${ARTIFACTS} artifacts (acme bundle each), rebuild from a memory store, one search`, artifacts: n, rebuildMs: +rebuildMs.toFixed(1), searchMs: +searchMs.toFixed(2), hits }, erasure: { workload: `1 student, ${RECORDS} bound attendance records, chunk 50, memory profile`, records: RECORDS, chunks: Math.ceil(RECORDS / 50) + 1, totalMs: +eraseMs.toFixed(1), perRecordMs: +(eraseMs / RECORDS).toFixed(3) } };
    writeFileSync(resolve(import.meta.dirname, "..", "benchmarks", "jobs.json"), JSON.stringify(out, null, 2) + "\n");
  }, 120_000);
});
