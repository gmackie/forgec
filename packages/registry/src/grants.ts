/**
 * Callee-owned dependency grants (FORGE-062/065/066; PAR-132..139).
 *
 * A `uses` edge in a caller's IR becomes a signed *request* naming caller and
 * callee identities, the exact edges (function, purpose), the caller's
 * effects/security digests, environment/audience/scope, assurance, lifetime
 * and CI provenance. A request is never access. Access exists only when a
 * *grant* (published after independent review, see grant-publication.ts) has
 * been admitted here and *activated* for the deployed identity that calls.
 * Verification is exact and non-transitive: caller identity, callee id and
 * purpose must all match one activated, unexpired, unrevoked grant. Declared,
 * approved, activated and observed graphs are kept distinct. Retirement
 * drains; emergency revocation is a tombstone that activation cannot undo.
 */
import type { AppBundle, CallContext, ExternalBinding } from "@forgegraph/runtime";
import { canonical, digestOf, signBytes, verifyBytes, type Signer, type TrustPolicy } from "./artifacts.js";

export interface DependencyEdge { kind: "function" | "resource" | "transition"; callee: string; caller: string; purpose: string; capability?: string }
export interface CallerIdentity { package: string; version: string; identity: string; repo?: string; environment: string; audience: string; scope: string; digests: Record<string, string> }
export interface DependencyRequest {
  version: "dependency-request/1";
  digest: string;
  caller: CallerIdentity;
  callee: { package: string; version: string; lock?: string };
  edges: DependencyEdge[];
  assurance: "workload-bound" | "isolated-callable";
  lifetime: { expiresAt: string };
  provenance: { ci: string; commit: string; head: string };
  signature?: { keyId: string; signature: string };
}
export interface Approval { group: string; reviewer: string; at: string; head: string }
export interface DependencyGrant {
  version: "dependency-grant/1";
  digest: string;
  request: string;
  caller: CallerIdentity;
  callee: { package: string; version: string; lock?: string };
  edges: DependencyEdge[];
  assurance: DependencyRequest["assurance"];
  lifetime: { expiresAt: string };
  approvals: Approval[];
  repo: string;
  branch: string;
  head: string;
  mergeCommit: string;
  publishedAt: string;
  signature?: { keyId: string; signature: string };
}

const REQUEST_FIELDS = ["version", "caller", "callee", "edges", "assurance", "lifetime", "provenance"] as const;
const GRANT_FIELDS = ["version", "request", "caller", "callee", "edges", "assurance", "lifetime", "approvals", "repo", "branch", "head", "mergeCommit", "publishedAt"] as const;

/** Canonical projection of the known fields only: extra keys never reach a digest, a file or a reviewer. */
export function requestPayload(r: DependencyRequest): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of REQUEST_FIELDS) out[k] = r[k];
  return out;
}
export function grantPayload(g: DependencyGrant): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of GRANT_FIELDS) out[k] = g[k];
  return out;
}
export const requestDigest = (r: DependencyRequest) => digestOf(canonical(requestPayload(r)));
export const grantDigest = (g: DependencyGrant) => digestOf(canonical(grantPayload(g)));
const requestMaterial = (d: string) => `forge-dependency-request\n${d}`;
const grantMaterial = (d: string) => `forge-dependency-grant\n${d}`;

export interface RequestInput {
  bundle: AppBundle;
  callee: string;
  lock?: { name: string; version: string; hash: string };
  caller: { identity: string; repo?: string; environment: string; audience: string; scope: string };
  /** Purpose under which each callee function is used (edition 2027 purpose transition). */
  purposes: Record<string, string>;
  assurance: DependencyRequest["assurance"];
  lifetime: { expiresAt: string };
  provenance: { ci: string; commit: string; head: string };
}

/** Derive the request from the caller's IR: every `uses` edge that targets the callee package. */
export function requestFrom(i: RequestInput): DependencyRequest {
  const edges: DependencyEdge[] = [];
  const prefix = `${i.callee}/`;
  for (const m of i.bundle.ir.modules) {
    for (const f of m.functions) {
      for (const u of f.uses) {
        if (u.kind === "function" && u.function.startsWith(prefix)) edges.push({ kind: "function", callee: u.function, caller: f.id, purpose: i.purposes[u.function] ?? "unspecified" });
        if (u.kind === "resource" && u.resource.startsWith(prefix)) edges.push({ kind: "resource", callee: u.resource, caller: f.id, purpose: i.purposes[u.resource] ?? "unspecified", capability: u.capability });
        if (u.kind === "transition" && u.resource.startsWith(prefix)) edges.push({ kind: "transition", callee: `${u.resource}.${u.action}`, caller: f.id, purpose: i.purposes[u.resource] ?? "unspecified" });
      }
    }
  }
  edges.sort((a, b) => `${a.callee}|${a.caller}`.localeCompare(`${b.callee}|${b.caller}`));
  const r: DependencyRequest = {
    version: "dependency-request/1",
    digest: "",
    caller: { package: i.bundle.ir.package.name, version: i.bundle.ir.package.version, identity: i.caller.identity, ...(i.caller.repo ? { repo: i.caller.repo } : {}), environment: i.caller.environment, audience: i.caller.audience, scope: i.caller.scope, digests: { ...(i.bundle.digests ?? {}), buildHash: i.bundle.buildHash } },
    callee: { package: i.callee, version: i.lock?.version ?? "*", ...(i.lock ? { lock: i.lock.hash } : {}) },
    edges,
    assurance: i.assurance,
    lifetime: i.lifetime,
    provenance: i.provenance,
  };
  r.digest = requestDigest(r);
  return r;
}

