/** FORGE-083 / PAR-164: classification-aware logs, audit values and raw-logging escapes. */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import type { AppBundle, OperationEvent } from "@forgegraph/runtime";
import { Redactor, SINK_POLICIES, leaks, logEvent, rawLoggingEscapes } from "../src/telemetry.js";

const bundle = JSON.parse(readFileSync(resolve(import.meta.dirname, "..", "..", "..", "conformance", "fixtures", "acme-next.app.json"), "utf8")) as AppBundle;
const N = "@acme/commerce-next/_";

describe("PAR-164: sensitive values never reach generated sinks", () => {
  const record = { id: "con_0001", customer: "cus_0001", name: "Pat Example", email: "pat@example.com", supportNotes: "health: allergic to peanuts", version: 3 };
  const sensitive = ["Pat Example", "pat@example.com", "peanuts", "con_0001", "cus_0001"];

  it("log events are the allowlisted subset of an OperationEvent; audit values follow classification; errors carry paths and codes only", () => {
    const ev = { ts: "2026-09-21T00:00:00Z", seq: 1, operation: `${N}/Contact.update`, kind: "update", resource: `${N}/Contact`, outcome: "excluded", status: 422, code: "ValidationFailed", durationMs: 3, logical: true, attempt: 1, phase: "completion", requestId: "r1", target: "node", purpose: "p:abc123abc123", decision: "allow", input: record, patch: { email: "pat@example.com" } } as unknown as OperationEvent;
    const line = JSON.stringify(logEvent(ev));
    expect(leaks(line, sensitive)).toEqual([]);
    expect(JSON.parse(line)).toMatchObject({ operation: `${N}/Contact.update`, code: "ValidationFailed", purpose: "p:abc123abc123" });
    const r = new Redactor(bundle);
    const audit = r.auditRecord(`${N}/Contact`, record, "audit");
    expect(leaks(JSON.stringify(audit), sensitive)).toEqual([]);
    expect(audit["email"]).toMatch(/^t:[0-9a-f]{16}$/); // direct identifier: keyed token
    expect(audit["id"]).toMatch(/^t:[0-9a-f]{16}$/); // record ids are unbounded identifiers: tokens
    expect(audit["supportNotes"]).toBe("[redacted]");
    expect(audit["name"]).toBe("[redacted]");
    expect(audit["version"]).toBe(3); // structural, bounded
    expect(r.auditRecord(`${N}/Contact`, record, "logs")).toEqual({}); // logs carry no values at all
    expect(r.auditValue(`${N}/Contact`, "nonexistent", "x")).toBe("[redacted:unclassified]");
    const problem = r.safeProblem({ code: "ValidationFailed", status: 422, requestId: "r1", detail: "email pat@example.com is invalid", fields: [{ path: "email", code: "Format", message: "pat@example.com is not an email" }] });
    expect(leaks(JSON.stringify(problem), sensitive)).toEqual([]);
    expect(problem).toEqual({ code: "ValidationFailed", status: 422, requestId: "r1", fields: [{ path: "email", code: "Format" }] });
    for (const p of Object.values(SINK_POLICIES)) expect(p.labels.every((l) => !/^(input|patch|payload|body|value|record)$/.test(l))).toBe(true);
  });

  it("raw logging in handwritten code is an unmodeled escape, listed and never marked safe", () => {
    const src = `import { defineFunction } from "@forgegraph/runtime";\nexport const f = defineFunction("x", (deps) => {\n  console.log("input", deps.input);\n  return Effect.void;\n});\n`;
    const escapes = rawLoggingEscapes(src, "impl/f.ts");
    expect(escapes).toEqual([{ file: "impl/f.ts", line: 3, call: "console.log", verdict: "unmodeled" }]);
    expect(rawLoggingEscapes("const x = 1;\n")).toEqual([]);
  });
});
