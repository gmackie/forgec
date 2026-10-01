/** Journaled single-ref publication. Unknown dispatch outcomes are never replayed. */
import type { CallContext } from "./engine.js";
import { err } from "./errors.js";
import type {
  ArtifactCommit,
  ArtifactObjectFormat,
  ArtifactRevisionPin,
} from "./versioned-artifacts.js";

export interface ArtifactPublicationRepository {
  readonly repositoryId: string;
  readonly objectFormat: ArtifactObjectFormat;
  commit(oid: string): Promise<ArtifactCommit | null>;
  head(ref: string): Promise<string | null>;
  /** Must atomically compare the exact old OID (null = absent). Throw on ambiguity. */
  compareAndSwap(
    ref: string,
    expected: string | null,
    next: string,
  ): Promise<"accepted" | "rejected">;
  dispose(): void;
}
export interface ArtifactPublicationProvider {
  open(): Promise<ArtifactPublicationRepository>;
}
export interface ArtifactPublicationBinding {
  readonly tenant: string;
  readonly artifact: string;
  readonly generation: string;
  readonly repositoryId: string;
  readonly provider: ArtifactPublicationProvider;
}
export interface ArtifactPublicationRequest {
  readonly key: string;
  readonly ref: string;
  readonly expected: string | null;
  readonly revision: ArtifactRevisionPin;
}
export interface ArtifactPublicationIntent extends ArtifactPublicationRequest {
  readonly actor: string;
  readonly purpose: string | null;
}
export interface ArtifactPublicationReceipt {
  readonly intent: ArtifactPublicationIntent;
  /** observed means desired head was seen, not that this request caused it. */
  readonly outcome: "pending" | "accepted" | "rejected" | "observed";
}
export interface ArtifactPublicationJournal {
  /** Durable atomic insert-if-absent; exactly one contender owns dispatch. */
  claim(
    intent: ArtifactPublicationIntent,
  ): Promise<{ owned: boolean; receipt: ArtifactPublicationReceipt }>;
  get(
    intent: ArtifactPublicationIntent,
  ): Promise<ArtifactPublicationReceipt | null>;
  /** Conditional pending -> terminal; must never overwrite a terminal receipt. */
  finish(
    intent: ArtifactPublicationIntent,
    outcome: Exclude<ArtifactPublicationReceipt["outcome"], "pending">,
  ): Promise<ArtifactPublicationReceipt>;
}
export interface ArtifactPublicationAuthorization {
  readonly action: "publish" | "recover";
  readonly tenant: string;
  readonly artifact: string;
  readonly generation: string;
  readonly actor: string;
  readonly purpose?: string;
  readonly ref: string;
  readonly expected: string | null;
  readonly revision: Readonly<ArtifactRevisionPin>;
}
const identity = (v: unknown): v is string =>
  typeof v === "string" &&
  v.length > 0 &&
  v.length <= 1024 &&
  !/[\x00-\x1f\x7f]/.test(v);
const oid = (v: unknown, f: ArtifactObjectFormat) =>
  typeof v === "string" &&
  (f === "sha1" ? /^[a-f0-9]{40}$/ : /^[a-f0-9]{64}$/).test(v);
export function validArtifactBranch(ref: unknown): ref is string {
  return (
    identity(ref) &&
    ref.startsWith("refs/heads/") &&
    !/[ ~^:?*\[\\]/.test(ref) &&
    !ref.includes("..") &&
    !ref.includes("@{") &&
    !ref.endsWith(".") &&
    ref
      .split("/")
      .every((p) => p.length > 0 && !p.startsWith(".") && !p.endsWith(".lock"))
  );
}
/** Canonical intent encoding also scopes replay to actor and authorization purpose. */
export function artifactPublicationIntentKey(
  i: ArtifactPublicationIntent,
): string {
  const p = i.revision;
  return JSON.stringify([
    i.key,
    i.ref,
    i.expected,
    i.actor,
    i.purpose,
    p.tenant,
    p.artifact,
    p.generation,
    p.repositoryId,
    p.objectFormat,
    p.oid,
    p.tree,
  ]);
}
async function storage<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch {
    throw err(
      "StorageUnavailable",
      "Artifact publication journal is unavailable",
    );
  }
}
async function provider<T>(work: () => Promise<T> | T): Promise<T> {
  try {
    return await work();
  } catch {
    throw err(
      "DependencyUnavailable",
      "Artifact publication provider is unavailable",
    );
  }
}