export async function signRequest(r: DependencyRequest, signer: Signer): Promise<DependencyRequest> {
  const digest = requestDigest(r);
  return { ...r, digest, signature: { keyId: signer.keyId, signature: await signBytes(signer, requestMaterial(digest)) } };
}
export async function verifyRequest(r: DependencyRequest, trust: TrustPolicy): Promise<void> {
  if (r.version !== "dependency-request/1") throw new Error(`unknown request version ${String(r.version)}`);
  if (!r.signature) throw new Error("request is not signed");
  const jwk = trust.signers[r.signature.keyId];
  if (!jwk) throw new Error(`signer ${r.signature.keyId} is not trusted`);
  const digest = requestDigest(r);
  if (digest !== r.digest) throw new Error("request digest does not match its content");
  if (!(await verifyBytes(jwk, r.signature.signature, requestMaterial(digest)))) throw new Error("request signature does not verify");
}
export async function signGrant(g: DependencyGrant, signer: Signer): Promise<DependencyGrant> {
  const digest = grantDigest(g);
  return { ...g, digest, signature: { keyId: signer.keyId, signature: await signBytes(signer, grantMaterial(digest)) } };
}
export async function verifyGrant(g: DependencyGrant, trust: TrustPolicy): Promise<void> {
  if (g.version !== "dependency-grant/1") throw new Error(`unknown grant version ${String(g.version)}`);
  if (!g.signature) throw new Error("grant is not signed");
  const jwk = trust.signers[g.signature.keyId];
  if (!jwk) throw new Error(`signer ${g.signature.keyId} is not trusted`);
  const digest = grantDigest(g);
  if (digest !== g.digest) throw new Error("grant digest does not match its content: the signature covers different content");
  if (!(await verifyBytes(jwk, g.signature.signature, grantMaterial(digest)))) throw new Error("grant signature does not verify");
}

/** Security-relevant differences: a semver-compatible caller change can still require reapproval. */
export function compareRequests(before: DependencyRequest, after: DependencyRequest): { compatible: boolean; reasons: string[] } {
  const reasons: string[] = [];
  if (before.caller.digests["security"] !== after.caller.digests["security"]) reasons.push("security digest changed");
  for (const e of after.edges) {
    const prev = before.edges.find((x) => x.callee === e.callee && x.caller === e.caller);
    if (!prev) reasons.push(`edge added: ${e.callee}`);
    else if (prev.purpose !== e.purpose) reasons.push(`purpose changed on ${e.callee}`);
    else if (prev.capability !== e.capability) reasons.push(`capability changed on ${e.callee}`);
  }
  if (before.assurance === "isolated-callable" && after.assurance !== "isolated-callable") reasons.push("assurance lowered");
  if (before.caller.environment !== after.caller.environment) reasons.push("environment changed");
  if (before.caller.audience !== after.caller.audience) reasons.push("audience changed");
  if (before.caller.scope !== after.caller.scope) reasons.push("scope changed");
  return { compatible: reasons.length === 0, reasons };
}

// ---------------------------------------------------------------- runtime
export interface EdgeQuery { caller: string; callee: string; purpose: string; epoch: number; now?: number }
export interface EdgeVerdict { allowed: boolean; reason?: string; grant?: string }
interface Admitted {
  grant: DependencyGrant;
  activations: Map<string, { epoch: number; at: number }>;
  uses: { release: string; workflow: string; instances: number }[];
  retirement?: { state: "draining" | "retired"; drainUntil: string; requestedAt: string };
  revoked?: { at: string; reason: string; epoch: number; boundMs: number };
  lastObserved?: number;
}
type Edge = { caller: string; callee: string; purpose: string };

export class GrantRegistry {
  private admitted = new Map<string, Admitted>();
  private declared: Edge[] = [];
  private observed: Edge[] = [];
  /** Registry-wide epoch: emergency revocations bump it so cached allows anywhere die. */
  epoch = 1;
  constructor(private readonly o: { trust: TrustPolicy }) {}

