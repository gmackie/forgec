import { Effect } from "effect";
import type { Engine, CallContext } from "../engine.js";
import { err, type ForgeError } from "../errors.js";
import type { Wire } from "../decode.js";
const prefix = "@forgegraph/foundation/identifiers/_/";
export interface IdentifierAssignment {
  identifierSet: string;
  namespace: string;
  value: string;
  issuer?: string;
  validFrom: string;
  validUntil?: string;
}
export interface QualifiedIdentifier {
  namespace: string;
  value: string;
  issuer?: string;
}
export interface IdentifierLookup {
  identifier: string;
  identifierSet: string;
}
/** Typed sidecar operations. Applications map IdentifierSet back to a typed owner.
 * Namespace names fold to lowercase; this initial profile trims case-sensitive values. */
export class Identifiers {
  constructor(private readonly engine: Engine) {}
  private call(operation: string, input: Wire, ctx: CallContext): Effect.Effect<Wire, ForgeError> {
    return this.engine.call(prefix + operation, input, ctx);
  }
  assign(input: IdentifierAssignment, ctx: CallContext) {
    return this.call("Identifier.create", {
      identifierSet: input.identifierSet, namespace: input.namespace, value: input.value,
      issuer: input.issuer ?? null, issuerScope: input.issuer ?? "namespace",
      validFrom: input.validFrom, validUntil: input.validUntil ?? null,
    }, ctx);
  }
  revoke(identifier: string, effectiveAt: string, reason: string, ctx: CallContext) {
    return this.call("IdentifierDisposition.create", { identifier, replacement: null, effectiveAt, reason }, ctx);
  }
  supersede(identifier: string, replacement: string, effectiveAt: string, reason: string, ctx: CallContext) {
    return this.call("IdentifierDisposition.create", { identifier, replacement, effectiveAt, reason }, ctx);
  }
  lookup(qualified: QualifiedIdentifier, at: string, ctx: CallContext): Effect.Effect<IdentifierLookup | null, ForgeError> {
    const self = this;
    return Effect.gen(function* () {
      const instant = Date.parse(at);
      if (!Number.isFinite(instant) || !/^\d{4}-\d{2}-\d{2}T/.test(at) || !/(Z|[+-]\d{2}:\d{2})$/.test(at)) return yield* Effect.fail(err("ValidationFailed", "lookup instant requires an offset datetime"));
      const identifier = yield* self.call("Identifier.find.byNamespaceIssuerScopeValue", { params: {
        namespace: qualified.namespace, issuerScope: qualified.issuer ?? "namespace", value: qualified.value,
      } }, ctx).pipe(Effect.catch(e => e.code === "NotFound" ? Effect.succeed(null) : Effect.fail(e)));
      if (!identifier || instant < Date.parse(String(identifier.validFrom)) || (identifier.validUntil != null && instant >= Date.parse(String(identifier.validUntil)))) return null;
      const disposition = yield* self.call("IdentifierDisposition.find.byIdentifier", { params: { identifier: identifier.id } }, ctx).pipe(Effect.catch(e => e.code === "NotFound" ? Effect.succeed(null) : Effect.fail(e)));
      if (disposition && instant >= Date.parse(String(disposition.effectiveAt))) return null;
      return { identifier: String(identifier.id), identifierSet: String(identifier.identifierSet) };
    });
  }
  listBySet(identifierSet: string, ctx: CallContext, page: { cursor?: string; limit?: number } = {}) {
    return this.call("Identifier.list.byIdentifierSet", { params: { identifierSet }, ...page }, ctx);
  }
}
