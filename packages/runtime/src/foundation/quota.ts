import { Effect } from "effect";
import { decodeDatetime, decodeDecimal, formatMinor, toMinor } from "../codecs.js";
import type { Engine, CallContext } from "../engine.js";
import type { Wire } from "../decode.js";
import { err } from "../errors.js";
import { findTerminalFact } from "./facts.js";
import { Usage } from "./usage.js";
import { Allocations } from "./allocation.js";

const p = "@forgegraph/foundation/quota/_/";
const ep = "@forgegraph/foundation/entitlement/_/";
function check(ok: unknown, detail: string) { return ok ? Effect.void : Effect.fail(err("ValidationFailed", detail)); }
function bounds(row: Wire, at: number) {
  const start = Date.parse(String(row.validFrom)), end = Date.parse(String(row.validUntil));
  let from = start, until = end;
  const date = new Date(at), span = Number(row.windowSeconds) * 1000;
  switch (row.window) {
    case "Fixed": break;
    case "Rolling": from = Math.max(start, at - span); until = at; break;
    case "Tumbling": from = start + Math.floor((at - start) / span) * span; until = Math.min(end, from + span); break;
    case "CalendarDay": date.setUTCHours(0, 0, 0, 0); from = date.getTime(); date.setUTCDate(date.getUTCDate() + 1); until = date.getTime(); break;
    case "CalendarMonth": date.setUTCDate(1); date.setUTCHours(0, 0, 0, 0); from = date.getTime(); date.setUTCMonth(date.getUTCMonth() + 1); until = date.getTime(); break;
    case "CalendarYear": date.setUTCMonth(0, 1); date.setUTCHours(0, 0, 0, 0); from = date.getTime(); date.setUTCFullYear(date.getUTCFullYear() + 1); until = date.getTime(); break;
    default: throw err("ValidationFailed", "Unknown quota window");
  }
  return { from: Math.max(start, from), until: Math.min(end, until) };
}
/** Read-only allowance decisions. A caller must atomically enforce at execution. */
export class Quotas {
  constructor(private readonly engine: Engine) {}
  inspect(allowance: string, at: string, ctx: CallContext, requested = "0") {
    const self = this;
    return Effect.gen(function* () {
      const time = yield* Effect.try({ try: () => Date.parse(decodeDatetime(at)), catch: () => err("ValidationFailed", "Invalid quota instant") });
      const quantity = yield* Effect.try({ try: () => toMinor(decodeDecimal(requested, { scale: 6, min: "0" }), 6), catch: () => err("ValidationFailed", "Invalid quota request quantity") });
      const row = yield* self.engine.call(p + "Allowance.get", { id: allowance }, ctx);
      const grant = yield* self.engine.call(ep + "Entitlement.get", { id: row.grant }, ctx);
      yield* self.engine.call(ep + "EntitlementScope.get", { id: row.scope }, ctx);
      yield* self.engine.call(ep + "RightDefinition.get", { id: grant.right }, ctx);
      yield* self.engine.call("@forgegraph/foundation/party/_/Party.get", { id: grant.holder }, ctx);
      yield* self.engine.call("@forgegraph/foundation/specification/_/SpecificationPin.get", { id: row.policy }, ctx);
      const dimension = yield* self.engine.call("@forgegraph/foundation/usage/_/UsageDimension.get", { id: row.dimension }, ctx);
      const ended = yield* findTerminalFact(self.engine, ep + "EntitlementEnd", "entitlement", grant.id, ctx);
      yield* check(time >= Date.parse(String(row.validFrom)) && time < Date.parse(String(row.validUntil)) &&
        time >= Date.parse(String(grant.validFrom)) && (grant.validUntil == null || time < Date.parse(String(grant.validUntil))) &&
        (!ended || time < Date.parse(String(ended.effectiveAt))), "Allowance or source entitlement is inactive");
      yield* check(row.unit === dimension.unit && row.scope === grant.scope, "Quota unit or scope mismatch");
      const window = yield* Effect.try({ try: () => bounds(row, time), catch: () => err("ValidationFailed", "Invalid quota window") });
      // Consumption is measured only up to the decision instant, even in a future-ending bucket.
      const through = Math.min(time, window.until);
      let used = 0n, reserved = 0n;
      let usageEventIds: string[] = [], allocationHead: string | null = null;
      const reservationIds: string[] = [];
      if (row.stream != null) yield* self.engine.call("@forgegraph/foundation/usage/_/UsageStream.get", { id: row.stream }, ctx);
      if (row.stream != null && through > window.from) {
        const projection = yield* new Usage(self.engine).aggregate(String(row.stream), new Date(window.from).toISOString(), new Date(through).toISOString(), ctx);
        yield* check(projection.dimension === row.dimension && projection.unit === row.unit, "Quota usage dimension mismatch");
        used = toMinor(projection.quantity, 6); usageEventIds = projection.eventIds;
      }
      if (row.pool != null) {
        const allocation = yield* new Allocations(self.engine).inspect(String(row.pool), new Date(time).toISOString(), ctx);
        yield* check(allocation.unit === row.unit, "Quota allocation unit mismatch");
        allocationHead = allocation.head == null ? null : String(allocation.head);
        for (const claim of allocation.claims) {
          if (row.measure === "UsageAndReservations" && claim.phase !== "reserved") continue;
          const reservation = yield* self.engine.call("@forgegraph/foundation/allocation/_/AllocationReservation.get", { id: claim.reservation }, ctx);
          reserved += toMinor(String(reservation.quantity), 6); reservationIds.push(claim.reservation);
        }
      }
      const consumed = used + reserved, limit = toMinor(String(row.limit), 6), projected = consumed + quantity;
      const exceeded = projected > limit, warning = projected >= toMinor(String(row.warningAt), 6);
      return {
        allowance, grant: String(grant.id), scope: String(row.scope), dimension: String(row.dimension), unit: String(row.unit),
        from: new Date(window.from).toISOString(), until: new Date(window.until).toISOString(), through: new Date(through).toISOString(),
        limit: formatMinor(limit, 6), used: formatMinor(used, 6), reserved: formatMinor(reserved, 6), remaining: formatMinor(limit - consumed, 6),
        requested: formatMinor(quantity, 6), projected: formatMinor(projected, 6), exceeded,
        decision: exceeded && row.enforcement === "Hard" ? "Prohibit" as const : exceeded || warning ? "Warn" as const : "WithinLimit" as const,
        usageEventIds, allocationHead, reservationIds,
      };
    });
  }
}