  /** Record what a caller declares (from its request). Declaration is not approval. */
  declare(r: DependencyRequest): void {
    for (const e of r.edges) if (!this.declared.some((x) => x.caller === r.caller.identity && x.callee === e.callee && x.purpose === e.purpose)) this.declared.push({ caller: r.caller.identity, callee: e.callee, purpose: e.purpose });
  }

  /** Verified admission of a published grant. Admission is not activation. */
  async admit(g: DependencyGrant): Promise<void> {
    await verifyGrant(g, this.o.trust);
    const prev = this.admitted.get(g.digest);
    this.admitted.set(g.digest, { grant: g, activations: prev?.activations ?? new Map(), uses: prev?.uses ?? [], ...(prev?.retirement ? { retirement: prev.retirement } : {}), ...(prev?.revoked ? { revoked: prev.revoked } : {}) });
  }

  /** Bind an admitted grant to a deployed identity once the snapshot carrying it was acknowledged. */
  async activate(digest: string, a: { identity: string; epoch: number; snapshotAck: boolean }): Promise<void> {
    const g = this.admitted.get(digest);
    if (!g) throw new Error(`grant ${digest} is not admitted`);
    if (!a.snapshotAck) throw new Error("activation needs the acknowledged snapshot that distributes the grant");
    if (g.grant.caller.identity !== a.identity) throw new Error(`grant ${digest} is for ${g.grant.caller.identity}, not ${a.identity}`);
    g.activations.set(a.identity, { epoch: a.epoch, at: Date.now() });
    // a revocation is a tombstone: re-activation (rollback) never clears it
  }

  verify(q: EdgeQuery): EdgeVerdict {
    const now = q.now ?? Date.now();
    const forEdge = [...this.admitted.values()].filter((a) => a.grant.caller.identity === q.caller && a.grant.edges.some((e) => e.callee === q.callee));
    if (forEdge.length === 0) return { allowed: false, reason: `no activated grant authorizes ${q.caller} -> ${q.callee}` };
    const withPurpose = forEdge.filter((a) => a.grant.edges.some((e) => e.callee === q.callee && e.purpose === q.purpose));
    if (withPurpose.length === 0) return { allowed: false, reason: `purpose ${q.purpose} is not the approved purpose for ${q.caller} -> ${q.callee}` };
    for (const a of withPurpose) {
      const d = a.grant.digest;
      if (a.revoked) return { allowed: false, reason: `emergency-revoked at ${a.revoked.at} (${a.revoked.reason}); revoked grants stay revoked`, grant: d };
      const act = a.activations.get(q.caller);
      if (!act) return { allowed: false, reason: `grant ${d} is published but not activated for ${q.caller}`, grant: d };
      if (now > Date.parse(a.grant.lifetime.expiresAt)) return { allowed: false, reason: `grant ${d} expired at ${a.grant.lifetime.expiresAt}`, grant: d };
      if (a.retirement && now > Date.parse(a.retirement.drainUntil)) return { allowed: false, reason: `grant ${d} retired: the drain window ended at ${a.retirement.drainUntil}`, grant: d };
      if (q.epoch < act.epoch) return { allowed: false, reason: `caller epoch ${q.epoch} predates activation epoch ${act.epoch}`, grant: d };
      a.lastObserved = now;
      if (!this.observed.some((x) => x.caller === q.caller && x.callee === q.callee && x.purpose === q.purpose)) this.observed.push({ caller: q.caller, callee: q.callee, purpose: q.purpose });
      return { allowed: true, grant: d };
    }
    return { allowed: false, reason: "no applicable grant" };
  }

  /** Revocation authority for rollbacks: a tombstone is final. */
  isRevoked(digest: string): boolean {
    return Boolean(this.admitted.get(digest)?.revoked);
  }

  graphs(): { declared: Edge[]; approved: Edge[]; activated: Edge[]; observed: Edge[] } {
    const approved: Edge[] = [];
    const activated: Edge[] = [];
    for (const a of this.admitted.values()) {
      for (const e of a.grant.edges) {
        approved.push({ caller: a.grant.caller.identity, callee: e.callee, purpose: e.purpose });
        if (a.activations.has(a.grant.caller.identity) && !a.revoked) activated.push({ caller: a.grant.caller.identity, callee: e.callee, purpose: e.purpose });
      }
    }
    const sort = (xs: Edge[]) => xs.sort((x, y) => `${x.caller}|${x.callee}|${x.purpose}`.localeCompare(`${y.caller}|${y.callee}|${y.purpose}`));
    return { declared: sort([...this.declared]), approved: sort(approved), activated: sort(activated), observed: sort([...this.observed]) };
  }

