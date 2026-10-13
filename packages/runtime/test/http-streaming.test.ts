import { readFileSync } from "node:fs";
import { Writable } from "node:stream";
import type { ServerResponse } from "node:http";
import { expect, it, vi } from "vitest";
import { Model } from "../src/model.js";
import { Engine } from "../src/engine.js";
import { MemoryStorage } from "../src/adapters/memory.js";
import { testLayer } from "../src/testing.js";
import { createHttpHandler, devHeaderAuth } from "../src/http.js";
import { createNodeHost, writeFetchResponse } from "../src/hosts/node.js";
import { toRequest, toResult } from "../src/hosts/aws.js";
import { sseResponse } from "../src/http-streams.js";
import { createWorker, type WorkerEnv } from "../src/hosts/cloudflare.js";
const bundle = JSON.parse(readFileSync(new URL("../../../conformance/fixtures/acme.app.json", import.meta.url), "utf8"));
const headers = { "x-forge-tenant": "tenant" };

it("stops pulling response chunks while the Node sink applies backpressure", async () => {
  let reads = 0, blocked = true, release!: () => void;
  const sink = Object.assign(new Writable({ highWaterMark: 1, write(_bytes, _encoding, callback) {
    if (blocked) release = () => { blocked = false; callback(); };
    else callback();
  } }), { setHeader() {}, flushHeaders() {}, statusCode: 0 });
  const response = new Response(new ReadableStream<Uint8Array>({ pull(c) { reads++; if (reads <= 20) c.enqueue(new Uint8Array(65536)); else c.close(); } }));
  const writing = writeFetchResponse(sink as unknown as ServerResponse, response);
  await new Promise(resolve => setImmediate(resolve));
  expect(reads).toBeLessThan(20);
  release(); await writing;
  expect(reads).toBe(21);
});

it("binds Workers endpoint configuration and returns a live stream without storage access", async () => {
  const prepare = vi.fn(() => { throw new Error("no storage access expected"); });
  const env = { DB: { prepare }, CURSOR_SECRET: "fixture", STREAM_NAME: "log" } as unknown as WorkerEnv;
  const worker = createWorker(bundle, { auth: devHeaderAuth(), endpoints: env => [{ method: "GET", path: "/worker/stream", responseMode: "stream", handle: async req => sseResponse(async function* () { yield { data: String(env.STREAM_NAME) }; }, { signal: req.signal }) }] });
  const res = await worker.fetch(new Request("https://test/worker/stream", { headers }), env, { waitUntil: vi.fn() });
  expect(await res.text()).toBe("data: log\n\n");
  expect(prepare).not.toHaveBeenCalled();
});

it("does not pull SSE events until requested and aborts a stalled producer", async () => {
  const next = vi.fn(() => new Promise<IteratorResult<{ data: string }>>(() => {}));
  const controller = new AbortController();
  const response = sseResponse(() => ({ [Symbol.asyncIterator]: () => ({ next }) }), { signal: controller.signal });
  expect(next).not.toHaveBeenCalled();
  const reader = response.body!.getReader();
  const pending = reader.read();
  await Promise.resolve();
  expect(next).toHaveBeenCalledTimes(1);
  controller.abort();
  await expect(pending).rejects.toThrow(/abort/i);
});

it("drains active streams within the configured shutdown deadline", async () => {
  const host = createNodeHost({ bundle, store: new MemoryStorage(), auth: devHeaderAuth(), cursorSecret: "fixture", sweepIntervalMs: 0, telemetryFormat: "silent", drainTimeoutMs: 10,
    endpoints: [{ method: "GET", path: "/forever", responseMode: "stream", handle: async () => new Response(new ReadableStream({ start(c) { c.enqueue(new Uint8Array([1])); } })) }],
  });
  const base = (await host.listen()).url;
  const response = await fetch(base + "/forever", { headers });
  try { await host.stop(); }
  finally { await response.body?.cancel().catch(() => {}); }
}, 2000);

it("frames multiline SSE safely and propagates cancellation to the source", async () => {
  let signal!: AbortSignal;
  const response = sseResponse(s => {
    signal = s;
    return (async function* () { yield { data: "first\r\nsecond", id: "cursor1", event: "log", retry: 500 }; })();
  });
  const reader = response.body!.getReader();
  expect(new TextDecoder().decode((await reader.read()).value)).toBe("event: log\nid: cursor1\nretry: 500\ndata: first\ndata: second\n\n");
  await reader.cancel();
  expect(signal.aborted).toBe(true);
  const unsafe = sseResponse(async function* () { yield { data: "ok", id: "injected\nevent: other" }; });
  await expect(unsafe.text()).rejects.toThrow(/SSE/);
});