export class ArtifactPublisher {
  private readonly bindings = new Map<
    string,
    Readonly<ArtifactPublicationBinding>
  >();
  constructor(
    bindings: readonly ArtifactPublicationBinding[],
    private readonly journal: ArtifactPublicationJournal,
    private readonly authorize: (
      request: Readonly<ArtifactPublicationAuthorization>,
    ) => Promise<boolean>,
  ) {
    for (const b of bindings) {
      const key = JSON.stringify([b.tenant, b.artifact]);
      if (
        ![b.tenant, b.artifact, b.generation, b.repositoryId].every(identity) ||
        this.bindings.has(key)
      )
        throw err("ValidationFailed", "Invalid artifact publication binding");
      this.bindings.set(key, Object.freeze({ ...b }));
    }
  }
  publish(request: ArtifactPublicationRequest, context: CallContext) {
    return this.run(request, context, "publish");
  }
  /** Read-only provider reconciliation. Never retries a dispatch or claims a new key. */
  recover(request: ArtifactPublicationRequest, context: CallContext) {
    return this.run(request, context, "recover");
  }
  private async run(
    request: ArtifactPublicationRequest,
    context: CallContext,
    action: "publish" | "recover",
  ): Promise<ArtifactPublicationReceipt> {
    const ctx = Object.freeze({ ...context }),
      pin = Object.freeze({ ...request.revision });
    const intent = Object.freeze({
      key: request.key,
      ref: request.ref,
      expected: request.expected,
      revision: pin,
      actor: ctx.actor,
      purpose: ctx.purpose ?? null,
    });
    if (
      !identity(ctx.tenant) ||
      !identity(ctx.actor) ||
      pin.tenant !== ctx.tenant
    )
      throw err("NotPermitted", "Artifact publication is not permitted");
    const binding = this.bindings.get(
      JSON.stringify([ctx.tenant, pin.artifact]),
    );
    if (!binding)
      throw err("NotPermitted", "Artifact publication is not permitted");
    if (
      !identity(intent.key) ||
      !validArtifactBranch(intent.ref) ||
      !["sha1", "sha256"].includes(pin.objectFormat) ||
      !oid(pin.oid, pin.objectFormat) ||
      !oid(pin.tree, pin.objectFormat) ||
      (intent.expected !== null && !oid(intent.expected, pin.objectFormat))
    )
      throw err("ValidationFailed", "Invalid artifact publication intent");
    let allowed = false;
    try {
      allowed = await this.authorize(
        Object.freeze({
          action,
          tenant: ctx.tenant,
          actor: ctx.actor,
          artifact: pin.artifact,
          generation: binding.generation,
          ref: intent.ref,
          expected: intent.expected,
          revision: pin,
          ...(ctx.purpose === undefined ? {} : { purpose: ctx.purpose }),
        }),
      );
    } catch {
      /* fail closed */
    }
    if (allowed !== true)
      throw err("NotPermitted", "Artifact publication is not permitted");
    if (
      pin.generation !== binding.generation ||
      pin.repositoryId !== binding.repositoryId
    )
      throw err("VersionConflict", "Artifact publication binding changed");
    const repo = await provider(() => binding.provider.open());
    try {
      if (
        repo.repositoryId !== binding.repositoryId ||
        repo.objectFormat !== pin.objectFormat
      )
        throw err("VersionConflict", "Artifact repository identity changed");
      const check = (receipt: ArtifactPublicationReceipt) => {
        if (
          artifactPublicationIntentKey(receipt.intent) !==
          artifactPublicationIntentKey(intent)
        )
          throw err(
            "IdempotencyMismatch",
            "Artifact publication key has a different intent",
          );
        return Object.freeze({ ...receipt, intent });
      };
      const existing = await storage(() => this.journal.get(intent));
      if (existing) {
        const receipt = check(existing);
        if (action === "publish" || receipt.outcome !== "pending")
          return receipt;
        const head = await provider(() => repo.head(intent.ref));
        if (head !== null && !oid(head, pin.objectFormat))
          throw err("ValidationFailed", "Invalid artifact provider head");
        return head === pin.oid
          ? check(await storage(() => this.journal.finish(intent, "observed")))
          : receipt;
      }
      if (action === "recover")
        throw err("NotFound", "Artifact publication receipt is unavailable");
      const commit = await provider(() => repo.commit(pin.oid));
      if (!commit || commit.oid !== pin.oid || commit.tree !== pin.tree)
        throw err(
          "ValidationFailed",
          "Artifact publication commit does not match the pin",
        );
      const claim = await storage(() => this.journal.claim(intent));
      const receipt = check(claim.receipt);
      if (!claim.owned || receipt.outcome !== "pending") return receipt;
      let outcome: "accepted" | "rejected";
      try {
        outcome = await repo.compareAndSwap(
          intent.ref,
          intent.expected,
          pin.oid,
        );
        if (outcome !== "accepted" && outcome !== "rejected") return receipt;
      } catch {
        return receipt;
      }
      // If persistence fails, pending survives for read-only reconciliation.
      return check(await storage(() => this.journal.finish(intent, outcome)));
    } finally {
      await provider(() => repo.dispose());
    }
  }
}
