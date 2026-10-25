// FORG-45: the harness retries an admin PUT only when a keep-alive hop dropped it, a bounded number
// of times, and logs each retry; and it will not start wrangler on a port something still serves.
// A fake server stands in for `wrangler dev`.
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
// @ts-expect-error untyped harness module
import { putBlob, startWorker } from "../scripts/harness.mjs";

const put = putBlob as (base: string, bytes: Uint8Array) => Promise<string>;
const LOST = "Error: Network connection lost.\n    at async Object.fetch (entry.worker.js:5216:22)";
let answers: Array<[number, string] | "reset"> = [];
let requests = 0;
let server: Server;
let base = "";

beforeAll(async () => {
  server = createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      requests++;
      const next = answers.shift() ?? [200, JSON.stringify({ digest: "sha256:ok" })];
      if (next === "reset") return void req.socket.resetAndDestroy();
      const [status, body] = next;
      res.writeHead(status, { "content-type": status === 200 ? "application/json" : "text/plain" });
      res.end(body);
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => server.close());

const run = async (queued: typeof answers) => {
  answers = queued;
  requests = 0;
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  try {
    const result = await put(base, new TextEncoder().encode("x")).then((digest) => ({ digest }), (e: Error) => ({ error: e.message }));
    return { ...result, requests, warnings: warn.mock.calls.map((c) => String(c[0])) };
  } finally {
    warn.mockRestore();
  }
};

describe("harness admin PUT retry (FORG-45)", () => {
  it("retries a dropped proxy hop and logs the attempt", async () => {
    const r = await run([[500, LOST]]);
    expect(r).toMatchObject({ digest: "sha256:ok", requests: 2 });
    expect(r.warnings).toHaveLength(1);
    expect(r.warnings[0]).toMatch(/blob upload: attempt 1 of 3 lost its connection \(500 Error: Network connection lost\.\); retrying in 250 ms/);
  });

  it("retries a request reset on a stale keep-alive socket", async () => {
    const r = await run(["reset"]);
    expect(r).toMatchObject({ digest: "sha256:ok", requests: 2 });
    expect(r.warnings[0]).toMatch(/blob upload: attempt 1 of 3 lost its connection \(fetch failed \(ECONNRESET\)\)/);
  });

  it("retries wrangler's restarted-mid-request answer", async () => {
    const r = await run([[503, "Your worker restarted mid-request. Please try sending the request again."]]);
    expect(r).toMatchObject({ digest: "sha256:ok", requests: 2 });
  });

  it("gives up after three attempts with the last error", async () => {
    const r = await run([[500, LOST], [500, LOST], [500, LOST]]);
    expect(r.requests).toBe(3);
    expect(r.warnings).toHaveLength(2);
    expect("error" in r && r.error).toMatch(/^blob upload failed: 500 Error: Network connection lost\.[\s\S]*\(attempt 3 of 3\)$/);
  });

  it("fails at once on any other error", async () => {
    const r = await run([[500, "Error: something else"]]);
    expect(r).toMatchObject({ error: "blob upload failed: 500 Error: something else", requests: 1, warnings: [] });
  });

  it("refuses to start wrangler on a port something already serves", async () => {
    const port = (server.address() as AddressInfo).port;
    await expect((startWorker as (o: { port: number }) => Promise<unknown>)({ port })).rejects.toThrow(`port ${port} is already in use`);
  });
});
