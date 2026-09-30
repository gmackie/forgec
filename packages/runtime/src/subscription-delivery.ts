/** Durable inbox protocol. Document versions are fencing tokens, not just locks. */
import { Effect } from "effect";
import { encodeIdentity } from "./codecs.js";
import { err, ForgeError } from "./errors.js";
import type { DocumentWrite, StorageAdapter } from "./services.js";

const KIND = "subscription-delivery-v1";
const LEASE_MS = 60_000;

export class SubscriptionDelivery {
  private externalStarted = false;
  private externalIntent: Promise<void> | undefined;
  private constructor(
    private readonly storage: StorageAdapter,
    private readonly tenant: string,
    private readonly id: string,
    private version: number,
    private readonly state: Record<string, unknown>,
    private readonly now: () => number,
  ) {}

  static async claim(storage: StorageAdapter, tenant: string, subscription: string, messageId: string, requestHash: string, now: () => number): Promise<SubscriptionDelivery | null> {
    if (!storage.atomicCompletion) throw err("Internal", "storage adapter does not support atomic subscription completion");
    // Preserve the legacy ledger. Upgrade consumers together: old consumers still acknowledge early.
    if (await Effect.runPromise(storage.hasProcessed(tenant, subscription, messageId))) return null;
    const id = encodeIdentity([subscription, messageId]);
    const old = await Effect.runPromise(storage.getDocument(tenant, KIND, id));
    if (old && old["requestHash"] !== requestHash) throw err("IdempotencyMismatch", "message identity reused with different content");
    if (old?.["status"] === "complete") return null;
    if (old?.["status"] === "external") throw err("DeliveryOutcomeUnknown", "external effect may have occurred; reconcile this delivery before redrive");
    if (old?.["status"] === "running" && Number(old["leaseUntil"]) > now()) throw err("TransientConflict", "subscription delivery is already running");
    const version = old ? Number(old["_version"]) : null;
    const state = { status: "running", requestHash, subscription, messageId, leaseUntil: now() + LEASE_MS };
    try {
      await Effect.runPromise(storage.putDocument(tenant, KIND, id, state, version));
    } catch (e) {
      if ((e as {code?: string}).code === "VersionConflict") throw err("TransientConflict", "subscription claim changed concurrently");
      throw e;
    }
    return new SubscriptionDelivery(storage, tenant, id, (version ?? 0) + 1, state, now);
  }

  /** Persist intent BEFORE an external effect; expired ambiguous work is never replayed automatically. */
  beforeExternal() {
    return Effect.tryPromise({
      try: () => this.externalIntent ??= (async () => {
        if (this.now() >= Number(this.state["leaseUntil"])) throw err("TransientConflict", "subscription lease expired before external effect");
        await Effect.runPromise(this.storage.putDocument(this.tenant, KIND, this.id, { ...this.state, status: "external" }, this.version));
        this.version++;
        this.externalStarted = true;
      })(),
      catch: (e) => e instanceof ForgeError ? e : err("DeliveryOutcomeUnknown", "could not establish durable external-effect intent; reconcile delivery"),
    });
  }

  completion(): DocumentWrite {
    return { kind: KIND, id: this.id, expectedVersion: this.version, doc: { ...this.state, status: "complete" } };
  }

  async failed(): Promise<void> {
    if (this.externalStarted) throw err("DeliveryOutcomeUnknown", "external effect may have occurred; reconcile this delivery before redrive");
    // A lost commit response may already have completed the delivery. CAS cannot erase it,
    // nor release a newer worker's claim. Failure to release is recovered by lease expiry.
    await Effect.runPromise(this.storage.putDocument(this.tenant, KIND, this.id, { ...this.state, status: "ready" }, this.version)).catch(() => undefined);
  }
}