  // ---------------------------------------------------------- lifecycle
  observeUse(digest: string, u: { release: string; workflow: string; instances: number }): void {
    const a = this.admitted.get(digest);
    if (!a) throw new Error(`grant ${digest} is not admitted`);
    const i = a.uses.findIndex((x) => x.release === u.release && x.workflow === u.workflow);
    if (i >= 0) a.uses[i] = u;
    else a.uses.push(u);
  }

  /** Planned retirement. Releases still using the grant get the declared drain; shortening it later is a policy decision, not a source change. */
  retire(digest: string, r: { drainUntil: string; requestedAt: string }): { state: "draining" | "retired"; drainUntil: string; inUseBy: Admitted["uses"]; note?: string } {
    const a = this.admitted.get(digest);
    if (!a) throw new Error(`grant ${digest} is not admitted`);
    const inUseBy = a.uses.filter((u) => u.instances > 0);
    if (a.retirement) return { state: a.retirement.state, drainUntil: a.retirement.drainUntil, inUseBy, note: `already ${a.retirement.state} until ${a.retirement.drainUntil}; shortening a declared drain is a policy decision (use emergencyRevoke for an incident)` };
    a.retirement = { state: inUseBy.length ? "draining" : "retired", drainUntil: inUseBy.length ? r.drainUntil : r.requestedAt, requestedAt: r.requestedAt };
    return { state: a.retirement.state, drainUntil: a.retirement.drainUntil, inUseBy };
  }

  /** Immediate, bounded, irreversible by rollback. Bumps the registry epoch so cached decisions die within the bound. */
  emergencyRevoke(digest: string, r: { reason: string; at: string; boundMs: number }): { epoch: number; at: string; boundMs: number } {
    const a = this.admitted.get(digest);
    if (!a) throw new Error(`grant ${digest} is not admitted`);
    this.epoch += 1;
    a.revoked = { at: r.at, reason: r.reason, epoch: this.epoch, boundMs: r.boundMs };
    return { epoch: this.epoch, at: r.at, boundMs: r.boundMs };
  }

  /** Suggest grants with no observed use in the window; a suggestion, never an automatic removal, and only as good as telemetry coverage. */
  reviewUnused(o: { now: number; sinceMs: number; telemetryCoverage: number }): { suggestions: { grant: string; caller: string; callee: string[]; lastObserved?: string }[]; telemetryCoverage: number; automatic: false; note: string } {
    const suggestions: { grant: string; caller: string; callee: string[]; lastObserved?: string }[] = [];
    for (const a of this.admitted.values()) {
      if (a.revoked || a.retirement) continue;
      if (a.lastObserved === undefined || o.now - a.lastObserved > o.sinceMs) suggestions.push({ grant: a.grant.digest, caller: a.grant.caller.identity, callee: a.grant.edges.map((e) => e.callee), ...(a.lastObserved !== undefined ? { lastObserved: new Date(a.lastObserved).toISOString() } : {}) });
    }
    return { suggestions, telemetryCoverage: o.telemetryCoverage, automatic: false, note: o.telemetryCoverage < 1 ? `telemetry covers ${Math.round(o.telemetryCoverage * 100)}% of calls: absence of observed use is not proof of no use` : "full telemetry coverage" };
  }

  /** Test helper: a synthetic signed grant for an edge (no review evidence; admitted only where the signer is trusted). */
  async testGrant(e: Edge, signer: Signer): Promise<DependencyGrant> {
    const g: DependencyGrant = { version: "dependency-grant/1", digest: "", request: "test", caller: { package: e.caller, version: "0", identity: e.caller, environment: "test", audience: "test", scope: "test", digests: {} }, callee: { package: e.callee.slice(0, e.callee.indexOf("/_/")), version: "0" }, edges: [{ kind: "function", callee: e.callee, caller: e.caller, purpose: e.purpose }], assurance: "workload-bound", lifetime: { expiresAt: "2099-01-01T00:00:00Z" }, approvals: [], repo: "test", branch: "main", head: "test", mergeCommit: "test", publishedAt: "2026-01-01T00:00:00Z" };
    return signGrant(g, signer);
  }
}

/** Wrap external bindings so every cross-service call is verified against activated grants before the adapter runs. */
export function guardExternals(externals: Record<string, ExternalBinding>, grants: GrantRegistry, o: { identity: string; epoch: () => number }): Record<string, ExternalBinding> {
  const out: Record<string, ExternalBinding> = {};
  for (const [id, binding] of Object.entries(externals)) {
    out[id] = async (input: unknown, ctx: CallContext) => {
      const v = grants.verify({ caller: o.identity, callee: id, purpose: ctx.purpose ?? "unspecified", epoch: o.epoch() });
      if (!v.allowed) return { ok: false, code: "NotPermitted", detail: v.reason ?? "no grant" };
      return binding(input, ctx);
    };
  }
  return out;
}
