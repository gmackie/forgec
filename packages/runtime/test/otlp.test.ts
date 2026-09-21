/** OTLP/HTTP JSON exporter (SR-6): bounded attributes, plan buckets, loss accounting, against a local collector. */
import { createServer, type Server } from "node:http";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Effect } from "effect";
import { Model, type AppBundle } from "../src/model.js";
import { Engine, type CallContext } from "../src/engine.js";
import { MemoryStorage } from "../src/adapters/memory.js";
import { testLayer } from "../src/testing.js";
import { OtlpSink } from "../src/otlp.js";
import { externals, functions } from "../../../examples/acme/impl/index.js";

const bundle = JSON.parse(readFileSync(resolve(import.meta.dirname, "..", "..", "..", "conformance", "fixtures", "acme.app.json"), "utf8")) as AppBundle;

describe("OTLP sink", () => {
  let server: Server;
  let endpoint: string;
  const received: { path: string; body: unknown }[] = [];
  let failNext = false;
  beforeAll(async () => {
    server = createServer((req, res) => {
      let data = "";
      req.on("data", (c) => (data += c));
      req.on("end", () => {
        if (failNext) { failNext = false; res.writeHead(503).end(); return; }
        received.push({ path: req.url ?? "", body: JSON.parse(data) });
        res.writeHead(200, { "content-type": "application/json" }).end("{}");
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    endpoint = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  });
  afterAll(() => server.close());

  it("exports log records and metrics with bounded attributes, plan buckets, completion-only request counts, and counts loss", async () => {
    const model = new Model(bundle);
    const engine = new Engine(model, testLayer(new MemoryStorage()), { functions, externals });
    const boundaries = Object.fromEntries((bundle.observability?.operations ?? []).map((o) => [o.operation, o.histogramBoundariesMs]));
    const sink = new OtlpSink({ endpoint, serviceName: "forge-acme", boundaries, flushIntervalMs: 60_000 });
    engine.telemetry.sink = sink;
    const ctx: CallContext = { tenant: "tenant-zulu", actor: "actor-yankee", requestId: "r1" };
    engine.telemetry.attempt(ctx, 503, "TransientConflict");
    await Effect.runPromise(engine.call("@acme/commerce/_/Customer.create", { code: "OTLP", name: "Otlp" }, { ...ctx, attempt: 2 }) as Effect.Effect<unknown, never, never>);
    await Effect.runPromiseExit(engine.call("@acme/commerce/_/Customer.get", { id: "nope" }, ctx));
    await sink.flush();
    expect(sink.stats()).toEqual({ exported: 3, dropped: 0, pending: 0 });
    const logs = received.find((r) => r.path === "/v1/logs")!.body as { resourceLogs: { resource: { attributes: { key: string; value: { stringValue: string } }[] }; scopeLogs: { logRecords: { attributes: { key: string }[]; body: { stringValue: string } }[] }[] }[] };
    expect(logs.resourceLogs[0]!.resource.attributes[0]).toEqual({ key: "service.name", value: { stringValue: "forge-acme" } });
    const records = logs.resourceLogs[0]!.scopeLogs[0]!.logRecords;
    expect(records).toHaveLength(3);
    const text = JSON.stringify(received);
    for (const s of ["zulu", "yankee", "Otlp", "cus_0001"]) expect(text).not.toContain(s);
    const metrics = received.find((r) => r.path === "/v1/metrics")!.body as { resourceMetrics: { scopeMetrics: { metrics: { name: string; sum?: { dataPoints: { asInt: string; attributes: { key: string; value: { stringValue: string } }[] }[] }; histogram?: { dataPoints: { explicitBounds: number[]; count: string; bucketCounts: string[] }[] } }[] }[] }[] };
    const byName = Object.fromEntries(metrics.resourceMetrics[0]!.scopeMetrics[0]!.metrics.map((m) => [m.name, m]));
    const requests = byName["forge_requests_total"]!.sum!.dataPoints.reduce((n, p) => n + Number(p.asInt), 0);
    const attempts = byName["forge_attempts_total"]!.sum!.dataPoints.reduce((n, p) => n + Number(p.asInt), 0);
    expect(requests).toBe(2); // two logical requests
    expect(attempts).toBe(3); // three tries
    const hist = byName["forge_request_duration_ms"]!.histogram!.dataPoints.find((p) => p.count === "1")!;
    expect(hist.explicitBounds).toEqual([5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000]);
    expect(hist.bucketCounts).toHaveLength(12);
    expect(hist.bucketCounts.map(Number).reduce((a, b) => a + b, 0)).toBe(1);
    const createPoint = byName["forge_requests_total"]!.sum!.dataPoints.find((p) => p.attributes.some((a) => a.key === "forge.operation" && a.value.stringValue === "@acme/commerce/_/Customer.create"))!;
    expect(createPoint.attributes.map((a) => a.key).sort()).toEqual(["forge.decision", "forge.kind", "forge.operation", "forge.outcome", "forge.phase", "forge.resource", "forge.target"]);
    // a collector outage is loss, reported, never an operation error
    failNext = true;
    await Effect.runPromiseExit(engine.call("@acme/commerce/_/Customer.get", { id: "nope" }, ctx));
    await sink.flush();
    expect(sink.stats().dropped).toBe(1);
    expect(sink.stats().exported).toBe(3);
  });
});
