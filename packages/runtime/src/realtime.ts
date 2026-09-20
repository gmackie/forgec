/**
 * Realtime profile (plan §19). Channels bound with `@websocket(path)` are
 * streams: their publications reach the stream ledger through the same
 * outbox as every other consumer (logical subscription `realtime:<Channel>`),
 * receive a per-(tenant, stream) sequence number there, are kept in a bounded
 * replay window, and are then pushed to live sessions by the provider hub.
 *
 * What the profile promises: text JSON frames capped at `maxFrameBytes`,
 * increasing sequence numbers per stream, replay from a position within the
 * window (an explicit `gap` otherwise), at-least-once delivery. What it does
 * not: preserved connection identity or exactly-once through disconnects —
 * clients resume by position, never by connection.
 */
import { Effect } from "effect";
import type { Wire } from "./decode.js";
import type { Envelope, Transport } from "./dispatch.js";
import type { Engine } from "./engine.js";
import { err, type ForgeError } from "./errors.js";
import { Storage, type RuntimeServices } from "./services.js";

const KIND = "realtime";
export const MAX_FRAME_BYTES = 65_536;
export const DEFAULT_REPLAY_DEPTH = 256;

export type EventFrame = { type: "event"; stream: string; seq: number; message: string; messageId: string; payload: Wire; at: string };
export type RealtimeFrame =
  | EventFrame
  | { type: "hello"; stream: string; latest: number }
  | { type: "resumed"; stream: string; after: number; replayed: number; gap: boolean; latest: number }
  | { type: "error"; code: string; detail: string }
  | { type: "pong" };
export type InboundFrame = { type: "subscribe"; stream: string } | { type: "resume"; stream: string; after: number } | { type: "ping" };

/** Provider fan-out: Durable Object sockets on Cloudflare, API Gateway connections on AWS. */
export interface RealtimeHub {
  broadcast(tenant: string, channel: string, frame: EventFrame): Promise<void>;
}

interface Ledger { seq: number; ring: EventFrame[]; ids: string[]; _version?: number }

export class Realtime {
  hub: RealtimeHub | null = null;
  replayDepth = DEFAULT_REPLAY_DEPTH;
  constructor(private readonly engine: Engine) {}

  streams(): { channel: string; name: string; path: string }[] {
    return this.engine.model.channels.filter((c) => c.websocket).map((c) => ({ channel: c.id, name: c.name, path: c.websocket!.path }));
  }
  stream(channel: string) {
    return this.streams().find((s) => s.channel === channel) ?? null;
  }
  streamByPath(path: string) {
    return this.streams().find((s) => s.path === path) ?? null;
  }

  /** Assign the next sequence number and keep the frame in the bounded replay window (idempotent per messageId). */
  append(tenant: string, channel: string, env: Envelope): Effect.Effect<EventFrame | null, ForgeError, RuntimeServices> {
    const self = this;
    return Effect.gen(function* () {
      const storage = yield* Storage;
      const docId = `${channel}:ledger`;
      for (let attempt = 0; attempt < 5; attempt++) {
        const cur = ((yield* storage.getDocument(tenant, KIND, docId)) ?? { seq: 0, ring: [], ids: [] }) as unknown as Ledger;
        if (cur.ids.includes(env.messageId)) return null; // redelivery: already sequenced
        const frame: EventFrame = { type: "event", stream: channel, seq: cur.seq + 1, message: env.message, messageId: env.messageId, payload: env.payload as Wire, at: env.createdAt };
        const ring = [...cur.ring, frame].slice(-self.replayDepth);
        const ids = [...cur.ids, env.messageId].slice(-self.replayDepth * 4);
        const { _version, ...rest } = cur;
        void rest;
        const r = yield* Effect.exit(storage.putDocument(tenant, KIND, docId, { seq: frame.seq, ring, ids }, _version ?? null));
        if (r._tag === "Success") return frame;
      }
      return yield* Effect.fail(err("TransientConflict", "realtime ledger contention"));
    });
  }

  /** Frames after `after` within the window; `gap` when older frames were dropped. */
  replay(tenant: string, channel: string, after: number): Effect.Effect<{ frames: EventFrame[]; gap: boolean; latest: number }, ForgeError, RuntimeServices> {
    return Effect.gen(function* () {
      const cur = ((yield* (yield* Storage).getDocument(tenant, KIND, `${channel}:ledger`)) ?? { seq: 0, ring: [], ids: [] }) as unknown as Ledger;
      const oldest = cur.ring[0]?.seq ?? cur.seq + 1;
      const frames = cur.ring.filter((f) => f.seq > after);
      return { frames, gap: after + 1 < oldest, latest: cur.seq };
    });
  }

