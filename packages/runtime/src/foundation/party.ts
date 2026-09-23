import { Effect } from "effect";
import { decodeDatetime } from "../codecs.js";
import type { Wire } from "../decode.js";
import type { Engine, CallContext } from "../engine.js";
import { err, type ForgeError } from "../errors.js";
import { findTerminalFact } from "./facts.js";

const prefix = "@forgegraph/foundation/party/_/";
export interface RepresentationFact { representation: string; principal: string; party: string }
export interface RepresentationPage { items: RepresentationFact[]; next: string | null }
/** Durable business identity only. These facts never authenticate or authorize a caller. */
export class Parties {
  constructor(private readonly engine: Engine) {}
  private call(operation: string, input: Wire, ctx: CallContext): Effect.Effect<Wire, ForgeError> {
    return this.engine.call(prefix + operation, input, ctx);
  }
  create(input: { label: string; identifiers?: string }, ctx: CallContext) {
    return this.call("Party.create", { label: input.label, identifiers: input.identifiers ?? null }, ctx);
  }
  represent(input: { party: string; principal: string; validFrom: string; validUntil?: string; reason: string }, ctx: CallContext) {
    return this.call("PrincipalRepresentation.create", { ...input, validUntil: input.validUntil ?? null, recordedBy: ctx.actor }, ctx);
  }
  revoke(representation: string, effectiveAt: string, reason: string, ctx: CallContext) {
    return this.call("RepresentationRevocation.create", { representation, effectiveAt, reason, recordedBy: ctx.actor }, ctx);
  }
  listRepresentedAt(principal: string, at: string, ctx: CallContext, page: { cursor?: string; limit?: number } = {}): Effect.Effect<RepresentationPage, ForgeError> {
    const self = this;
    return Effect.gen(function* () {
      const instant = yield* Effect.try({ try: () => Date.parse(decodeDatetime(at)), catch: () => err("ValidationFailed", "Invalid representation lookup instant") });
      const rows = yield* self.call("PrincipalRepresentation.list.byPrincipal", { params: { principal }, ...page }, ctx);
      const items: RepresentationFact[] = [];
      for (const row of rows.items as Wire[]) {
        if (instant < Date.parse(String(row.validFrom)) || row.validUntil != null && instant >= Date.parse(String(row.validUntil))) continue;
        const revocation = yield* findTerminalFact(self.engine, prefix + "RepresentationRevocation", "representation", row.id, ctx);
        if (revocation && instant >= Date.parse(String(revocation.effectiveAt))) continue;
        // A readable association does not bypass the target Party's read policy.
        yield* self.call("Party.get", { id: row.party }, ctx);
        items.push({ representation: String(row.id), principal: String(row.principal), party: String(row.party) });
      }
      return { items, next: rows.next as string | null };
    });
  }
}
