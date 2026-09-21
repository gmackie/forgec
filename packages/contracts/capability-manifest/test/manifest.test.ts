/**
 * FORGE-030 / plan §3.3: adapters publish declarative capability manifests;
 * requirements resolve to native | bounded-emulation | unsupported | unknown
 * deterministically; no manifest may execute code or self-certify by
 * returning `true`; pinned digests detect tampering.
 */
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { digestOf, resolveRequirements, validateManifest, type CapabilityManifest, type Requirement } from "../src/index.js";

const dir = resolve(import.meta.dirname, "..", "manifests");
const load = (f: string) => JSON.parse(readFileSync(resolve(dir, f), "utf8")) as CapabilityManifest;
const shuffle = <T>(a: T[], seed: number) => { const out = [...a]; for (let i = out.length - 1; i > 0; i--) { seed = (seed * 9301 + 49297) % 233280; const j = seed % (i + 1); [out[i], out[j]] = [out[j]!, out[i]!]; } return out; };

describe("manifest validation", () => {
  it("accepts the shipped adapter manifests and rejects code-bearing or self-certifying ones", () => {
    for (const f of readdirSync(dir)) expect(validateManifest(load(f)).ok, f).toBe(true);
    const bad = { ...load("d1.json"), main: "./index.js" } as unknown as CapabilityManifest;
    expect(validateManifest(bad)).toMatchObject({ ok: false, errors: [expect.stringMatching(/executable|main/)] });
    const selfCert = structuredClone(load("d1.json")) as CapabilityManifest;
    selfCert.capabilities[0]!.support = "native";
    (selfCert.capabilities[0] as unknown as { evidence: unknown }).evidence = true;
    expect(validateManifest(selfCert).ok).toBe(false);
    const noVersion = structuredClone(load("d1.json")) as unknown as Record<string, unknown>;
    delete noVersion["engine"];
    expect(validateManifest(noVersion as unknown as CapabilityManifest).ok).toBe(false);
  });
  it("digest is stable and independent of key order", () => {
    const m = load("dynamodb.json");
    const reordered = JSON.parse(JSON.stringify(Object.fromEntries(Object.entries(m).reverse()))) as CapabilityManifest;
    expect(digestOf(reordered)).toBe(digestOf(m));
    expect(digestOf({ ...m, adapterVersion: "9.9.9" })).not.toBe(digestOf(m));
  });
});

describe("requirement resolution", () => {
  const reqs: Requirement[] = [
    { id: "mutation.atomic-batch", bound: { actions: 10 } },
    { id: "query.strong-read" },
    { id: "query.unbounded-join" },
    { id: "storage.ttl-cleanup" },
    { id: "workflow.native-driver" },
    { id: "made.up.capability" },
  ];
  it("is deterministic under shuffled manifest and requirement order", () => {
    const manifests = readdirSync(dir).map(load);
    const a = resolveRequirements(reqs, manifests);
    for (const seed of [1, 7, 42]) {
      const b = resolveRequirements(shuffle(reqs, seed), shuffle(manifests, seed + 1));
      expect(JSON.stringify(b)).toBe(JSON.stringify(a));
    }
  });
  it("records native, bounded-emulation, unsupported and unknown with assumptions, never silently relaxing a bound", () => {
    const r = resolveRequirements(reqs, [load("d1.json"), load("dynamodb.json")]);
    const d1 = r.find((x) => x.adapter === "@forgegraph/runtime/d1")!;
    const dyn = r.find((x) => x.adapter === "@forgegraph/runtime/dynamodb")!;
    expect(d1.resolutions["mutation.atomic-batch"]).toMatchObject({ support: "native", bound: { actions: 100 } });
    expect(dyn.resolutions["query.unbounded-join"]).toMatchObject({ support: "unsupported" });
    expect(d1.resolutions["query.unbounded-join"]).toMatchObject({ support: "unsupported" });
    expect(dyn.resolutions["storage.ttl-cleanup"]).toMatchObject({ support: "bounded-emulation" });
    expect(dyn.resolutions["storage.ttl-cleanup"]!.assumptions?.length).toBeGreaterThan(0);
    expect(d1.resolutions["made.up.capability"]).toMatchObject({ support: "unknown" });
    // a requirement whose bound exceeds the manifest's bound is unsupported, not silently clamped
    const tight = resolveRequirements([{ id: "mutation.atomic-batch", bound: { actions: 500 } }], [load("d1.json")]);
    expect(tight[0]!.resolutions["mutation.atomic-batch"]).toMatchObject({ support: "unsupported" });
    expect(d1.satisfied).toBe(false);
    expect(d1.unsatisfied.sort()).toEqual(["made.up.capability", "query.unbounded-join"]);
  });
});
