// Vendored verbatim from ForgeGraph packages/contract/src/sla.ts
// at commit 0e6be228bf8771d81155bad3b4981c59a9df4620 (git.forgegraf.com/gmackie/forgegraph).
// Do not edit; refresh with conformance/contract-ir/vendor.sh.
/**
 * Hierarchical, leaf-merged SLA resolution.
 *
 * Precedence (later wins): global → service → api → group → endpoint → environment.
 * Merging happens per leaf path, not per object: an endpoint that sets only
 * `latency.p99Ms` keeps `latency.p95Ms`, `availability` and everything else
 * from the levels above it. Every resolved leaf records which level supplied
 * it so the UI can explain why a value exists.
 */

export const SLA_LEVELS = [
  "global",
  "service",
  "api",
  "group",
  "endpoint",
  "environment",
] as const;
export type SlaLevel = (typeof SLA_LEVELS)[number];

export interface SlaLatency {
  readonly p50Ms?: number;
  readonly p95Ms?: number;
  readonly p99Ms?: number;
  readonly maxMs?: number;
}

/** A partial SLA. Every field is optional; absent means "inherit". */
export interface SlaPatch {
  /** 0 < availability ≤ 1, e.g. 0.999 */
  readonly availability?: number;
  /** 0 ≤ errorRate < 1, e.g. 0.001 */
  readonly errorRate?: number;
  readonly latency?: SlaLatency;
  readonly timeoutMs?: number;
  readonly maxRetries?: number;
  readonly qps?: number;
  readonly concurrency?: number;
}

export const SLA_LEAVES = [
  "availability",
  "errorRate",
  "latency.p50Ms",
  "latency.p95Ms",
  "latency.p99Ms",
  "latency.maxMs",
  "timeoutMs",
  "maxRetries",
  "qps",
  "concurrency",
] as const;
export type SlaLeaf = (typeof SLA_LEAVES)[number];

/** Which level supplied each resolved leaf. Only present leaves appear. */
export type SlaProvenance = Partial<Record<SlaLeaf, SlaLevel>>;

export interface ResolvedSla {
  /** The merged policy. Same shape as a patch; only resolved leaves are set. */
  readonly policy: SlaPatch;
  readonly provenance: SlaProvenance;
}

/** Patches keyed by level. Missing levels contribute nothing. */
export type SlaLayers = Partial<Record<SlaLevel, SlaPatch | undefined>>;

export interface SlaValidationIssue {
  readonly leaf: SlaLeaf;
  readonly level: SlaLevel;
  readonly value: number;
  readonly message: string;
}

/** Thrown by {@link resolveSla} when any layer holds an out-of-range value. */
export class SlaValidationError extends Error {
  readonly issues: ReadonlyArray<SlaValidationIssue>;
  constructor(issues: ReadonlyArray<SlaValidationIssue>) {
    super(
      `Invalid SLA: ${issues
        .map((i) => `${i.level}.${i.leaf}=${i.value} (${i.message})`)
        .join("; ")}`,
    );
    this.name = "SlaValidationError";
    this.issues = issues;
  }
}

function readLeaf(patch: SlaPatch, leaf: SlaLeaf): number | undefined {
  switch (leaf) {
    case "availability":
      return patch.availability;
    case "errorRate":
      return patch.errorRate;
    case "latency.p50Ms":
      return patch.latency?.p50Ms;
    case "latency.p95Ms":
      return patch.latency?.p95Ms;
    case "latency.p99Ms":
      return patch.latency?.p99Ms;
    case "latency.maxMs":
      return patch.latency?.maxMs;
    case "timeoutMs":
      return patch.timeoutMs;
    case "maxRetries":
      return patch.maxRetries;
    case "qps":
      return patch.qps;
    case "concurrency":
      return patch.concurrency;
  }
}

function writeLeaf(
  target: {
    availability?: number;
    errorRate?: number;
    latency?: { p50Ms?: number; p95Ms?: number; p99Ms?: number; maxMs?: number };
    timeoutMs?: number;
    maxRetries?: number;
    qps?: number;
    concurrency?: number;
  },
  leaf: SlaLeaf,
  value: number,
): void {
  switch (leaf) {
    case "availability":
      target.availability = value;
      return;
    case "errorRate":
      target.errorRate = value;
      return;
    case "latency.p50Ms":
      (target.latency ??= {}).p50Ms = value;
      return;
    case "latency.p95Ms":
      (target.latency ??= {}).p95Ms = value;
      return;
    case "latency.p99Ms":
      (target.latency ??= {}).p99Ms = value;
      return;
    case "latency.maxMs":
      (target.latency ??= {}).maxMs = value;
      return;
    case "timeoutMs":
      target.timeoutMs = value;
      return;
    case "maxRetries":
      target.maxRetries = value;
      return;
    case "qps":
      target.qps = value;
      return;
    case "concurrency":
      target.concurrency = value;
      return;
  }
}

function validateLeaf(leaf: SlaLeaf, value: number): string | null {
  if (!Number.isFinite(value)) return "must be a finite number";
  switch (leaf) {
    case "availability":
      return value > 0 && value <= 1 ? null : "must be in (0, 1]";
    case "errorRate":
      return value >= 0 && value < 1 ? null : "must be in [0, 1)";
    case "maxRetries":
      return Number.isInteger(value) && value >= 0
        ? null
        : "must be a non-negative integer";
    case "concurrency":
      return Number.isInteger(value) && value > 0
        ? null
        : "must be a positive integer";
    default:
      return value > 0 ? null : "must be positive";
  }
}

/** Validate every leaf of a single patch. Returns issues, never throws. */
export function validateSlaPatch(
  patch: SlaPatch,
  level: SlaLevel,
): SlaValidationIssue[] {
  const issues: SlaValidationIssue[] = [];
  for (const leaf of SLA_LEAVES) {
    const value = readLeaf(patch, leaf);
    if (value === undefined) continue;
    const message = validateLeaf(leaf, value);
    if (message) issues.push({ leaf, level, value, message });
  }
  return issues;
}

/**
 * Merge the layers leaf by leaf. Later levels override earlier ones only for
 * the leaves they actually set. Throws {@link SlaValidationError} if any layer
 * holds an invalid value, so a bad annotation fails the build rather than
 * silently resolving to nonsense.
 */
export function resolveSla(layers: SlaLayers): ResolvedSla {
  const issues: SlaValidationIssue[] = [];
  for (const level of SLA_LEVELS) {
    const patch = layers[level];
    if (patch) issues.push(...validateSlaPatch(patch, level));
  }
  if (issues.length > 0) throw new SlaValidationError(issues);

  const policy: Parameters<typeof writeLeaf>[0] = {};
  const provenance: Partial<Record<SlaLeaf, SlaLevel>> = {};
  for (const leaf of SLA_LEAVES) {
    for (const level of SLA_LEVELS) {
      const value = layers[level] ? readLeaf(layers[level]!, leaf) : undefined;
      if (value !== undefined) {
        writeLeaf(policy, leaf, value);
        provenance[leaf] = level;
      }
    }
  }
  return { policy, provenance };
}

/** Deep-merge two patches leaf by leaf; `override` wins where it sets a leaf. */
export function mergeSlaPatch(base: SlaPatch, override: SlaPatch): SlaPatch {
  const out: Parameters<typeof writeLeaf>[0] = {};
  for (const leaf of SLA_LEAVES) {
    const value = readLeaf(override, leaf) ?? readLeaf(base, leaf);
    if (value !== undefined) writeLeaf(out, leaf, value);
  }
  return out;
}
