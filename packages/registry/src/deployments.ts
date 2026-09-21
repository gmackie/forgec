/**
 * Deployment inventory and contract verification (FORGE-060; PAR-128/131).
 *
 * Two kinds of facts, never merged: a *report* is a descriptor signed by a
 * trusted release key (a claim that a deployment implements an artifact); an
 * *observation* is what a probe saw at the endpoint's discovery document.
 * Publication is neither. Reports age: past `staleAfterMs` they are visibly
 * stale and no longer count as implementers. Endpoints are checked against
 * the same private/metadata host rules as the OpenAPI importer plus an
 * allow-list. A remote binding is only issued for an endpoint with a fresh,
 * signed report whose digests match the caller's expectation.
 */
import { httpCallable, type Callable, type Credential } from "@forgegraph/interfaces/rpc";
import { canonical, signBytes, verifyBytes, type Signer, type TrustPolicy } from "./artifacts.js";

export interface Descriptor {
  deployment: string;
  endpoint: string;
  artifact: string;
  buildHash: string;
  digests: Record<string, string>;
  contracts: string;
  /** ISO time the report was produced by the release pipeline. */
  at: string;
}
export interface Observation { kind: "observed"; at: string; buildHash?: string; digests?: Record<string, string>; contracts?: string; match: boolean; error?: string }
export interface InventoryEntry {
  deployment: string;
  endpoint: string;
  descriptor: Descriptor;
  signedBy: string;
  signature: string;
  state: "reported" | "retired";
  retiredAt?: string;
  stale: boolean;
  observed?: Observation;
}

const IPV4 = /^\d+(\.\d+){0,3}$/;
function ipv4Private(host: string): boolean {
  const parts = host.split(".").map(Number);
  let value = 0;
  if (parts.length === 1) value = parts[0]!;
  else if (parts.length === 2) value = (parts[0]! << 24) | parts[1]!;
  else if (parts.length === 3) value = (parts[0]! << 24) | (parts[1]! << 16) | parts[2]!;
  else value = (parts[0]! << 24) | (parts[1]! << 16) | (parts[2]! << 8) | parts[3]!;
  const a = (value >>> 24) & 255, b = (value >>> 16) & 255;
  return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
}

/** Same rules as `forgec import-openapi`: no private/metadata/loopback hosts, no literal IPs, allow-listed names only. */
export function checkEndpoint(url: string, allow: string[], allowLoopbackForTests = false): string {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new Error(`${url}: not an absolute URL`);
  }
  const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (allowLoopbackForTests && (host === "127.0.0.1" || host === "localhost")) return host;
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".internal") || host.endsWith(".local") || host === "metadata") throw new Error(`${url}: private/metadata host is forbidden`);
  if (IPV4.test(host)) {
    if (ipv4Private(host)) throw new Error(`${url}: private address is forbidden`);
    throw new Error(`${url}: literal IP addresses are forbidden`);
  }
  if (host.includes(":")) throw new Error(`${url}: literal IP addresses are forbidden`);
  if (allow.length && !allow.some((a) => a.toLowerCase() === host || (a.startsWith(".") && host.endsWith(a.toLowerCase())))) throw new Error(`${url}: host ${host} is not in the allowed host list`);
  return host;
}

export class Inventory {
  private entries = new Map<string, Omit<InventoryEntry, "stale">>();
  constructor(private readonly o: { authority: string; trust: TrustPolicy; staleAfterMs: number; allowHosts: string[]; allowLoopbackForTests?: boolean; fetch?: typeof fetch }) {}

  private material(kind: string, payload: unknown): string {
    return `forge-deployment\n${this.o.authority}\n${kind}\n${canonical(payload)}`;
  }
  private async verified(kind: string, payload: unknown, keyId: string, signature: string): Promise<void> {
    const jwk = this.o.trust.signers[keyId];
    if (!jwk) throw new Error(`signer ${keyId} is not trusted by ${this.o.authority}`);
    if (!(await verifyBytes(jwk, signature, this.material(kind, payload)))) throw new Error(`signature by ${keyId} does not verify`);
  }

  /** A signed claim from the release pipeline. Returns the stored entry. */
  async report(d: Descriptor, signer: Signer): Promise<{ signedBy: string; signature: string }> {
    checkEndpoint(d.endpoint, this.o.allowHosts, this.o.allowLoopbackForTests);
    const signature = await signBytes(signer, this.material("report", d));
    await this.verified("report", d, signer.keyId, signature);
    this.entries.set(d.deployment, { deployment: d.deployment, endpoint: d.endpoint, descriptor: d, signedBy: signer.keyId, signature, state: "reported" });
    return { signedBy: signer.keyId, signature };
  }

