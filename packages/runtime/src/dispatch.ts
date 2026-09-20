/**
 * Outbox dispatcher (plan §14). Sweep -> claim (lease) -> deliver to every
 * logical subscription -> record per-subscription progress -> complete.
 * At-least-once: a transport may be told twice; consumers dedup by messageId.
 * Poison rows park as `dead` after maxAttempts and can be redriven.
 */
import { Effect } from "effect";
import type { Model } from "./model.js";
import type { OutboxRow, StorageAdapter } from "./services.js";

export interface Envelope {
  channel: string;
  message: string;
  tenant: string;
  opId: string;
  ordinal: number;
  /** Stable per logical message: `${opId}:${ordinal}`; consumers dedup on it. */
  messageId: string;
  payload: any;
  createdAt: string;
}
export interface Delivery {
  subscription: string;
  envelope: Envelope;
}
/** Where a delivery goes: a queue per subscription (Cloudflare Queues, SQS), or an in-process consumer. */
export interface Transport {
  readonly name: string;
  send(d: Delivery): Effect.Effect<void, Error>;
}
export interface DispatcherOptions {
  /** channel id -> logical subscription names (one durable delivery each). */
  subscriptions: Record<string, string[]>;
  leaseMs: number;
  maxAttempts: number;
  owner?: string;
  batch?: number;
}
export interface SweepReport {
  claimed: number;
  delivered: number;
  failed: number;
  dead: number;
}

export function envelopeOf(row: OutboxRow): Envelope {
  return { channel: row.channel, message: row.message, tenant: row.tenant, opId: row.opId, ordinal: row.ordinal, messageId: `${row.opId}:${row.ordinal}`, payload: row.payload, createdAt: row.createdAt };
}

export class Dispatcher {
  private readonly owner: string;
  constructor(readonly model: Model, private readonly storage: StorageAdapter, private readonly transport: Transport, private readonly opts: DispatcherOptions) {
    this.owner = opts.owner ?? `dispatcher-${Math.random().toString(36).slice(2, 10)}`;
  }

  subscriptionsFor(channel: string): string[] {
    return this.opts.subscriptions[channel] ?? [];
  }

  /** One pass: bounded, safe to run concurrently with other dispatchers (claims are conditional). */
  sweep(tenant: string, o: { now: number }): Effect.Effect<SweepReport, Error> {
    const self = this;
    return Effect.gen(function* () {
      const report: SweepReport = { claimed: 0, delivered: 0, failed: 0, dead: 0 };
      const rows = yield* self.storage.outboxSweep(tenant, o.now, self.opts.batch ?? 50);
      for (const row of rows) {
        const key = { tenant: row.tenant, opId: row.opId, ordinal: row.ordinal };
        const claimed = yield* self.storage.outboxClaim(key, self.owner, o.now, self.opts.leaseMs);
        if (!claimed) continue;
        report.claimed++;
        const subs = self.subscriptionsFor(row.channel);
        const env = envelopeOf(row);
        const done: string[] = [...row.delivered];
        let failedAny = false;
        for (const sub of subs) {
          if (done.includes(sub)) continue; // already delivered on an earlier attempt: never repeat it
          const exit = yield* Effect.exit(self.transport.send({ subscription: sub, envelope: env }));
          if (exit._tag === "Success") {
            done.push(sub);
            report.delivered++;
            // persist per-subscription progress immediately so a crash here cannot re-deliver to `sub`
            yield* self.storage.outboxProgress(key, self.owner, { delivered: [sub] });
          } else {
            failedAny = true;
            report.failed++;
          }
        }
        // Per-subscription progress was persisted as each delivery succeeded; the final write only changes status.
        if (!failedAny) {
          yield* self.storage.outboxProgress(key, self.owner, { delivered: [], done: true });
        } else if (row.attempts + 1 >= self.opts.maxAttempts) {
          yield* self.storage.outboxProgress(key, self.owner, { delivered: [], dead: true });
          report.dead++;
        }
        // else: keep the lease until it expires (natural backoff), then another sweep retries the rest
      }
      return report;
    });
  }

  dead(tenant: string) {
    return this.storage.outboxDead(tenant);
  }
  redrive(tenant: string, opId: string, ordinal: number) {
    return this.storage.outboxRedrive({ tenant, opId, ordinal });
  }

  /** Wrap a handler with the consumer-side dedup ledger (processed once per subscription per messageId). */
  consumer(subscription: string, handler: (env: Envelope) => Promise<void>): (env: Envelope) => Promise<"processed" | "duplicate"> {
    return async (env) => {
      const fresh = await Effect.runPromise(this.storage.markProcessed(env.tenant, subscription, env.messageId));
      if (!fresh) return "duplicate";
      await handler(env);
      return "processed";
    };
  }
}
