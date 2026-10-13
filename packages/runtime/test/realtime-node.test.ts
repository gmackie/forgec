/** WebSocket profile through a real Node socket, with memory persistence for isolation. */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Effect } from "effect";
import { expect, it } from "vitest";
import { createNodeHost } from "../src/hosts/node.js";
import { MemoryStorage } from "../src/adapters/memory.js";
import { devHeaderAuth } from "../src/http.js";
import type { AppBundle } from "../src/model.js";
import { functions, externals } from "../../../examples/acme/impl/index.js";
const bundle = JSON.parse(readFileSync(resolve(import.meta.dirname, "../../../conformance/fixtures/acme.app.json"), "utf8")) as AppBundle;
const channel = "@acme/commerce/_/OrderEvents";
async function socket(url: string) {
  const ws = new WebSocket(url);
  const frames: Record<string, unknown>[] = [];
  ws.addEventListener("message", event => frames.push(JSON.parse(String(event.data))));
  await new Promise<void>((resolve, reject) => { ws.addEventListener("open", () => resolve(), { once: true }); ws.addEventListener("error", () => reject(new Error("WebSocket connection failed")), { once: true }); });
  return { ws, frames };
}
async function waitFrame(frames: Record<string, unknown>[], type: string) {
  await expect.poll(() => frames.some(frame => frame.type === type), { timeout: 3000 }).toBe(true);
  return frames.find(frame => frame.type === type)!;
}
it("authenticates socket sessions, fans out within one tenant, and resumes on a new connection", async () => {
  const host = createNodeHost({ auth: devHeaderAuth(), bundle, store: new MemoryStorage(), cursorSecret: "test", functions, externals, sweepIntervalMs: 0, telemetryFormat: "silent" });
  const { url } = await host.listen(0);
  const sockets: WebSocket[] = [];
  try {
    const endpoint = (tenant: string) => url.replace("http:", "ws:") + `/v1/live/orders?tenant=${tenant}&actor=test`;
    const a = await socket(endpoint("acme")), b = await socket(endpoint("other")); sockets.push(a.ws, b.ws);
    for (const s of [a, b]) { s.ws.send(JSON.stringify({ type: "subscribe", stream: channel })); await waitFrame(s.frames, "hello"); }
    const ctx = { tenant: "acme", actor: "test", requestId: "test" };
    const call = (name: string, input: unknown) => Effect.runPromise(host.runtime.engine.call(`@acme/commerce/_/${name}`, input, ctx));
    const c = await call("Customer.create", { code: "SOCKET", name: "C" });
    const site = await call("Site.create", { customer: c.id, code: "hq", name: "HQ", timezone: "UTC" });
    const order = await call("Order.create", { customer: c.id, site: site.id, subtotal: "10.00", tax: "1.00", requestedOn: "2026-09-20" });
    await call("SubmitOrder", { order: order.id, expectedVersion: 1 });
    await host.runtime.sweep("acme");
    expect(await waitFrame(a.frames, "event")).toMatchObject({ seq: 1, stream: channel, message: "OrderSubmitted" });
    b.ws.send(JSON.stringify({ type: "ping" })); await waitFrame(b.frames, "pong");
    expect(b.frames.some(frame => frame.type === "event")).toBe(false);
    a.ws.close();
    const resumed = await socket(endpoint("acme")); sockets.push(resumed.ws);
    resumed.ws.send(JSON.stringify({ type: "resume", stream: channel, after: 0 }));
    expect(await waitFrame(resumed.frames, "resumed")).toMatchObject({ gap: false, replayed: 1, latest: 1 });
    expect(await waitFrame(resumed.frames, "event")).toMatchObject({ seq: 1 });
  } finally { for (const ws of sockets) ws.close(); await host.stop(); }
}, 10000);
