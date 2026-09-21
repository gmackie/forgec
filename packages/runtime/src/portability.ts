/**
 * Provider switching (plan §22). Recompiling for another target moves no
 * data; this module does: a canonical export of every authoritative record
 * (ids, revisions, soft-delete state, blob manifests) with a canonical hash
 * per resource, an import behind a write fence that preserves identities and
 * revisions and rebuilds unique claims and access items through the normal
 * commit path, and a verification report (counts, hashes, references,
 * revisions) both sides must agree on before traffic moves. Caches and
 * projections are rebuilt on the new provider, never copied; native workflow
 * history is not portable (drain or restart from a checkpoint).
 */
import { Effect } from "effect";
import type { Wire } from "./decode.js";
import { sha256, stableJson, type CallContext, type Engine } from "./engine.js";
import { err, type ForgeError } from "./errors.js";
import type { Resource } from "./model.js";
import { Clock, IdGen, Storage, type CommitPlan, type RuntimeServices, type StoredRecord } from "./services.js";

export const EXPORT_VERSION = "export/1";
const KIND = "admin";

export interface ResourceExport { count: number; hash: string; records: StoredRecord[] }
export interface Snapshot {
  version: typeof EXPORT_VERSION;
  package: string;
  tenant: string;
  exportedAt: string;
  manifest: { contractsVersion: string; buildHash: string; resources: string[] };
  resources: Record<string, ResourceExport>;
  /** What the export deliberately leaves behind, so nobody mistakes absence for emptiness. */
  excluded: { workflowInstances: number; note: string; rebuiltOnTarget: string[] };
}

/** Canonical bytes of a record set: sorted by id, stable key order, no adapter-private fields. */
async function hashRecords(records: StoredRecord[]): Promise<string> {
  const sorted = [...records].sort((a, b) => String(a["id"]).localeCompare(String(b["id"])));
  return sha256(stableJson(sorted));
}

export class Portability {
  constructor(private readonly engine: Engine) {}

  private get authoritative(): Resource[] {
    return this.engine.model.resources;
  }

  handle(action: string, body: Wire, ctx: CallContext): Effect.Effect<Wire, ForgeError, RuntimeServices> {
    switch (action) {
      case "export": return this.export(ctx);
      case "import": return this.import(body["snapshot"] as Snapshot, ctx);
      case "verify": return this.verify(body["snapshot"] as Snapshot, ctx);
      case "fence": return this.fence(Boolean(body["on"]), ctx);
      default: return Effect.fail(err("MethodNotAllowed", `unknown admin action ${action}`));
    }
  }

  /** Every writer checks the fence before committing (plan §22: stop or fence writes during a first migration). */
  isFenced(tenant: string): Effect.Effect<boolean, ForgeError, RuntimeServices> {
    return Effect.gen(function* () {
      const doc = yield* (yield* Storage).getDocument(tenant, KIND, "fence");
      return Boolean(doc?.["on"]);
    });
  }

  private fence(on: boolean, ctx: CallContext): Effect.Effect<Wire, ForgeError, RuntimeServices> {
    return Effect.gen(function* () {
      const storage = yield* Storage;
      const cur = (yield* storage.getDocument(ctx.tenant, KIND, "fence")) as { _version?: number } | null;
      yield* storage.putDocument(ctx.tenant, KIND, "fence", { on, by: ctx.actor, at: (yield* Clock).now() }, cur?._version ?? null);
      return { fenced: on };
    });
  }

  private scanAll(tenant: string, r: Resource): Effect.Effect<StoredRecord[], ForgeError, RuntimeServices> {
    return Effect.gen(function* () {
      const storage = yield* Storage;
      const out: StoredRecord[] = [];
      let cursor: string | null = null;
      for (let page = 0; page < 100_000; page++) {
        const p: { records: StoredRecord[]; next: string | null } = yield* storage.exportPage(tenant, r, cursor, 100);
        out.push(...p.records);
        cursor = p.next;
        if (!cursor) break;
      }
      return out.sort((a, b) => String(a["id"]).localeCompare(String(b["id"])));
    });
  }

  export(ctx: CallContext): Effect.Effect<Wire, ForgeError, RuntimeServices> {
    const self = this;
    return Effect.gen(function* () {
      const resources: Record<string, ResourceExport> = {};
      for (const r of self.authoritative) {
        const records = yield* self.scanAll(ctx.tenant, r);
        const hash = yield* Effect.promise(() => hashRecords(records));
        resources[r.id] = { count: records.length, hash, records };
      }
      const b = self.engine.model.bundle;
      // Native workflow history is never translated: instances are counted so the operator drains them, not moved.
      const instances = yield* self.engine.workflows.countInstances(ctx.tenant);
      const snap: Snapshot = {
        version: EXPORT_VERSION,
        package: b.ir.package.name,
        tenant: ctx.tenant,
        exportedAt: (yield* Clock).now(),
        manifest: { contractsVersion: b.contracts.version, buildHash: b.buildHash, resources: self.authoritative.map((r) => r.id) },
        resources,
        excluded: { workflowInstances: instances, note: "workflow instances and their history are provider-native: drain them on the source or restart from a checkpoint; nothing is fabricated on the target", rebuiltOnTarget: ["projections", "caches", "subject indexes"] },
      };
      return snap as unknown as Wire;
    });
  }

