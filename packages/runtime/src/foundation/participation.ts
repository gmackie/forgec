import { Effect } from "effect";
import { findTerminalFact } from "./facts.js";
import { decodeDatetime } from "../codecs.js";
import type { Engine, CallContext } from "../engine.js";
import { err, type ForgeError } from "../errors.js";
import type { Wire } from "../decode.js";
const prefix = "@forgegraph/foundation/participation/_/";
export interface RoleVocabulary<Role extends string> { readonly namespace: string; readonly roles: readonly Role[] }
export interface ParticipationFact { participation: string; participant: string; role: string; participationSet: string }
export interface ParticipationPage { items: ParticipationFact[]; next: string | null }
/** Facts only: membership never implies authorization. Domain wrappers own the vocabulary. */
export class Participations<Role extends string> {
  private readonly namespace: string;
  private readonly roles: ReadonlySet<string>;
  constructor(private readonly engine: Engine, vocabulary: RoleVocabulary<Role>) {
    this.namespace = vocabulary.namespace.trim().toLowerCase();
    if (!this.namespace || !vocabulary.roles.length || vocabulary.roles.some(r => !r || r.trim() !== r) || new Set(vocabulary.roles).size !== vocabulary.roles.length) throw new Error("Invalid participation role vocabulary");
    this.roles = new Set(vocabulary.roles);
  }
  private call(op: string, input: Wire, ctx: CallContext): Effect.Effect<Wire, ForgeError> { return this.engine.call(prefix + op, input, ctx); }
  registerRole(role: Role, ctx: CallContext) {
    if (!this.roles.has(role)) return Effect.fail(err("ValidationFailed", "Role is outside the declared vocabulary"));
    return this.call("ParticipationRole.create", { namespace: this.namespace, name: role }, ctx);
  }
  add(input: { participationSet: string; participant: string; role: Role; validFrom: string; validUntil?: string; reason: string }, ctx: CallContext) {
    const self = this;
    return Effect.gen(function* () {
      if (!self.roles.has(input.role)) return yield* Effect.fail(err("ValidationFailed", "Role is outside the declared vocabulary"));
      const role = yield* self.call("ParticipationRole.find.byNamespaceName", { params: { namespace: self.namespace, name: input.role } }, ctx);
      return yield* self.call("Participation.create", {
        participationSet: input.participationSet, participant: input.participant, role: role.id,
        validFrom: input.validFrom, validUntil: input.validUntil ?? null, reason: input.reason, recordedBy: ctx.actor,
      }, ctx);
    });
  }
  end(participation: string, effectiveAt: string, reason: string, ctx: CallContext, revoked = false) {
    return this.call("ParticipationEnd.create", { participation, effectiveAt, reason, recordedBy: ctx.actor, revoked }, ctx);
  }
  revoke(participation: string, effectiveAt: string, reason: string, ctx: CallContext) { return this.end(participation, effectiveAt, reason, ctx, true); }
  listAt(participationSet: string, at: string, ctx: CallContext, page: { cursor?: string; limit?: number } = {}): Effect.Effect<ParticipationPage, ForgeError> {
    const self = this;
    return Effect.gen(function* () {
      const instant = yield* Effect.try({ try: () => Date.parse(decodeDatetime(at)), catch: () => err("ValidationFailed", "Invalid participation lookup instant") });
      const records = yield* self.call("Participation.list.byParticipationSet", { params: { participationSet }, ...page }, ctx);
      const items: ParticipationFact[] = [];
      for (const row of records.items as Wire[]) {
        if (instant < Date.parse(String(row.validFrom)) || row.validUntil != null && instant >= Date.parse(String(row.validUntil))) continue;
        const role = yield* self.call("ParticipationRole.get", { id: row.role }, ctx);
        if (role.namespace !== self.namespace || !self.roles.has(String(role.name))) continue;
        const end = yield* findTerminalFact(self.engine, prefix + "ParticipationEnd", "participation", row.id, ctx);
        if (end && instant >= Date.parse(String(end.effectiveAt))) continue;
        items.push({ participation: String(row.id), participant: String(row.participant), role: String(role.name), participationSet });
      }
      // Preserve the storage cursor even for empty filtered pages; callers must exhaust it.
      return { items, next: records.next as string | null };
    });
  }
}
