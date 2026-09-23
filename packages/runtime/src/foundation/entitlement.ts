import { Effect } from "effect";
import { decodeDatetime } from "../codecs.js";
import type { Engine, CallContext } from "../engine.js";
import { err, type ForgeError } from "../errors.js";
import type { Wire } from "../decode.js";
import type { Authorizer, AuthzRequest, PipValue } from "../gatekeeper.js";
import { findTerminalFact } from "./facts.js";
const prefix = "@forgegraph/foundation/entitlement/_/";
export interface ExactQuantity { quantity?: string; unit?: string }
export interface IssueEntitlement extends ExactQuantity { holder: string; right: string; scope: string; validFrom: string; validUntil?: string; reason: string }
export interface RecordObligation extends ExactQuantity { obligatedParty: string; requirement: string; scope: string; incurredAt: string; dueAt?: string; reason: string }
export interface EffectiveRight { entitlement: string; holder: string; right: string; scope: string; quantity: string | null; unit: string | null }
export interface EffectiveRightsPage { items: EffectiveRight[]; next: string | null }
function quantity(input: ExactQuantity): Wire { return { quantity: input.quantity ?? null, unit: input.unit ?? null }; }
/** Business rights and duties; never an authorization decision or consumption ledger. */
export class Entitlements {
  constructor(private readonly engine: Engine) {}
  private call(operation: string, input: Wire, ctx: CallContext): Effect.Effect<Wire, ForgeError> { return this.engine.call(prefix + operation, input, ctx); }
  issue(input: IssueEntitlement, ctx: CallContext) {
    return this.call("Entitlement.create", { ...input, ...quantity(input), validUntil: input.validUntil ?? null, predecessor: null, recordedBy: ctx.actor }, ctx);
  }
  recordObligation(input: RecordObligation, ctx: CallContext) {
    return this.call("Obligation.create", { ...input, ...quantity(input), dueAt: input.dueAt ?? null, recordedBy: ctx.actor }, ctx);
  }
  revoke(entitlement: string, effectiveAt: string, reason: string, ctx: CallContext) {
    return this.call("EntitlementEnd.create", { entitlement, kind: "Revoked", effectiveAt, reason, recordedBy: ctx.actor }, ctx);
  }
  expire(entitlement: string, reason: string, ctx: CallContext): Effect.Effect<Wire, ForgeError> {
    const self = this;
    return Effect.gen(function* () {
      const grant = yield* self.call("Entitlement.get", { id: entitlement }, ctx);
      if (grant.validUntil == null) return yield* Effect.fail(err("ValidationFailed", "An unbounded entitlement has no expiry instant"));
      return yield* self.call("EntitlementEnd.create", { entitlement, kind: "Expired", effectiveAt: grant.validUntil, reason, recordedBy: ctx.actor }, ctx);
    });
  }
  /** An independently issued successor, not reactivation. Revoking a predecessor does
   * not cancel successors. The unique predecessor reference arbitrates concurrent renewal. */
  renew(entitlement: string, input: { validFrom: string; validUntil?: string; quantity?: string; reason: string }, ctx: CallContext): Effect.Effect<Wire, ForgeError> {
    const self = this;
    return Effect.gen(function* () {
      const old = yield* self.call("Entitlement.get", { id: entitlement }, ctx);
      return yield* self.call("Entitlement.create", { holder: old.holder, right: old.right, scope: old.scope, quantity: input.quantity ?? old.quantity, unit: old.unit, validFrom: input.validFrom, validUntil: input.validUntil ?? null, predecessor: entitlement, recordedBy: ctx.actor, reason: input.reason }, ctx);
    });
  }
  endObligation(obligation: string, kind: "Discharged" | "Cancelled", effectiveAt: string, reason: string, ctx: CallContext) {
    return this.call("ObligationEnd.create", { obligation, kind, effectiveAt, recordedBy: ctx.actor, reason }, ctx);
  }
  obligationAt(obligation: string, at: string, ctx: CallContext): Effect.Effect<{ obligation: Wire; state: "NotIncurred" | "Open" | "Overdue" | "Discharged" | "Cancelled" }, ForgeError> {
    const self = this;
    return Effect.gen(function* () {
      const instant = yield* parseInstant(at);
      const row = yield* self.call("Obligation.get", { id: obligation }, ctx);
      yield* self.engine.call("@forgegraph/foundation/party/_/Party.get", { id: row.obligatedParty }, ctx);
      const end = yield* findTerminalFact(self.engine, prefix + "ObligationEnd", "obligation", row.id, ctx);
      const state = instant < Date.parse(String(row.incurredAt)) ? "NotIncurred" : end && instant >= Date.parse(String(end.effectiveAt)) ? end.kind as "Discharged" | "Cancelled" : row.dueAt != null && instant >= Date.parse(String(row.dueAt)) ? "Overdue" : "Open";
      return { obligation: row, state };
    });
  }
  listEffectiveRights(holder: string, scope: string, at: string, ctx: CallContext, page: { cursor?: string; limit?: number } = {}): Effect.Effect<EffectiveRightsPage, ForgeError> {
    const self = this;
    return Effect.gen(function* () {
      const instant = yield* parseInstant(at);
      yield* self.engine.call("@forgegraph/foundation/party/_/Party.get", { id: holder }, ctx);
      yield* self.call("EntitlementScope.get", { id: scope }, ctx);
      const rows = yield* self.call("Entitlement.list.byHolderScope", { params: { holder, scope }, ...page }, ctx);
      const items: EffectiveRight[] = [];
      for (const row of rows.items as Wire[]) {
        if (instant < Date.parse(String(row.validFrom)) || row.validUntil != null && instant >= Date.parse(String(row.validUntil))) continue;
        const end = yield* findTerminalFact(self.engine, prefix + "EntitlementEnd", "entitlement", row.id, ctx);
        if (end && instant >= Date.parse(String(end.effectiveAt))) continue;
        yield* self.call("RightDefinition.get", { id: row.right }, ctx);
        items.push({ entitlement: String(row.id), holder, scope, right: String(row.right), quantity: row.quantity == null ? null : String(row.quantity), unit: row.unit == null ? null : String(row.unit) });
      }
      return { items, next: rows.next as string | null };
    });
  }
}
function parseInstant(at: string): Effect.Effect<number, ForgeError> {
  return Effect.try({ try: () => Date.parse(decodeDatetime(at)), catch: () => err("ValidationFailed", "Invalid business-fact query instant") });
}
/** Caller supplies authorized tenant-scoped Party representation and entitlement facts.
 * Independent policy decides; reevaluate every request so unchanged records cannot cache
 * an allow across revocation or validity boundaries. Never recursively read through this bridge. */
export function entitlementPipAuthorizer(base: Authorizer, read: (request: AuthzRequest) => Effect.Effect<PipValue[], ForgeError>): Authorizer {
  return {
    get epoch() { return base.epoch; }, knownObligations: base.knownObligations,
    requirements: () => [], liveAttributes: true, rowFilterFor: () => null,
    decide: request => Effect.gen(function* () { const attributes = yield* read(request); return yield* base.decide({ ...request, attributes }); }),
  };
}
