/**
 * Observability (§20): every logical operation — generated or handwritten —
 * emits one unsampled operation event with bounded dimensions, an explicit
 * SLI classification, logical (not attempt) counting, trace context
 * propagated from the request through the outbox, and a per-process sequence
 * so export gaps are detectable. Host sinks only format (Workers Logs JSON,
 * CloudWatch EMF); the classification lives in the compiled plan.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Effect } from "effect";
import { beforeEach, describe, expect, it } from "vitest";
import { Model, type AppBundle } from "../src/model.js";
import { Engine, type CallContext } from "../src/engine.js";
import { MemoryStorage } from "../src/adapters/memory.js";
import { testLayer } from "../src/testing.js";
import { createHttpHandler, devHeaderAuth } from "../src/http.js";
import { classify, emfLine, type OperationEvent } from "../src/telemetry.js";
import { externals, functions } from "../../../examples/acme/impl/index.js";

const bundle = JSON.parse(readFileSync(resolve(import.meta.dirname, "..", "..", "..", "conformance", "fixtures", "acme.app.json"), "utf8")) as AppBundle;
const model = new Model(bundle);
const ctx: CallContext = { tenant: "acme", actor: "operator", requestId: "req" };
const run = <A>(e: Effect.Effect<A, unknown, never>) => Effect.runPromiseExit(e as Effect.Effect<A, never, never>);

let storage: MemoryStorage;
let engine: Engine;
let events: OperationEvent[];
beforeEach(() => {
  storage = new MemoryStorage();
  engine = new Engine(model, testLayer(storage), { functions, externals });
  events = [];
  engine.telemetry.sink = { write: (e) => void events.push(e) };
});

describe("observability plan", () => {
  it("compiles one telemetry entry per logical operation with bounded dimensions and SLO thresholds in the histogram", () => {
    const plan = bundle.observability!;
    expect(plan.version).toBe("observability/1");
    expect(plan.dimensions).toEqual(["forge.operation", "forge.kind", "forge.resource", "forge.outcome", "forge.target"]);
    const create = plan.operations.find((o) => o.operation === "@acme/commerce/_/Customer.create")!;
    expect(create).toMatchObject({ kind: "create", resource: "@acme/commerce/_/Customer", class: "crud-write", slo: { availability: "99.9%", latencyGood: "99%", latencyWithinMs: 1000, window: "28d" } });
    expect(create.histogramBoundariesMs).toContain(1000);
    const get = plan.operations.find((o) => o.operation === "@acme/commerce/_/Customer.get")!;
    expect(get).toMatchObject({ class: "crud-read", slo: { latencyWithinMs: 500 } });
    const submit = plan.operations.find((o) => o.operation === "@acme/commerce/_/SubmitOrder")!;
    expect(submit).toMatchObject({ class: "function", slo: { availability: "99.9%", latencyGood: "99%", latencyWithinMs: 1000, window: "28d" } });
    // The classification policy is part of the plan, not a runtime opinion.
    expect(plan.classification).toMatchObject({ good: "status < 400", excluded: "4xx client errors except TransientConflict", bad: "5xx, TransientConflict, timeouts, undeclared failures", business: "declared domain errors: served, counted separately" });
  });
});

describe("operation events", () => {
  it("classifies outcomes: success good, validation excluded, domain error business, internal bad", async () => {
    await run(engine.call("@acme/commerce/_/Customer.create", { code: "ACME", name: "A" }, ctx));
    await run(engine.call("@acme/commerce/_/Customer.create", { code: "", name: "A" }, ctx));
    const c = events[0]!;
    expect(c).toMatchObject({ operation: "@acme/commerce/_/Customer.create", kind: "create", resource: "@acme/commerce/_/Customer", outcome: "good", status: 201, logical: true, attempt: 1, seq: 1 });
    expect(typeof c.durationMs).toBe("number");
    expect(events[1]).toMatchObject({ outcome: "excluded", status: 422, code: "ValidationFailed", seq: 2 });
    expect(classify(200)).toBe("good");
    expect(classify(404, "NotFound")).toBe("excluded");
    expect(classify(409, "VersionConflict")).toBe("excluded");
    expect(classify(503, "TransientConflict")).toBe("bad");
    expect(classify(500, "Internal")).toBe("bad");
    expect(classify(409, "@acme/commerce/_/SubmitOrder.PaymentDeclined")).toBe("business");
  });

  it("never labels events with unbounded values: no tenant, ids or input in the dimensions", async () => {
    await run(engine.call("@acme/commerce/_/Customer.create", { code: "ACME", name: "A" }, { ...ctx, tenant: "tenant-zulu", actor: "actor-yankee" }));
    const dims = engine.telemetry.dimensions(events[0]!);
    expect(Object.keys(dims).sort()).toEqual(["forge.decision", "forge.kind", "forge.operation", "forge.outcome", "forge.resource", "forge.target"]);
    expect(JSON.stringify(dims)).not.toContain("zulu");
    expect(JSON.stringify(dims)).not.toContain("yankee");
    expect(JSON.stringify(dims)).not.toContain("cus_");
  });

  it("propagates trace context from the request into the event and the outbox envelope, with a fresh span per operation", async () => {
    const handler = createHttpHandler(model, engine, { auth: devHeaderAuth(), requestId: () => "r1" });
    const res = await handler(new Request("https://x/v1/customers", { method: "POST", headers: { "content-type": "application/json", "x-forge-tenant": "acme", "x-forge-actor": "a", traceparent: "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01" }, body: JSON.stringify({ code: "ACME", name: "A" }) }));
    expect(res.status).toBe(201);
    expect(res.headers.get("traceparent")).toMatch(/^00-0af7651916cd43dd8448eb211c80319c-[0-9a-f]{16}-01$/);
    const ev = events.find((e) => e.kind === "create")!;
    expect(ev.trace).toMatchObject({ traceId: "0af7651916cd43dd8448eb211c80319c", parentSpanId: "b7ad6b7169203331" });
    expect(ev.trace!.spanId).toMatch(/^[0-9a-f]{16}$/);
    const rows = await Effect.runPromise(storage.outboxSweep("acme", 10, Date.now()));
    expect(rows[0]!.trace).toMatchObject({ traceId: "0af7651916cd43dd8448eb211c80319c", spanId: ev.trace!.spanId });
  });

  it("counts a sequence per process and reports export gaps when the sink fails", async () => {
    engine.telemetry.sink = { write: () => { throw new Error("sink down"); } };
    await run(engine.call("@acme/commerce/_/Customer.create", { code: "ACME", name: "A" }, ctx));
    await run(engine.call("@acme/commerce/_/Customer.get", { id: "nope" }, ctx));
    expect(engine.telemetry.stats()).toEqual({ emitted: 2, dropped: 2, seq: 2 });
  });

  it("formats CloudWatch EMF with the plan's histogram and counters (no high-cardinality dimensions)", () => {
    const ev: OperationEvent = { ts: "2026-09-20T00:00:00.000Z", seq: 1, operation: "@acme/commerce/_/Customer.create", kind: "create", resource: "@acme/commerce/_/Customer", outcome: "good", status: 201, durationMs: 12.5, logical: true, attempt: 1, phase: "completion", requestId: "r", target: "aws-dynamodb" };
    const line = JSON.parse(emfLine(ev, "forge-acme"));
    expect(line._aws.CloudWatchMetrics[0]).toMatchObject({ Namespace: "forge-acme", Dimensions: [["forge.operation", "forge.outcome"]] });
    expect(line._aws.CloudWatchMetrics[0].Metrics.map((m: any) => m.Name)).toEqual(["forge.operation.count", "forge.operation.duration_ms"]);
    expect(line["forge.operation"]).toBe("@acme/commerce/_/Customer.create");
    expect(line["forge.operation.duration_ms"]).toBe(12.5);
    expect(line["forge.tenant"]).toBeUndefined();
  });
});

/** FORGE-082 (PAR-164/165/166): governance context on events, bounded labels, attempts vs completions. */
describe("governance context and SLI denominators", () => {
  const nextBundle = JSON.parse(readFileSync(resolve(import.meta.dirname, "..", "..", "..", "conformance", "fixtures", "acme-next.app.json"), "utf8")) as AppBundle;
  const N = "@acme/commerce-next/_";
  const G = "@acme/governance/_";

  it("PAR-164/165: events carry purpose, surface digest, decision and epochs as bounded identifiers; a sensitive purpose name is an opaque handle; inputs never appear", async () => {
    const events: OperationEvent[] = [];
    const engine = new Engine(new Model(nextBundle), testLayer(new MemoryStorage()));
    engine.telemetry.sink = { write: (e) => events.push(e) };
    engine.telemetry.purposeHandling = { [`${G}/CustomerSupport`]: "confidential" };
    const seed: CallContext = { tenant: "t", actor: "maintenance", requestId: "seed", maintenance: true };
    const c = await Effect.runPromise(engine.call(`${N}/Customer.create`, { code: "TEL", name: "Telemetry Co" }, seed) as Effect.Effect<{ id: string }, never, never>);
    const k = await Effect.runPromise(engine.call(`${N}/Contact.create`, { customer: c.id, name: "Pat Example", email: "pat@example.com", supportNotes: "health: allergic to peanuts" }, seed) as Effect.Effect<{ id: string }, never, never>);
    const support: CallContext = { tenant: "t", actor: "agent-7", requestId: "r-support", purpose: `${G}/CustomerSupport` };
    await Effect.runPromise(engine.call(`${N}/Contact.get`, { id: k.id }, support) as Effect.Effect<unknown, never, never>);
    await run(engine.call(`${N}/Contact.update`, { id: k.id, expectedVersion: 1, patch: { name: "Nope" } }, support)); // NotPermitted by the surface
    await run(engine.call(`${N}/Contact.create`, { customer: c.id, name: "x", email: "not-an-email", supportNotes: "secret" }, seed)); // ValidationFailed
    const get = events.find((e) => e.operation === `${N}/Contact.get`)!;
    expect(get.purpose).toMatch(/^p:[0-9a-f]{12}$/); // confidential purpose: opaque, stable handle
    expect(get.purpose).not.toContain("CustomerSupport");
    expect(get.surface).toMatch(/^[0-9a-f]{12}$/); // the capability surface digest, bounded
    expect(get.decision).toBe("allow");
    expect(get.policyEpoch).toBe(0);
    expect(get.phase).toBe("completion");
    const denied = events.find((e) => e.operation === `${N}/Contact.update`)!;
    expect(denied.decision).toBe("deny");
    expect(denied.outcome).toBe("excluded");
    // a non-confidential purpose keeps its id; the same purpose always maps to the same handle
    engine.telemetry.purposeHandling = {};
    await Effect.runPromise(engine.call(`${N}/Contact.get`, { id: k.id }, support) as Effect.Effect<unknown, never, never>);
    expect(events.at(-1)!.purpose).toBe(`${G}/CustomerSupport`);
    // nothing sensitive anywhere in the events, their dimensions, or the log line
    const all = JSON.stringify(events) + events.map((e) => JSON.stringify(engine.telemetry.dimensions(e))).join("");
    for (const s of ["pat@example.com", "peanuts", "Pat Example", "not-an-email", "secret", k.id, c.id]) expect(all).not.toContain(s);
    const dims = engine.telemetry.dimensions(get);
    expect(Object.keys(dims).sort()).toEqual(["forge.decision", "forge.kind", "forge.operation", "forge.outcome", "forge.purpose", "forge.resource", "forge.target"]);
  });

  it("PAR-166: attempts and completions are distinct; one logical operation that fails twice then succeeds is one request", async () => {
    const events: OperationEvent[] = [];
    const engine = new Engine(model, testLayer(new MemoryStorage()), { functions, externals });
    engine.telemetry.sink = { write: (e) => events.push(e) };
    // the caller retries the same logical request (same requestId) on transient failures
    engine.telemetry.attempt(ctx, 503, "TransientConflict");
    engine.telemetry.attempt(ctx, 503, "TransientConflict");
    await run(engine.call("@acme/commerce/_/Customer.create", { code: "RETRY", name: "R" }, { ...ctx, attempt: 3 }));
    expect(events.map((e) => [e.phase, e.attempt, e.outcome])).toEqual([["attempt", 1, "bad"], ["attempt", 2, "bad"], ["completion", 3, "good"]]);
    const sli = engine.telemetry.sli(events);
    expect(sli).toEqual({ requests: 1, good: 1, bad: 0, business: 0, excluded: 0, attempts: 3, transportFailures: 0, coverage: { emitted: 3, dropped: 0 } });
    // a declared business error completes the request but is not a good service outcome and not a failure either
    await run(engine.call("@acme/commerce/_/SubmitOrder", { order: "ord_nope", expectedVersion: 1 }, ctx));
    const s2 = engine.telemetry.sli(events);
    expect(s2.requests).toBe(2);
    expect(s2.good).toBe(1);
    // transport failures (the sink or the wire failing) are reported as loss, never as service errors
    engine.telemetry.sink = { write: () => { throw new Error("collector down"); } };
    await run(engine.call("@acme/commerce/_/Customer.get", { id: "nope" }, ctx));
    expect(engine.telemetry.stats().dropped).toBe(1);
    expect(engine.telemetry.sli(events).coverage).toEqual({ emitted: 5, dropped: 1 });
  });
});
