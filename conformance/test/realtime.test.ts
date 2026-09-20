/**
 * Live realtime profile check (plan §19), gated by FORGE_TARGET_URL (HTTP API)
 * and FORGE_TARGET_WS (WebSocket base). Opens a session, subscribes, causes a
 * publication through the HTTP API, expects the frame with its sequence
 * number, then reconnects and resumes by position to receive it again.
 * Connection identity is not preserved across the reconnect; the position is.
 */
import { describe, expect, it } from "vitest";

const HTTP = process.env["FORGE_TARGET_URL"];
const WS = process.env["FORGE_TARGET_WS"];
const STREAM = "@acme/commerce/_/OrderEvents";
const tenant = `rt-${Date.now().toString(36)}`;
const headers = { "content-type": "application/json", "x-forge-tenant": tenant, "x-forge-actor": "conformance" };

type Frame = Record<string, unknown> & { type: string };
function connect(url: string): Promise<{ ws: WebSocket; next: (pred?: (f: Frame) => boolean, ms?: number) => Promise<Frame>; close: () => void }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const queue: Frame[] = [];
    const waiters: { pred: (f: Frame) => boolean; res: (f: Frame) => void }[] = [];
    ws.addEventListener("message", (ev) => {
      const f = JSON.parse(String(ev.data)) as Frame;
      const i = waiters.findIndex((w) => w.pred(f));
      if (i >= 0) waiters.splice(i, 1)[0]!.res(f);
      else queue.push(f);
    });
    ws.addEventListener("error", (e) => reject(new Error(`websocket error: ${String((e as ErrorEvent).message ?? e)}`)));
    ws.addEventListener("open", () =>
      resolve({
        ws,
        next: (pred = () => true, ms = 15_000) =>
          new Promise<Frame>((res, rej) => {
            const i = queue.findIndex(pred);
            if (i >= 0) return res(queue.splice(i, 1)[0]!);
            const t = setTimeout(() => rej(new Error("timed out waiting for frame")), ms);
            waiters.push({ pred, res: (f) => { clearTimeout(t); res(f); } });
          }),
        close: () => ws.close(),
      }),
    );
  });
}

describe.skipIf(!HTTP || !WS)("realtime profile against a live deployment", () => {
  it("subscribe -> hello; a publication arrives as an event with a sequence number; a new connection resumes by position", async () => {
    const wsUrl = (base: string) => (base.includes("execute-api") ? `${base}?stream=/v1/live/orders&tenant=${tenant}&actor=conformance` : `${base}/v1/live/orders?tenant=${tenant}&actor=conformance`);
    const a = await connect(wsUrl(WS!));
    a.ws.send(JSON.stringify({ type: "subscribe", stream: STREAM }));
    const hello = await a.next((f) => f.type === "hello");
    expect(hello).toMatchObject({ type: "hello", stream: STREAM, latest: 0 });
    a.ws.send(JSON.stringify({ type: "ping" }));
    expect((await a.next((f) => f.type === "pong")).type).toBe("pong");

    const post = async (path: string, body: unknown) => {
      const r = await fetch(`${HTTP}${path}`, { method: "POST", headers, body: JSON.stringify(body) });
      if (!r.ok) throw new Error(`${path}: ${r.status} ${await r.text()}`);
      return (await r.json()) as Record<string, any>;
    };
    const c = await post("/v1/customers", { code: "RTC", name: "R" });
    const s = await post("/v1/sites", { customer: c["id"], code: "hq", name: "HQ", timezone: "UTC" });
    const o = await post("/v1/orders", { customer: c["id"], site: s["id"], subtotal: "10.00", tax: "1.00", requestedOn: "2026-09-20" });
    await post(`/v1/orders/${o["id"]}/submit`, { expectedVersion: 1 });

    const ev = await a.next((f) => f.type === "event", 30_000);
    expect(ev).toMatchObject({ type: "event", stream: STREAM, seq: 1, message: "OrderSubmitted", payload: { order: o["id"] } });
    a.close();

    // New connection, new provider connection id; the stream position is what carries over.
    const b = await connect(wsUrl(WS!));
    b.ws.send(JSON.stringify({ type: "resume", stream: STREAM, after: 0 }));
    const resumed = await b.next((f) => f.type === "resumed");
    expect(resumed).toMatchObject({ type: "resumed", stream: STREAM, after: 0, replayed: 1, gap: false, latest: 1 });
    const replayed = await b.next((f) => f.type === "event");
    expect(replayed).toMatchObject({ seq: 1, message: "OrderSubmitted" });
    b.ws.send(JSON.stringify({ type: "subscribe", stream: "@acme/commerce/_/Nope" }));
    expect(await b.next((f) => f.type === "error")).toMatchObject({ code: "UnknownStream" });
    b.close();
  }, 90_000);
});
