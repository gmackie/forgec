import { Effect } from "effect";
import type { Engine, CallContext } from "../engine.js";
import type { Wire } from "../decode.js";
import { err, type ForgeError } from "../errors.js";
import { findTerminalFact } from "./facts.js";
const prefix = "@forgegraph/foundation/evidence/_/";
/** Evidence describes support for a conclusion, never its subject or verdict.
 * Normal engine authorization governs each bundle/item and referenced artifact. */
export class Evidence {
  constructor(private readonly engine: Engine) {}
  record(input: { bundle: string; source: string; sourceRecord: string; kind: string; observedAt: string; provenance: string; revision?: string; digest?: string }, ctx: CallContext): Effect.Effect<Wire, ForgeError> {
    return this.engine.call(prefix + "EvidenceItem.create", { ...input, revision: input.revision ?? null, digest: input.digest ?? null }, ctx);
  }
  /** Candidate list only; sealedItems is the authoritative frozen support. */
  items(bundle: string, ctx: CallContext, page: {cursor?: string; limit?: number} = {}) {
    const self = this;
    return Effect.gen(function* () {
      yield* self.engine.call(prefix + "EvidenceBundle.get", { id: bundle }, ctx);
      const result = yield* self.engine.call(prefix + "EvidenceItem.list.byBundle", {params: {bundle}, ...page}, ctx);
      for (const item of result.items as Wire[]) {
        yield* self.engine.call(prefix + "EvidenceItem.get", { id: item.id }, ctx);
        yield* self.engine.call(prefix + "EvidenceSource.get", { id: item.source }, ctx);
        if (item.revision != null) yield* self.engine.call("@forgegraph/foundation/artifact/_/ArtifactRevision.get", { id: item.revision }, ctx);
      }
      return result;
    });
  }
  member(bundle: string, item: string, next: string | null, ctx: CallContext): Effect.Effect<Wire, ForgeError> {
    const self = this;
    return Effect.gen(function* () {
      yield* self.engine.call(prefix + "EvidenceItem.get", { id: item }, ctx);
      const previous = next == null ? null : yield* self.engine.call(prefix + "EvidenceMember.get", { id: next }, ctx);
      return yield* self.engine.call(prefix + "EvidenceMember.create", { bundle, item, next, depth: previous ? Number(previous.depth) + 1 : 1 }, ctx);
    });
  }
  seal(bundle: string, head: string | null, ctx: CallContext): Effect.Effect<Wire, ForgeError> {
    const self = this;
    return Effect.gen(function* () {
      yield* self.engine.call(prefix + "EvidenceBundle.get", { id: bundle }, ctx);
      yield* self.readChain(bundle, head, ctx);
      return yield* self.engine.call(prefix + "EvidenceSeal.create", { bundle, head, recordedBy: ctx.actor }, ctx);
    });
  }
  successor(predecessor: string, key: string, label: string, ctx: CallContext): Effect.Effect<Wire, ForgeError> {
    const self = this;
    return Effect.gen(function* () {
      const seal = yield* self.engine.call(prefix + "EvidenceSeal.get", { id: predecessor }, ctx);
      yield* self.engine.call(prefix + "EvidenceBundle.get", { id: seal.bundle }, ctx);
      yield* self.readChain(String(seal.bundle), seal.head == null ? null : String(seal.head), ctx);
      return yield* self.engine.call(prefix + "EvidenceBundle.create", { key, label, predecessor }, ctx);
    });
  }
  sealedItems(bundle: string, ctx: CallContext): Effect.Effect<Wire[], ForgeError> {
    const self = this;
    return Effect.gen(function* () {
      yield* self.engine.call(prefix + "EvidenceBundle.get", { id: bundle }, ctx);
      const seal = yield* findTerminalFact(self.engine, prefix + "EvidenceSeal", "bundle", bundle, ctx);
      if (!seal) return yield* Effect.fail(err("InvalidTransition", "Evidence bundle has not been sealed"));
      return yield* self.readChain(bundle, seal.head == null ? null : String(seal.head), ctx);
    });
  }
  private readChain(bundle: string, head: string | null, ctx: CallContext): Effect.Effect<Wire[], ForgeError> {
    const self = this;
    return Effect.gen(function* () {
      const items: Wire[] = [], seen = new Set<string>();
      let current = head;
      while (current != null) {
        if (seen.has(current) || items.length >= 128) return yield* Effect.fail(err("BudgetExceeded", "Evidence membership must be acyclic and bounded"));
        seen.add(current);
        const member = yield* self.engine.call(prefix + "EvidenceMember.get", { id: current }, ctx);
        if (member.bundle !== bundle) return yield* Effect.fail(err("ValidationFailed", "Evidence member belongs to another bundle"));
        const item = yield* self.engine.call(prefix + "EvidenceItem.get", { id: member.item }, ctx);
        yield* self.engine.call(prefix + "EvidenceSource.get", { id: item.source }, ctx);
        if (item.revision != null) yield* self.engine.call("@forgegraph/foundation/artifact/_/ArtifactRevision.get", { id: item.revision }, ctx);
        items.push(item);
        current = member.next == null ? null : String(member.next);
      }
      return items;
    });
  }
  artifact(item: string, ctx: CallContext): Effect.Effect<Wire | null, ForgeError> {
    const self = this;
    return Effect.gen(function* () {
      const fact = yield* self.engine.call(prefix + "EvidenceItem.get", {id: item}, ctx);
      return fact.revision == null ? null : yield* self.engine.call("@forgegraph/foundation/artifact/_/ArtifactRevision.get", {id: fact.revision}, ctx);
    });
  }
}
