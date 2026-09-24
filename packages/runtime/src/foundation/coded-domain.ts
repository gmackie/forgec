import { Effect } from "effect";
import { decodeDatetime } from "../codecs.js";
import type { Engine, CallContext } from "../engine.js";
import type { Wire } from "../decode.js";
import { err, type ForgeError } from "../errors.js";
import { findTerminalFact } from "./facts.js";
import { Evidence } from "./evidence.js";

const p = "@forgegraph/foundation/coded-domain/_/";
const identifiers = "@forgegraph/foundation/identifiers/_/";
const instant = (at: string) => Effect.try({
  try: () => Date.parse(decodeDatetime(at)),
  catch: () => err("ValidationFailed", "Invalid coded-domain instant"),
});
function inWindow(row: Wire, at: number) {
  return at >= Date.parse(String(row.validFrom)) &&
    (row.validUntil == null || at < Date.parse(String(row.validUntil)));
}
/** Resolves exact historical meaning. Never follows a replacement implicitly. */
export class CodedDomains {
  constructor(private readonly engine: Engine) {}
  private call(op: string, input: Wire, ctx: CallContext) {
    return this.engine.call(p + op, input, ctx);
  }
  private support(id: unknown, ctx: CallContext): Effect.Effect<void, ForgeError> {
    const self = this;
    return Effect.gen(function* () {
      if (id == null) return;
      const seal = yield* self.engine.call("@forgegraph/foundation/evidence/_/EvidenceSeal.get", { id }, ctx);
      yield* new Evidence(self.engine).sealedItems(String(seal.bundle), ctx);
    });
  }
  inspect(revision: string, at: string, ctx: CallContext) {
    const self = this;
    return Effect.gen(function* () {
      const time = yield* instant(at);
      const meaning = yield* self.call("CodeRevision.get", { id: revision }, ctx);
      const code = yield* self.call("Code.get", { id: meaning.code }, ctx);
      const domain = yield* self.call("CodedDomain.get", { id: code.domain }, ctx);
      yield* self.engine.call(identifiers + "Issuer.get", { id: domain.authority }, ctx);
      const release = yield* self.call("DomainRelease.get", { id: meaning.release }, ctx);
      yield* self.support(release.support, ctx);
      yield* self.support(meaning.support, ctx);
      if (meaning.meaning != null) yield* self.engine.call("@forgegraph/foundation/classification/_/ConceptRevision.get", { id: meaning.meaning }, ctx);
      const withdrawal = yield* findTerminalFact(self.engine, p + "ReleaseWithdrawal", "release", release.id, ctx);
      const disposition = yield* findTerminalFact(self.engine, p + "CodeDisposition", "code", code.id, ctx);
      const successor = yield* findTerminalFact(self.engine, p + "CodeRevision", "previous", meaning.id, ctx);
      yield* self.support(withdrawal?.support, ctx);
      yield* self.support(disposition?.support, ctx);
      let state: "active" | "inactive" | "withdrawn" | "retired" | "superseded" = "active";
      let replacement: string | null = null;
      if (!inWindow(meaning, time) || !inWindow(release, time)) state = "inactive";
      else if (withdrawal && time >= Date.parse(String(withdrawal.effectiveAt))) state = "withdrawn";
      else if (disposition && time >= Date.parse(String(disposition.effectiveAt))) {
        state = disposition.replacement == null ? "retired" : "superseded";
        replacement = disposition.replacement as string | null;
      } else if (successor && time >= Date.parse(String(successor.validFrom))) {
        state = "superseded";
        replacement = String(successor.id);
      }
      return { state, replacement, code, meaning, domain, release };
    });
  }
  inspectMapping(revision: string, at: string, ctx: CallContext) {
    const self = this;
    return Effect.gen(function* () {
      const time = yield* instant(at);
      const row = yield* self.call("MappingRevision.get", { id: revision }, ctx);
      const mapping = yield* self.call("ConceptMapping.get", { id: row.mapping }, ctx);
      yield* self.engine.call(identifiers + "Issuer.get", { id: mapping.authority }, ctx);
      const meaning = yield* self.engine.call("@forgegraph/foundation/classification/_/ConceptRevision.get", { id: row.meaning }, ctx);
      yield* self.support(row.support, ctx);
      const successor = yield* findTerminalFact(self.engine, p + "MappingRevision", "previous", row.id, ctx);
      const code = yield* self.inspect(String(row.codeRevision), at, ctx);
      return {
        active: inWindow(row, time) && code.state === "active" &&
          (!successor || time < Date.parse(String(successor.validFrom))),
        relation: row.relation, meaning, code, mapping, revision: row,
      };
    });
  }
}
