import { Effect } from "effect";
import { decodeDatetime } from "../codecs.js";
import type { Engine, CallContext } from "../engine.js";
import { err } from "../errors.js";
import { findTerminalFact } from "./facts.js";
const prefix = "@forgegraph/foundation/classification/_/";
/** Historical meaning never floats through a supersession. The caller explicitly
 * chooses a successor revision after inspecting lifecycle at its effective time. */
export class Classification {
  constructor(private readonly engine: Engine) {}
  status(concept: string, at: string, ctx: CallContext) {
    const self = this;
    return Effect.gen(function* () {
      const instant = yield* Effect.try({ try: () => Date.parse(decodeDatetime(at)), catch: () => err("ValidationFailed", "Invalid classification instant") });
      yield* self.engine.call(prefix + "Concept.get", { id: concept }, ctx);
      const disposition = yield* findTerminalFact(self.engine, prefix + "ConceptDisposition", "concept", concept, ctx);
      if (!disposition || instant < Date.parse(String(disposition.effectiveAt))) return { state: "active" as const, replacement: null };
      return { state: disposition.replacement == null ? "retired" as const : "superseded" as const, replacement: disposition.replacement as string | null };
    });
  }
  resolveAssignment(assignment: string, ctx: CallContext) {
    const self = this;
    return Effect.gen(function* () {
      const fact = yield* self.engine.call(prefix + "ClassificationAssignment.get", { id: assignment }, ctx);
      return yield* self.engine.call(prefix + "ConceptRevision.get", { id: fact.meaning }, ctx);
    });
  }
}