  /** `realtime:<Channel>` logical subscriptions on every bound channel. */
  subscriptions(base: Record<string, string[]> = {}): Record<string, string[]> {
    const out: Record<string, string[]> = Object.fromEntries(Object.entries(base).map(([k, v]) => [k, [...v]]));
    for (const s of this.streams()) (out[s.channel] ??= []).push(`realtime:${s.name}`);
    return out;
  }

  /** In-process transport: sequence in the ledger, then hand to the provider hub. */
  transport(): Transport {
    const self = this;
    return {
      name: "realtime",
      send: (d) => {
        const s = self.streams().find((x) => `realtime:${x.name}` === d.subscription);
        if (!s) return Effect.fail(new Error(`unknown realtime subscription ${d.subscription}`));
        return self.append(d.envelope.tenant, s.channel, d.envelope).pipe(
          Effect.provide(self.engine.layer),
          Effect.mapError((e) => new Error(e.message)),
          Effect.flatMap((frame) => (frame && self.hub ? Effect.tryPromise({ try: () => self.hub!.broadcast(d.envelope.tenant, s.channel, frame), catch: (e) => new Error(String(e)) }) : Effect.void)),
        );
      },
    };
  }
}

/**
 * Browsers cannot set headers on a WebSocket upgrade, so the auth host sees a
 * request whose `x-forge-*` headers are lifted from the query string
 * (`?tenant=&actor=` for development header auth; real hosts pass a token).
 */
export function upgradeAuthRequest(url: URL, headers: Headers): Request {
  const h = new Headers(headers);
  for (const [k, v] of url.searchParams) {
    if (k === "tenant") h.set("x-forge-tenant", v);
    else if (k === "actor") h.set("x-forge-actor", v);
    else if (k === "token") h.set("authorization", `Bearer ${v}`);
  }
  return new Request(url.toString(), { headers: h });
}

/**
 * The shared session protocol (used verbatim by the Durable Object and the
 * API Gateway handler): validates inbound frames, tracks subscriptions, and
 * answers with the frames to send back.
 */
export class SessionProtocol {
  private readonly subs = new Set<string>();
  constructor(private readonly engine: Engine, readonly tenant: string) {}

  subscribed(stream: string): boolean {
    return this.subs.has(stream);
  }
  accepts(tenant: string, stream: string): boolean {
    return tenant === this.tenant && this.subs.has(stream);
  }
  /** Restore subscriptions (hibernated sockets, connection registries). */
  restore(streams: string[]): void {
    for (const s of streams) this.subs.add(s);
  }
  streams(): string[] {
    return [...this.subs];
  }

  async handle(text: string): Promise<RealtimeFrame[]> {
    if (new TextEncoder().encode(text).length > MAX_FRAME_BYTES) return [{ type: "error", code: "FrameTooLarge", detail: String(MAX_FRAME_BYTES) }];
    let frame: InboundFrame;
    try {
      frame = JSON.parse(text) as InboundFrame;
    } catch {
      return [{ type: "error", code: "MalformedFrame", detail: "text JSON expected" }];
    }
    if (!frame || typeof frame !== "object" || typeof frame.type !== "string") return [{ type: "error", code: "MalformedFrame", detail: "text JSON expected" }];
    if (frame.type === "ping") return [{ type: "pong" }];
    if (frame.type !== "subscribe" && frame.type !== "resume") return [{ type: "error", code: "UnknownFrame", detail: String((frame as { type: string }).type) }];
    const stream = this.engine.realtime.stream(String(frame.stream));
    if (!stream) return [{ type: "error", code: "UnknownStream", detail: String(frame.stream) }];
    this.subs.add(stream.channel);
    if (frame.type === "subscribe") {
      const r = await Effect.runPromise(this.engine.realtime.replay(this.tenant, stream.channel, Number.MAX_SAFE_INTEGER).pipe(Effect.provide(this.engine.layer)));
      return [{ type: "hello", stream: stream.channel, latest: r.latest }];
    }
    const after = Math.max(0, Number(frame.after ?? 0));
    const r = await Effect.runPromise(this.engine.realtime.replay(this.tenant, stream.channel, after).pipe(Effect.provide(this.engine.layer)));
    return [{ type: "resumed", stream: stream.channel, after, replayed: r.frames.length, gap: r.gap, latest: r.latest }, ...r.frames];
  }
}
