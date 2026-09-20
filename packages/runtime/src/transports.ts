/**
 * Delivery transports (plan §14): one durable queue per logical subscription.
 * Cloudflare Queues allow one consumer per queue, so the planner names a
 * queue per subscription; SQS likewise gets a queue per subscription.
 * Envelopes are JSON; the consumer host decodes them and calls
 * engine.consume(subscription, envelope), which dedups by messageId.
 */
import { Effect } from "effect";
import type { Delivery, Envelope, Transport } from "./dispatch.js";

export interface QueueLike {
  send(body: unknown, options?: { contentType?: string }): Promise<void>;
}

/** Cloudflare Queues: `bindings[subscription]` is the queue producer binding. */
export function cloudflareQueuesTransport(bindings: Record<string, QueueLike>): Transport {
  return {
    name: "cloudflare-queues",
    send: (d: Delivery) => {
      const q = bindings[d.subscription];
      if (!q) return Effect.fail(new Error(`no queue binding for subscription ${d.subscription}`));
      return Effect.tryPromise({ try: () => q.send(d.envelope, { contentType: "json" }), catch: (e) => (e instanceof Error ? e : new Error(String(e))) });
    },
  };
}

export interface SqsLike {
  send(queueUrl: string, body: string, dedupId: string): Promise<void>;
}

/** AWS SQS: `urls[subscription]` is the queue URL. Standard queues; dedup is the consumer's job. */
export function sqsTransport(client: SqsLike, urls: Record<string, string>): Transport {
  return {
    name: "sqs",
    send: (d: Delivery) => {
      const url = urls[d.subscription];
      if (!url) return Effect.fail(new Error(`no queue url for subscription ${d.subscription}`));
      return Effect.tryPromise({ try: () => client.send(url, JSON.stringify(d.envelope), d.envelope.messageId), catch: (e) => (e instanceof Error ? e : new Error(String(e))) });
    },
  };
}

export function decodeEnvelope(raw: unknown): Envelope {
  const e = typeof raw === "string" ? (JSON.parse(raw) as Envelope) : (raw as Envelope);
  if (!e || typeof e.messageId !== "string" || typeof e.tenant !== "string" || typeof e.channel !== "string") throw new Error("not a forge envelope");
  return e;
}
