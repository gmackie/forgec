import { Effect } from "effect";
import { decodeDatetime, decodeDecimal, formatMinor, toMinor } from "../codecs.js";
import type { Engine, CallContext } from "../engine.js";
import { err, type ForgeError } from "../errors.js";
import type { Wire } from "../decode.js";
import { Storage, type StoredRecord } from "../services.js";
import { findTerminalFact } from "./facts.js";
const prefix = "@forgegraph/foundation/usage/_/";
export interface UsageInput {
  stream: string; dimension: string; unit: string; quantity: string; ordinal: number;
  source: string; eventKey: string; occurredAt?: string;
  intervalStart?: string; intervalEnd?: string; replacementFor?: string;
}
export interface UsageProjection {
  stream: string; dimension: string; unit: string; quantity: string;
  from: string; until: string; eventIds: string[];
}
/** Exact six-decimal consumption. Projections expose a closed list of immutable
 * contributing event IDs, so replay remains stable after later corrections. */
export class Usage {
  constructor(private readonly engine: Engine) {}
  private call(op: string, input: Wire, ctx: CallContext): Effect.Effect<Wire, ForgeError> { return this.engine.call(prefix + op, input, ctx); }
  ingest(input: UsageInput, ctx: CallContext) {
    const self = this;
    return Effect.gen(function* () {
      const body = yield* Effect.try({ try: () => ({ ...input,
        unit: input.unit.trim(), quantity: decodeDecimal(input.quantity, { scale: 6, min: "0" }),
        occurredAt: input.occurredAt == null ? null : decodeDatetime(input.occurredAt),
        intervalStart: input.intervalStart == null ? null : decodeDatetime(input.intervalStart),
        intervalEnd: input.intervalEnd == null ? null : decodeDatetime(input.intervalEnd),
        replacementFor: input.replacementFor ?? null,
      }), catch: () => err("ValidationFailed", "Invalid usage quantity or instant") });
      // Unique source identity also survives receipt expiry. A duplicate is read
      // through Engine before returning; forbidden rows are never treated as absent.
      const result = yield* self.call("UsageEvent.create", body, { ...ctx, idempotencyKey: JSON.stringify([input.source, input.eventKey]) }).pipe(Effect.catch(e => {
        if (e.code !== "UniqueConflict") return Effect.fail(e);
        return self.call("UsageEvent.find.bySourceEventKey", { params: { source: input.source, eventKey: input.eventKey } }, ctx).pipe(Effect.flatMap(existing => {
          if (Object.entries(body).some(([key, value]) => existing[key] !== value)) return Effect.fail(err("IdempotencyMismatch", "source event identity reused with different measurement"));
          return Effect.succeed(existing);
        }));
      }));
      return yield* self.call("UsageEvent.get", { id: result.id }, ctx);
    });
  }
  correct(event: string, replacement: string, reason: string, ctx: CallContext) { return this.call("UsageCorrection.create", { event, replacement, reason }, ctx); }
  retract(event: string, reason: string, ctx: CallContext) { return this.call("UsageCorrection.create", { event, replacement: null, reason }, ctx); }
  private current(row: Wire, ctx: CallContext): Effect.Effect<Wire | null, ForgeError> {
    const self = this;
    return Effect.gen(function* () {
      let current = row;
      for (let depth = 0; depth < 128; depth++) {
        const correction = yield* findTerminalFact(self.engine, prefix + "UsageCorrection", "event", current.id, ctx);
        if (!correction) return current;
        if (correction.replacement == null) return null;
        current = yield* self.call("UsageEvent.get", { id: correction.replacement }, ctx);
      }
      return yield* Effect.fail(err("ValidationFailed", "Usage replacement chain exceeds 128"));
    });
  }
  aggregate(stream: string, from: string, until: string, ctx: CallContext): Effect.Effect<UsageProjection, ForgeError> {
    const self = this;
    return Effect.gen(function* () {
      const bounds = yield* Effect.try({ try: () => [decodeDatetime(from), decodeDatetime(until)] as const, catch: () => err("ValidationFailed", "Invalid usage bounds") });
      if (bounds[0] >= bounds[1]) return yield* Effect.fail(err("ValidationFailed", "Usage window must be nonempty"));
      const owner = yield* self.call("UsageStream.get", { id: stream }, ctx);
      const dimension = yield* self.call("UsageDimension.get", { id: owner.dimension }, ctx);
      const resource = self.engine.model.resource(prefix + "UsageEvent"), list = resource.lists.find(l => l.fields.length === 1 && l.fields[0] === "stream")!;
      const storage = yield* Storage, keys = self.engine.sortKeys(resource, list);
      let after: { keys: string[]; values: unknown[]; id: string } | null = null;
      let total = 0n, count = 0;
      const eventIds: string[] = [];
      do {
        // Internal enumeration prevents policy-filtered lists producing a partial
        // total. Every row is authorized via get before any fact is consumed.
        const page: { records: StoredRecord[]; hasMore: boolean } = yield* storage.list(ctx.tenant, resource, { list, values: { stream }, after, limit: 100 }, keys);
        for (const stored of page.records) {
          if (++count > 10000) return yield* Effect.fail(err("ValidationFailed", "Usage aggregation exceeds 10000 events"));
          const original = yield* self.call("UsageEvent.get", { id: stored.id }, ctx);
          if (original.replacementFor != null) continue;
          const row = yield* self.current(original, ctx);
          if (!row) continue;
          if (row.dimension !== dimension.id || row.unit !== dimension.unit) return yield* Effect.fail(err("ValidationFailed", "Usage dimension/unit mismatch"));
          if (row.occurredAt != null) {
            if (String(row.occurredAt) < bounds[0] || String(row.occurredAt) >= bounds[1]) continue;
          } else {
            if (String(row.intervalEnd) <= bounds[0] || String(row.intervalStart) >= bounds[1]) continue;
            if (String(row.intervalStart) < bounds[0] || String(row.intervalEnd) > bounds[1]) return yield* Effect.fail(err("ValidationFailed", "Partial interval requires explicit domain allocation; no implicit proration"));
          }
          total += toMinor(String(row.quantity), 6); eventIds.push(String(row.id));
        }
        const last: StoredRecord | undefined = page.records.at(-1);
        after = page.hasMore && last ? { keys: keys(last), values: list.order.map(o => last[o.field] ?? null), id: String(last.id) } : null;
      } while (after);
      return { stream, dimension: String(dimension.id), unit: String(dimension.unit), quantity: formatMinor(total, 6), from: bounds[0], until: bounds[1], eventIds };
    }).pipe(Effect.provide(self.engine.layer));
  }
  replay(projection: UsageProjection, ctx: CallContext): Effect.Effect<string, ForgeError> {
    const self = this;
    return Effect.gen(function* () {
      const stream = yield* self.call("UsageStream.get", { id: projection.stream }, ctx);
      const dimension = yield* self.call("UsageDimension.get", { id: stream.dimension }, ctx);
      if (dimension.id !== projection.dimension || dimension.unit !== projection.unit || new Set(projection.eventIds).size !== projection.eventIds.length || projection.eventIds.length > 10000) return yield* Effect.fail(err("ValidationFailed", "Invalid usage replay manifest"));
      let total = 0n;
      for (const id of projection.eventIds) {
        const row = yield* self.call("UsageEvent.get", { id }, ctx);
        if (row.stream !== projection.stream || row.dimension !== projection.dimension || row.unit !== projection.unit) return yield* Effect.fail(err("ValidationFailed", "Usage replay dimension mismatch"));
        total += toMinor(String(row.quantity), 6);
      }
      return formatMinor(total, 6);
    });
  }
}