  async retire(r: { deployment: string; at: string }, signer: Signer): Promise<void> {
    const signature = await signBytes(signer, this.material("retire", r));
    await this.verified("retire", r, signer.keyId, signature);
    const e = this.entries.get(r.deployment);
    if (!e) throw new Error(`unknown deployment ${r.deployment}`);
    this.entries.set(r.deployment, { ...e, state: "retired", retiredAt: r.at });
  }

  private stale(e: Omit<InventoryEntry, "stale">, now: number): boolean {
    return now - Date.parse(e.descriptor.at) > this.o.staleAfterMs;
  }

  list(now = Date.now()): InventoryEntry[] {
    return [...this.entries.values()].sort((a, b) => a.deployment.localeCompare(b.deployment)).map((e) => ({ ...e, stale: this.stale(e, now) }));
  }

  /** Deployments with a fresh, unretired, signed report for the artifact. Publication alone never appears here. */
  implementers(artifact: string, now = Date.now()): InventoryEntry[] {
    return this.list(now).filter((e) => e.state === "reported" && !e.stale && e.descriptor.artifact === artifact);
  }

  /** Probe the endpoint's discovery document; recorded as an observation, never promoted to a claim. */
  async observe(deployment: string, o: { credential: Credential }): Promise<Observation> {
    const e = this.entries.get(deployment);
    if (!e) throw new Error(`unknown deployment ${deployment}`);
    checkEndpoint(e.endpoint, this.o.allowHosts, this.o.allowLoopbackForTests);
    const f = this.o.fetch ?? fetch;
    const headers = o.credential.kind === "bearer" ? { authorization: `Bearer ${o.credential.token}` } : { "x-forge-tenant": o.credential.tenant, "x-forge-actor": o.credential.actor };
    let obs: Observation;
    try {
      const res = await f(`${e.endpoint.replace(/\/$/, "")}/forge/discovery`, { headers });
      if (!res.ok) obs = { kind: "observed", at: new Date().toISOString(), match: false, error: `discovery answered ${res.status}` };
      else {
        const d = (await res.json()) as { buildHash?: string; digests?: Record<string, string>; contracts?: { version?: string } };
        const match = d.buildHash === e.descriptor.buildHash && d.digests?.["wire"] === e.descriptor.digests["wire"];
        obs = { kind: "observed", at: new Date().toISOString(), match, ...(d.buildHash ? { buildHash: d.buildHash } : {}), ...(d.digests ? { digests: d.digests } : {}), ...(d.contracts?.version ? { contracts: d.contracts.version } : {}) };
      }
    } catch (err) {
      obs = { kind: "observed", at: new Date().toISOString(), match: false, error: String((err as Error).message ?? err) };
    }
    this.entries.set(deployment, { ...e, observed: obs });
    return obs;
  }

  /**
   * PAR-131: a binding needs a trusted deployment for *this* endpoint whose signed digests match the
   * expectation and whose report is fresh. A schema hash the endpoint advertises about itself is not trust.
   */
  async bindingFor(o: { endpoint: string; digests: Record<string, string>; credential: Credential; now?: number }): Promise<{ kind: "bound"; deployment: string; callable: Callable } | { kind: "refused"; reason: string }> {
    const now = o.now ?? Date.now();
    const target = o.endpoint.replace(/\/$/, "");
    const candidates = this.list(now).filter((e) => e.endpoint.replace(/\/$/, "") === target);
    if (candidates.length === 0) return { kind: "refused", reason: `no signed deployment report names ${target}; an advertised schema is not a trusted deployment` };
    const live = candidates.filter((e) => e.state === "reported");
    if (live.length === 0) return { kind: "refused", reason: `every report for ${target} is retired` };
    const fresh = live.filter((e) => !e.stale);
    if (fresh.length === 0) return { kind: "refused", reason: `the report for ${target} is stale (older than ${this.o.staleAfterMs}ms); refresh it before binding` };
    const match = fresh.find((e) => e.descriptor.digests["wire"] === o.digests["wire"]);
    if (!match) return { kind: "refused", reason: `the signed report for ${target} names different contract digests than expected` };
    return { kind: "bound", deployment: match.deployment, callable: httpCallable({ baseUrl: target, credential: o.credential, expect: { wire: match.descriptor.digests["wire"]!, buildHash: match.descriptor.buildHash } }) };
  }
}