  private checkSnapshot(snap: Snapshot | undefined): Effect.Effect<Snapshot, ForgeError> {
    const b = this.engine.model.bundle;
    if (!snap || snap.version !== EXPORT_VERSION) return Effect.fail(err("ValidationFailed", `expected an ${EXPORT_VERSION} snapshot`));
    if (snap.package !== b.ir.package.name) return Effect.fail(err("ValidationFailed", `snapshot is for ${snap.package}, this deployment is ${b.ir.package.name}`));
    if (snap.manifest?.contractsVersion !== b.contracts.version) return Effect.fail(err("ValidationFailed", `snapshot contracts ${snap.manifest?.contractsVersion} differ from ${b.contracts.version}; migrate the snapshot first`));
    return Effect.succeed(snap);
  }

  /** Records go through the adapter's own commit so claims, access items and integrity guards are rebuilt natively. */
  import(input: Snapshot | undefined, ctx: CallContext): Effect.Effect<Wire, ForgeError, RuntimeServices> {
    const self = this;
    return Effect.gen(function* () {
      const snap = yield* self.checkSnapshot(input);
      const storage = yield* Storage;
      const now = (yield* Clock).now();
      const ids = yield* IdGen;
      const imported: Record<string, number> = {};
      const skipped: Record<string, number> = {};
      // Parents before children so reference guards hold: order resources by dependency depth.
      for (const r of self.ordered()) {
        const ex = snap.resources[r.id];
        imported[r.id] = 0;
        skipped[r.id] = 0;
        if (!ex) continue;
        for (const rec of ex.records) {
          const id = String(rec["id"]);
          const existing = yield* storage.get(ctx.tenant, r, id);
          if (existing) { skipped[r.id]!++; continue; } // idempotent re-run: identity already present
          const opId = ids.opId();
          const plan: CommitPlan = {
            tenant: ctx.tenant, opId, actor: ctx.actor, at: now, resource: r, kind: "create", id, expectedVersion: null, before: null, after: rec,
            claims: self.engine.claimChangesFor(r, rec), references: self.engine.referenceGuardsFor(r, rec), dependents: [], hardDelete: false,
            audit: { tenant: ctx.tenant, opId, resource: r.id, recordId: id, kind: "import", newVersion: typeof rec["version"] === "number" ? (rec["version"] as number) : null, actor: ctx.actor, at: now },
            outbox: [], // an import is not a business change: no change events, no projections fed twice
          };
          yield* storage.commit(plan);
          imported[r.id]!++;
        }
      }
      return { imported, skipped, importedAt: now };
    });
  }

  verify(input: Snapshot | undefined, ctx: CallContext): Effect.Effect<Wire, ForgeError, RuntimeServices> {
    const self = this;
    return Effect.gen(function* () {
      const snap = yield* self.checkSnapshot(input);
      const storage = yield* Storage;
      const resources: Record<string, unknown> = {};
      let ok = true;
      for (const r of self.authoritative) {
        const ex = snap.resources[r.id] ?? { count: 0, hash: yield* Effect.promise(() => hashRecords([])), records: [] };
        const actual = yield* self.scanAll(ctx.tenant, r);
        const hash = yield* Effect.promise(() => hashRecords(actual));
        const byId = new Map(actual.map((x) => [String(x["id"]), x]));
        const revisionMismatches = ex.records
          .filter((e) => byId.get(String(e["id"]))?.["version"] !== e["version"])
          .map((e) => ({ id: String(e["id"]), expected: e["version"] ?? null, actual: byId.get(String(e["id"]))?.["version"] ?? null }));
        // Every reference in the migrated data resolves on this provider.
        let checked = 0;
        let missing = 0;
        for (const rec of actual) {
          for (const g of self.engine.referenceGuardsFor(r, rec)) {
            checked++;
            const target = yield* storage.get(ctx.tenant, g.resource, g.id);
            if (!target) missing++;
          }
        }
        const entry = { expectedCount: ex.count, actualCount: actual.length, hashMatch: hash === ex.hash, revisionMismatches, references: { checked, missing } };
        if (!entry.hashMatch || entry.expectedCount !== entry.actualCount || revisionMismatches.length || missing) ok = false;
        resources[r.id] = entry;
      }
      return { ok, resources, verifiedAt: (yield* Clock).now() };
    });
  }

  /** Resources ordered so that referenced resources come first (cycles fall back to declaration order). */
  private ordered(): Resource[] {
    const all = this.authoritative;
    const out: Resource[] = [];
    const seen = new Set<string>();
    const visit = (r: Resource, stack: Set<string>) => {
      if (seen.has(r.id) || stack.has(r.id)) return;
      stack.add(r.id);
      for (const f of r.fields) if (f.type.base.kind === "reference" && f.type.base.resource !== r.id) visit(this.engine.model.resource(f.type.base.resource), stack);
      stack.delete(r.id);
      seen.add(r.id);
      out.push(r);
    };
    for (const r of all) visit(r, new Set());
    return out;
  }
}
