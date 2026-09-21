/**
 * Resumable deployment DAG with a durable ledger (FORGE-069; PAR-144/145).
 *
 * A rollout is a migration plan bound to one artifact digest and an approval
 * that names that digest. Its progress lives in one CAS-protected document
 * in the structured store (`_forge/deploy`), so any controller can resume it.
 * A controller advances steps only while it holds the rollout lease; the
 * lease carries a fencing token, and every write is checked against it, so a
 * controller that lost its lease cannot record progress or start guarded
 * steps. Completed steps are never re-run; long steps checkpoint through the
 * ledger so a successor resumes where the predecessor stopped instead of
 * repeating work. Rollback is a step like any other and consults the
 * revocation authority: it never re-activates a revoked grant.
 */
import { Effect } from "effect";
import type { StorageAdapter as StructuredStore } from "./services.js";

export const DEPLOY_KIND = "_forge/deploy";

export interface PlanStep { id: string; phase: string; kind: string; subject?: string; blocked?: boolean; requiresReview?: boolean }
export interface Approval { artifact: string; signedBy: string; signature: string }
export interface Lease { controller: string; token: number; until: number }
export interface StepState { status: "pending" | "running" | "done" | "failed"; attempts: number; result?: unknown; checkpoint?: unknown; by?: string; token?: number; error?: string }
export interface RolloutDoc {
  rollout: string;
  artifact: string;
  previous?: string;
  approval: Approval;
  steps: Record<string, StepState>;
  order: string[];
  lease: Lease | null;
  fence: number;
  activatedGrants: string[];
  state: "open" | "complete" | "rolled-back";
  _version?: number;
}

export class StaleController extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = "StaleController";
  }
}

export interface StepContext<C = unknown> {
  /** Last checkpoint recorded for this step (by any controller). */
  checkpoint: C | undefined;
  /** Durably record progress; throws StaleController if the lease was lost (the caller must stop). */
  save(checkpoint: C): Promise<void>;
}

export class DeploymentLedger {
  constructor(private readonly store: StructuredStore, private readonly scope = "_platform") {}

  private async load(rollout: string): Promise<RolloutDoc> {
    const d = (await Effect.runPromise(this.store.getDocument(this.scope, DEPLOY_KIND, rollout))) as RolloutDoc | null;
    if (!d) throw new Error(`rollout ${rollout} does not exist`);
    return d;
  }
  private async put(doc: RolloutDoc): Promise<RolloutDoc> {
    const { _version, ...rest } = doc;
    await Effect.runPromise(this.store.putDocument(this.scope, DEPLOY_KIND, doc.rollout, rest, _version ?? null));
    return { ...rest, _version: (_version ?? 0) + 1 };
  }

  /** Open a rollout: the approval must name the artifact being rolled out; blocked plans are refused. */
  async open(o: { rollout: string; artifact: string; previous?: string; plan: { steps: PlanStep[]; blocked?: boolean }; approval: Approval }): Promise<RolloutDoc> {
    if (o.approval.artifact !== o.artifact) throw new Error(`approval is bound to ${o.approval.artifact}, not ${o.artifact}: artifact-bound approval only`);
    if (o.plan.blocked) throw new Error("the migration plan is blocked; resolve the blocked steps before opening a rollout");
    const existing = (await Effect.runPromise(this.store.getDocument(this.scope, DEPLOY_KIND, o.rollout))) as RolloutDoc | null;
    if (existing) return existing; // idempotent open: resume
    const steps: Record<string, StepState> = {};
    for (const st of o.plan.steps) steps[st.id] = { status: "pending", attempts: 0 };
    const doc: RolloutDoc = { rollout: o.rollout, artifact: o.artifact, ...(o.previous ? { previous: o.previous } : {}), approval: o.approval, steps, order: o.plan.steps.map((s) => s.id), lease: null, fence: 0, activatedGrants: [], state: "open" };
    return this.put(doc);
  }

  /** Take the lease when it is free or expired. Returns the fencing token, or null when another controller holds it. */
  async acquire(rollout: string, controller: string, leaseMs: number, now = Date.now()): Promise<number | null> {
    const doc = await this.load(rollout);
    if (doc.lease && doc.lease.until > now && doc.lease.controller !== controller) return null;
    const token = doc.fence + 1;
    try {
      await this.put({ ...doc, fence: token, lease: { controller, token, until: now + leaseMs } });
    } catch {
      return null; // lost the race
    }
    return token;
  }

  async renew(rollout: string, controller: string, token: number, leaseMs: number, now = Date.now()): Promise<boolean> {
    const doc = await this.load(rollout);
    if (!doc.lease || doc.lease.token !== token || doc.lease.controller !== controller) return false;
    try {
      await this.put({ ...doc, lease: { controller, token, until: now + leaseMs } });
      return true;
    } catch {
      return false;
    }
  }

