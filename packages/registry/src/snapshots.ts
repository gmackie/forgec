/**
 * Signed catalog/policy snapshots (FORGE-061; PAR-130). The registry
 * publishes versioned full and incremental snapshots (policies, catalog
 * membership, revocations) with an expiry; a runtime holds one, verifies it
 * against its trust policy, acknowledges activation, and decides from it
 * without any request-time registry lookup. Expiry follows the configured
 * rule: `deny` (after an optional grace window) or `degrade-readonly`
 * (reads only, bounded by `maxDegradedMs`). Neither rule can leave stale
 * permission in place indefinitely, and the reported epoch rises past the
 * snapshot's so cached allows die with it.
 */
import { Effect } from "effect";
import type { Authorizer, AuthzRequest, Decision, Policy } from "@forge/runtime";
import { canonical, signBytes, verifyBytes, type Signer, type TrustPolicy } from "./artifacts.js";

export interface SnapshotPayload {
  version: "snapshot/1";
  kind: "full" | "incremental";
  authority: string;
  epoch: number;
  base?: number;
  issuedAt: string;
  expiresAt: string;
  policies?: Policy[];
  catalog?: { packages: string[] };
  revoke?: string[];
}
export interface Snapshot { payload: SnapshotPayload; signature: { keyId: string; signature: string } }
export interface Activation { epoch: number; kind: "full" | "incremental"; accepted: boolean; reason?: string; at: string }
export interface HeldState { epoch: number; expiresAt: string; policies: Policy[]; catalog: { packages: string[] } }

const material = (p: SnapshotPayload) => `forge-snapshot\n${p.authority}\n${canonical(p)}`;

export class SnapshotPublisher {
  constructor(private readonly o: { authority: string; signer: Signer }) {}
  private async sign(payload: SnapshotPayload): Promise<Snapshot> {
    return { payload, signature: { keyId: this.o.signer.keyId, signature: await signBytes(this.o.signer, material(payload)) } };
  }
  full(p: { epoch: number; base?: number; issuedAt: string; expiresAt: string; policies: Policy[]; catalog: { packages: string[] } }): Promise<Snapshot> {
    return this.sign({ version: "snapshot/1", kind: "full", authority: this.o.authority, epoch: p.epoch, ...(p.base !== undefined ? { base: p.base } : {}), issuedAt: p.issuedAt, expiresAt: p.expiresAt, policies: p.policies, catalog: p.catalog });
  }
  incremental(p: { epoch: number; base: number; issuedAt: string; expiresAt: string; policies?: Policy[]; revoke?: string[] }): Promise<Snapshot> {
    return this.sign({ version: "snapshot/1", kind: "incremental", authority: this.o.authority, epoch: p.epoch, base: p.base, issuedAt: p.issuedAt, expiresAt: p.expiresAt, ...(p.policies ? { policies: p.policies } : {}), ...(p.revoke ? { revoke: p.revoke } : {}) });
  }
}

export type ExpiryRule = "deny" | "degrade-readonly";

export class SnapshotHolder {
  private held: HeldState | null = null;
  readonly acks: Activation[] = [];
  constructor(private readonly o: { trust: TrustPolicy; onExpiry: ExpiryRule; graceMs?: number; maxDegradedMs?: number }) {}

  current(): HeldState | null {
    return this.held;
  }

