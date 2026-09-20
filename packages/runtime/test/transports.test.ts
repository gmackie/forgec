import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { cloudflareQueuesTransport, decodeEnvelope, sqsTransport } from "../src/transports.js";

const env = { channel: "c", message: "M", tenant: "acme", opId: "op", ordinal: 0, messageId: "op:0", payload: { a: 1 }, createdAt: "t" };

describe("transports", () => {
  it("cloudflare: sends the envelope as JSON to the subscription's queue binding; unknown subscription fails", async () => {
    const sent: unknown[] = [];
    const t = cloudflareQueuesTransport({ "fulfill-order": { send: async (b) => void sent.push(b) } });
    await Effect.runPromise(t.send({ subscription: "fulfill-order", envelope: env }));
    expect(sent).toEqual([env]);
    const exit = await Effect.runPromiseExit(t.send({ subscription: "nope", envelope: env }));
    expect(exit._tag).toBe("Failure");
  });
  it("sqs: serializes the envelope and passes the messageId as dedup id", async () => {
    const calls: [string, string, string][] = [];
    const t = sqsTransport({ send: async (u, b, d) => void calls.push([u, b, d]) }, { "fulfill-order": "https://sqs/q" });
    await Effect.runPromise(t.send({ subscription: "fulfill-order", envelope: env }));
    expect(calls[0]![0]).toBe("https://sqs/q");
    expect(decodeEnvelope(calls[0]![1])).toEqual(env);
    expect(calls[0]![2]).toBe("op:0");
  });
  it("decodeEnvelope rejects foreign messages", () => {
    expect(() => decodeEnvelope({ hello: 1 })).toThrow();
  });
});