  private guard(doc: RolloutDoc, token: number, now: number): void {
    if (!doc.lease || doc.lease.token !== token) throw new StaleController(`fencing token ${token} is not the current lease (${doc.lease?.token ?? "none"}): this controller lost the rollout`);
    if (doc.lease.until <= now) throw new StaleController(`lease held by ${doc.lease.controller} expired at ${new Date(doc.lease.until).toISOString()}`);
  }

  /** Run one step under the lease. Done steps return their stored result without running; running steps resume from their checkpoint. */
  async run<R, C = unknown>(rollout: string, stepId: string, token: number, action: (ctx: StepContext<C>) => Promise<R>, now: () => number = () => Date.now()): Promise<{ result: R; skipped: boolean }> {
    let doc = await this.load(rollout);
    this.guard(doc, token, now());
    const st = doc.steps[stepId];
    if (!st) throw new Error(`unknown step ${stepId}`);
    if (st.status === "done") return { result: st.result as R, skipped: true };
    // every earlier step in the DAG must be done first
    for (const prev of doc.order) {
      if (prev === stepId) break;
      if (doc.steps[prev]!.status !== "done") throw new Error(`step ${stepId} needs ${prev} first`);
    }
    doc = await this.put({ ...doc, steps: { ...doc.steps, [stepId]: { ...st, status: "running", attempts: st.attempts + 1, by: doc.lease!.controller, token } } });
    const self = this;
    const ctx: StepContext<C> = {
      checkpoint: st.checkpoint as C | undefined,
      async save(checkpoint: C) {
        const cur = await self.load(rollout);
        self.guard(cur, token, now());
        doc = await self.put({ ...cur, steps: { ...cur.steps, [stepId]: { ...cur.steps[stepId]!, checkpoint } } });
      },
    };
    let result: R;
    try {
      result = await action(ctx);
    } catch (e) {
      if (e instanceof StaleController) throw e;
      const cur = await this.load(rollout);
      if (cur.lease?.token === token) await this.put({ ...cur, steps: { ...cur.steps, [stepId]: { ...cur.steps[stepId]!, status: "failed", error: String((e as Error).message ?? e) } } });
      throw e;
    }
    const cur = await this.load(rollout);
    this.guard(cur, token, now()); // completion is recorded only by the controller that still owns the rollout
    await this.put({ ...cur, steps: { ...cur.steps, [stepId]: { ...cur.steps[stepId]!, status: "done", result } } });
    return { result, skipped: false };
  }

  /** Grant activation is recorded once per rollout; a retry after a crash does not activate twice. */
  async activateGrantOnce(rollout: string, token: number, grant: string, activate: () => Promise<void>, now = Date.now()): Promise<boolean> {
    const doc = await this.load(rollout);
    this.guard(doc, token, now);
    if (doc.activatedGrants.includes(grant)) return false;
    await activate();
    const cur = await this.load(rollout);
    this.guard(cur, token, now);
    await this.put({ ...cur, activatedGrants: [...cur.activatedGrants, grant] });
    return true;
  }

  /**
   * Roll back to the previous artifact. Rollback re-activates nothing that the revocation authority
   * says is revoked, and never touches erased subjects: current revocations stay authoritative.
   */
  async rollback(rollout: string, token: number, o: { grants: string[]; authority: { revoked(grant: string): boolean }; activate: (grant: string) => Promise<void> }, now = Date.now()): Promise<{ reactivated: string[]; refused: { grant: string; reason: string }[] }> {
    const doc = await this.load(rollout);
    this.guard(doc, token, now);
    const reactivated: string[] = [];
    const refused: { grant: string; reason: string }[] = [];
    for (const g of o.grants) {
      if (o.authority.revoked(g)) {
        refused.push({ grant: g, reason: "revoked: rollback cannot restore authority the current revocation removed" });
        continue;
      }
      await o.activate(g);
      reactivated.push(g);
    }
    const cur = await this.load(rollout);
    this.guard(cur, token, now);
    await this.put({ ...cur, state: "rolled-back" });
    return { reactivated, refused };
  }

  async status(rollout: string): Promise<RolloutDoc> {
    return this.load(rollout);
  }

  async complete(rollout: string, token: number, now = Date.now()): Promise<void> {
    const doc = await this.load(rollout);
    this.guard(doc, token, now);
    const pending = doc.order.filter((id) => doc.steps[id]!.status !== "done");
    if (pending.length) throw new Error(`rollout has unfinished steps: ${pending.join(", ")}`);
    await this.put({ ...doc, state: "complete", lease: null });
  }
}
