import type { CallContext, CallResult, Target } from "./target.js";

export interface Step {
  name: string;
  op: string;
  input: unknown;
  ctx?: Partial<CallContext>;
  expect: { ok: unknown } | { error: string };
}

export interface Scenario {
  id: string;
  title: string;
  steps: Step[];
}

export interface Failure {
  step: string;
  path: string;
  expected: unknown;
  actual: unknown;
}

export interface Report {
  scenario: string;
  target: string;
  steps: number;
  failures: Failure[];
  /** Normalized results per step, comparable across targets and runs. */
  results: Record<string, CallResult>;
}

const DEFAULT_CTX: CallContext = { tenant: "acme", actor: "operator" };

/**
 * `$step.field` reads a prior step's success value; `$id:n` is the n-th id
 * the target generated (targets run with a seeded IdService), so scenarios
 * can name records without depending on real generated values.
 */
function resolveRefs(value: unknown, results: Record<string, CallResult>, ids: string[], opts = { ids: true }): unknown {
  if (typeof value === "string" && value.startsWith("$")) {
    const idMatch = /^\$id:(\d+)$/.exec(value);
    if (idMatch) return opts.ids ? (ids[Number(idMatch[1]) - 1] ?? value) : value;
    const [step, ...path] = value.slice(1).split(".");
    const r = step ? results[step] : undefined;
    if (!r || !r.ok) return value;
    return path.reduce<unknown>((acc, k) => (acc && typeof acc === "object" ? (acc as Record<string, unknown>)[k] : undefined), r.value);
  }
  if (Array.isArray(value)) return value.map((v) => resolveRefs(v, results, ids, opts));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, resolveRefs(v, results, ids, opts)]));
  }
  return value;
}

/** Expected values are matched as a subset of the actual object (extra actual fields are allowed). */
function diff(expected: unknown, actual: unknown, path: string, out: Failure[], step: string): void {
  if (expected && typeof expected === "object" && !Array.isArray(expected)) {
    if (!actual || typeof actual !== "object") return void out.push({ step, path, expected, actual });
    for (const [k, v] of Object.entries(expected as Record<string, unknown>)) {
      diff(v, (actual as Record<string, unknown>)[k], path ? `${path}.${k}` : k, out, step);
    }
    return;
  }
  if (Array.isArray(expected)) {
    if (!Array.isArray(actual) || actual.length !== expected.length) return void out.push({ step, path, expected, actual });
    expected.forEach((e, i) => diff(e, actual[i], `${path}[${i}]`, out, step));
    return;
  }
  if (expected !== actual) out.push({ step, path, expected, actual });
}

/** Deployment metadata that legitimately differs per run/target is dropped before comparison. */
const VOLATILE = new Set(["createdAt", "updatedAt", "requestId", "etag"]);
function normalize(value: unknown, ids: string[]): unknown {
  if (Array.isArray(value)) return value.map((v) => normalize(v, ids));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([k]) => !VOLATILE.has(k))
        .map(([k, v]) => [k, normalize(v, ids)]),
    );
  }
  if (typeof value === "string") {
    const i = ids.indexOf(value);
    if (i >= 0) return `$id:${i + 1}`;
  }
  return value;
}

export async function runScenario(scenario: Scenario, target: Target): Promise<Report> {
  await target.reset();
  const results: Record<string, CallResult> = {};
  const raw: Record<string, CallResult> = {};
  const failures: Failure[] = [];
  const ids: string[] = [];

  for (const step of scenario.steps) {
    const input = resolveRefs(step.input, raw, ids);
    const ctx = { ...DEFAULT_CTX, ...step.ctx };
    const result = await target.call(step.op, input, ctx);
    raw[step.name] = result;
    if (result.ok && result.value && typeof result.value === "object" && "id" in (result.value as object)) {
      const id = (result.value as { id: unknown }).id;
      if (typeof id === "string" && !ids.includes(id)) ids.push(id);
    }
    const normalized: CallResult = result.ok ? { ok: true, value: normalize(result.value, ids) } : result;
    results[step.name] = normalized;

    if ("error" in step.expect) {
      if (result.ok) failures.push({ step: step.name, path: "", expected: { error: step.expect.error }, actual: normalized });
      else if (result.code !== step.expect.error) failures.push({ step: step.name, path: "code", expected: step.expect.error, actual: result.code });
    } else if (!result.ok) {
      failures.push({ step: step.name, path: "", expected: { ok: step.expect.ok }, actual: result });
    } else {
      // Expectations live in placeholder space: `$step.field` resolves, `$id:n` stays symbolic and is
      // compared against the normalized actual value, so scenarios never depend on real generated ids.
      const expected = normalize(resolveRefs(step.expect.ok, raw, ids, { ids: false }), ids);
      diff(expected, normalize(result.value, ids), "", failures, step.name);
    }
  }
  return { scenario: scenario.id, target: target.name, steps: scenario.steps.length, failures, results };
}