it("routes authenticated binary endpoints with bounded input and concrete parameters", async () => {
  const model = new Model(bundle);
  let calls = 0;
  const handler = createHttpHandler(model, new Engine(model, testLayer(new MemoryStorage())), {
    auth: devHeaderAuth(), endpoints: [{ method: "POST", path: "/git/{owner}/{repo}.git", responseMode: "buffered", maxBodyBytes: 4,
      async handle(req, ctx) { calls++; expect(ctx.principal.tenant).toBe("tenant"); expect(ctx.params).toEqual({ owner: "alice", repo: "demo" }); return new Response(await req.arrayBuffer()); },
    }],
  });
  expect((await handler(new Request("https://test/git/alice/demo.git", { method: "POST", body: "abc" }))).status).toBe(401);
  expect((await handler(new Request("https://test/git/alice/demo.git", { method: "GET", headers }))).status).toBe(405);
  const res = await handler(new Request("https://test/git/alice/demo.git", { method: "POST", headers, body: new Uint8Array([0, 255, 128, 1]) }));
  expect(new Uint8Array(await res.arrayBuffer())).toEqual(new Uint8Array([0, 255, 128, 1]));
  expect((await handler(new Request("https://test/git/alice/demo.git", { method: "POST", headers, body: "12345" }))).status).toBe(413);
  expect(calls).toBe(1);
  expect((await handler(new Request("https://test/git/alice/%ZZ.git", { method: "POST", headers }))).status).toBe(400);
  expect((await handler(new Request("https://test/git/alice/demo.git/sibling", { method: "POST", headers }))).status).toBe(404);
  let cancelled = false;
  const chunked = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(new Uint8Array(5)); }, cancel() { cancelled = true; } });
  const oversized = new Request("https://test/git/alice/demo.git", { method: "POST", headers, body: chunked, duplex: "half" } as RequestInit);
  expect((await handler(oversized)).status).toBe(413);
  expect(cancelled).toBe(true);
  expect(calls).toBe(1);
});

it("delivers the first SSE chunk before completion and aborts on client disconnect", async () => {
  let aborted!: () => void;
  const cancellation = new Promise<void>(resolve => { aborted = resolve; });
  let requestSignal: AbortSignal;
  const host = createNodeHost({ bundle, store: new MemoryStorage(), auth: devHeaderAuth(), cursorSecret: "fixture", sweepIntervalMs: 0, telemetryFormat: "silent",
    endpoints: [{ method: "GET", path: "/logs/{run}", responseMode: "stream", handle: async (req) => {
      requestSignal = req.signal;
      req.signal.addEventListener("abort", aborted, { once: true });
      return new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode("data: first\n\n")); }, cancel() { aborted(); } }), { headers: { "content-type": "text/event-stream" } });
    } }],
  });
  const base = (await host.listen()).url;
  const controller = new AbortController();
  try {
    const res = await fetch(base + "/logs/run1", { headers, signal: controller.signal });
    expect(res.status).toBe(200);
    const reader = res.body!.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toBe("data: first\n\n");
    controller.abort();
    await cancellation;
    expect(requestSignal!.aborted).toBe(true);
  } finally { controller.abort(); await host.stop(); }
}, 5000);

it("preserves arbitrary Lambda binary bytes and refuses SSE buffering", async () => {
  const bytes = new Uint8Array([0, 255, 128, 13, 10]);
  const req = toRequest({ rawPath: "/binary", requestContext: { http: { method: "POST" }, requestId: "r" }, body: Buffer.from(bytes).toString("base64"), isBase64Encoded: true });
  expect(new Uint8Array(await req.arrayBuffer())).toEqual(bytes);
  expect(await toResult(new Response(bytes, { headers: { "content-type": "application/octet-stream" } }))).toMatchObject({ body: Buffer.from(bytes).toString("base64"), isBase64Encoded: true });
  expect(await toResult(new Response(bytes, { headers: { "content-type": "text/plain" } }))).toMatchObject({ body: Buffer.from(bytes).toString("base64"), isBase64Encoded: true });
  await expect(toResult(new Response("data: event\n\n", { headers: { "content-type": "text/event-stream" } }))).rejects.toThrow(/stream/i);
  await expect(toResult(new Response(new Uint8Array(4_194_305)))).rejects.toThrow(/4 MiB/);
});