  async activate(s: Snapshot): Promise<Activation> {
    const p = s.payload;
    const at = new Date().toISOString();
    const refuse = (reason: string): Activation => { const a = { epoch: p.epoch, kind: p.kind, accepted: false, reason, at }; this.acks.push(a); return a; };
    if (p.version !== "snapshot/1") return refuse(`unknown snapshot version ${String(p.version)}`);
    if (p.authority !== this.o.trust.authority) return refuse(`snapshot authority ${p.authority} is not ${this.o.trust.authority}`);
    const jwk = this.o.trust.signers[s.signature.keyId];
    if (!jwk) return refuse(`signer ${s.signature.keyId} is not trusted`);
    if (!(await verifyBytes(jwk, s.signature.signature, material(p)))) return refuse("signature does not verify (payload altered or key mismatch)");
    if (this.held && p.epoch <= this.held.epoch) return refuse(`epoch ${p.epoch} is older than or equal to the active epoch ${this.held.epoch}`);
    if (p.kind === "incremental") {
      if (!this.held) return refuse("an incremental snapshot needs an active base");
      if (p.base !== this.held.epoch) return refuse(`base epoch ${String(p.base)} is not the active epoch ${this.held.epoch}`);
      const packages = this.held.catalog.packages.filter((x) => !(p.revoke ?? []).includes(x));
      this.held = { epoch: p.epoch, expiresAt: p.expiresAt, policies: p.policies ?? this.held.policies, catalog: { packages } };
    } else {
      this.held = { epoch: p.epoch, expiresAt: p.expiresAt, policies: p.policies ?? [], catalog: p.catalog ?? { packages: [] } };
    }
    const a: Activation = { epoch: p.epoch, kind: p.kind, accepted: true, at };
    this.acks.push(a);
    return a;
  }

  state(now = Date.now()): { status: "none" | "valid" | "grace" | "degraded" | "expired"; epoch: number; expiresAt: string } {
    if (!this.held) return { status: "none", epoch: 0, expiresAt: "" };
    const exp = Date.parse(this.held.expiresAt);
    const base = { epoch: this.held.epoch, expiresAt: this.held.expiresAt };
    if (now <= exp) return { status: "valid", ...base };
    if (now <= exp + (this.o.graceMs ?? 0)) return { status: "grace", ...base };
    if (this.o.onExpiry === "degrade-readonly" && now <= exp + (this.o.graceMs ?? 0) + (this.o.maxDegradedMs ?? 0)) return { status: "degraded", ...base };
    return { status: "expired", ...base };
  }

  /** Effective epoch: the snapshot's while it holds; past expiry it keeps rising every minute so nothing cached survives. */
  epochAt(now = Date.now()): number {
    const s = this.state(now);
    if (!this.held || s.status === "valid" || s.status === "grace") return s.epoch;
    return s.epoch + 1 + Math.floor((now - Date.parse(this.held.expiresAt)) / 60_000);
  }
}

/** Wrap an authorizer so its authority is bounded by the held snapshot and the expiry rule. */
export function withSnapshotAuthority(inner: Authorizer, holder: SnapshotHolder, clock: () => number = () => Date.now()): Authorizer {
  const deny = (req: AuthzRequest, reason: string): Decision => ({ effect: "deny", decisionId: crypto.randomUUID(), obligations: [], epoch: holder.epochAt(clock()), expiresAt: new Date(clock() + 1000).toISOString(), reason });
  return {
    get epoch() {
      return holder.epochAt(clock());
    },
    get knownObligations() {
      return inner.knownObligations;
    },
    ...(inner.pips ? { pips: inner.pips } : {}),
    requirements: (a, p) => inner.requirements(a, p),
    rowFilterFor: (a, p, attrs) => inner.rowFilterFor(a, p, attrs),
    decide(req) {
      const now = clock();
      const s = holder.state(now);
      const annotate = (suffix: string) => inner.decide(req).pipe(Effect.map((d) => ({ ...d, epoch: holder.epochAt(now), reason: `${d.reason ? d.reason + "; " : ""}${suffix}` })));
      switch (s.status) {
        case "none":
          return Effect.succeed(deny(req, "no activated snapshot: required authority is absent"));
        case "valid":
          return inner.decide(req).pipe(Effect.map((d) => ({ ...d, epoch: holder.epochAt(now) })));
        case "grace":
          return annotate(`grace: snapshot epoch ${s.epoch} expired at ${s.expiresAt}, within the grace window`);
        case "degraded":
          if (req.kind === "read") return annotate(`degraded: snapshot epoch ${s.epoch} expired at ${s.expiresAt}; reads only`);
          return Effect.succeed(deny(req, `degraded: snapshot epoch ${s.epoch} expired at ${s.expiresAt}; writes are denied until a fresh snapshot is activated`));
        case "expired":
          return Effect.succeed(deny(req, `required authority expired: snapshot epoch ${s.epoch} expired at ${s.expiresAt} and no newer snapshot was activated`));
      }
    },
  };
}
