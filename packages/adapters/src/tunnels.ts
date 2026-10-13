/** Cloudflare-first desired tunnel configuration; no API calls or connector startup. */
import type { DeploymentPlan, ResourceSpec } from "./deployment-plan.js";
export interface TunnelTokenRef {
  source: "external-secret-store";
  /** Secret-store location, never the token value. */
  path: string;
}
export interface TunnelIngress {
  /** Exact DNS hostname; no wildcard or path matching. */
  hostname: string;
  /** HTTP(S) origin without credentials, query, fragment or non-root path. */
  service: string;
}
export type CloudflareTunnelSpec = {
  name: string;
  ingress: TunnelIngress[];
  connector: { tokenRef: TunnelTokenRef };
  retain?: boolean;
} & ({ ownership: "managed"; adoptId?: never } | { ownership: "adopted"; adoptId: string });
export interface CloudflareTunnelProjection {
  id: string; name: string; ownership: "managed" | "adopted"; retain: boolean;
  tunnelId?: string;
  create?: { name: string; config_src: "cloudflare" };
  config: { ingress: (TunnelIngress | { service: "http_status:404" })[] };
  connector: { executable: "cloudflared"; args: string[]; credential: TunnelTokenRef & { file: string; mode: "0600" } };
}
function validate(specs: CloudflareTunnelSpec[]): CloudflareTunnelSpec[] {
  const names = new Set<string>(), hosts = new Set<string>(), adoptedIds = new Set<string>();
  return specs.map(spec => {
    if (!/^[a-z][a-z0-9-]{0,62}$/.test(spec.name)) throw new Error("tunnel name must be a lowercase DNS-style identifier");
    if (names.has(spec.name)) throw new Error("duplicate tunnel name");
    names.add(spec.name);
    if (spec.ownership !== "managed" && spec.ownership !== "adopted") throw new Error("invalid tunnel ownership");
    if (spec.ownership === "adopted" && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(spec.adoptId)) throw new Error("adopted tunnel requires a UUID adoptId");
    if (spec.ownership === "adopted") {
      const id = spec.adoptId.toLowerCase();
      if (adoptedIds.has(id)) throw new Error("duplicate tunnel adoptId");
      adoptedIds.add(id);
    }
    if (spec.ownership === "managed" && spec.adoptId !== undefined) throw new Error("managed tunnel cannot have an adoptId");
    const ref = spec.connector?.tokenRef;
    if (ref?.source !== "external-secret-store" || typeof ref.path !== "string" || !ref.path.trim() || /[\x00-\x1f\x7f]/.test(ref.path)) throw new Error("tunnel connector requires a valid secret reference");
    if (!Array.isArray(spec.ingress) || !spec.ingress.length) throw new Error("tunnel requires ingress rules");
    const ingress = spec.ingress.map(rule => {
      const hostname = rule.hostname.toLowerCase();
      if (hostname.length > 253 || !hostname.includes(".") || !hostname.split(".").every(label => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))) throw new Error("tunnel ingress requires an exact DNS hostname");
      if (hosts.has(hostname)) throw new Error("conflicting tunnel ingress hostname");
      hosts.add(hostname);
      let origin: URL;
      try { origin = new URL(rule.service); } catch { throw new Error("invalid tunnel origin"); }
      if (!/^https?:$/.test(origin.protocol) || !origin.hostname || origin.username || origin.password || origin.pathname !== "/" || origin.search || origin.hash || /[\s\\?#]/.test(rule.service) || !/^https?:\/\/[^/]+\/?$/.test(rule.service)) throw new Error("invalid tunnel origin: HTTP(S) without credentials, path, query or fragment required");
      return { hostname, service: origin.origin };
    });
    return { name: spec.name, ownership: spec.ownership, ...(spec.ownership === "adopted" ? { adoptId: spec.adoptId } : {}), ...(spec.retain !== undefined ? { retain: spec.retain } : {}), ingress, connector: { tokenRef: { source: ref.source, path: ref.path } } } as CloudflareTunnelSpec;
  });
}
export function resolveTunnelResources(specs: CloudflareTunnelSpec[], target: DeploymentPlan["target"], prefix: string): ResourceSpec[] {
  if (specs.length && target !== "cloudflare") throw new Error("Cloudflare Tunnel is only supported on the cloudflare target");
  return validate(specs).map(spec => ({ id: `tunnel-${spec.name}`, kind: "cloudflare_tunnel", name: `${prefix}-tunnel-${spec.name}`, ownership: spec.ownership, ...(spec.ownership === "adopted" ? { adoptId: spec.adoptId } : {}), bindings: {}, properties: { tunnel: spec }, retain: spec.ownership === "adopted" || (spec.retain ?? false) }));
}
/** Native desired state only. Adoption allows config updates, not automatic deletion. */
export function emitCloudflareTunnels(plan: DeploymentPlan): CloudflareTunnelProjection[] {
  if (plan.target !== "cloudflare") throw new Error("Cloudflare Tunnel requires the cloudflare target");
  if (plan.stateOwner !== "native") throw new Error("Cloudflare Tunnel native projection requires native state owner");
  const resources = plan.resources.filter(r => r.kind === "cloudflare_tunnel");
  const specs = validate(resources.map(r => r.properties["tunnel"] as CloudflareTunnelSpec));
  return resources.map((r, index) => {
    const spec = specs[index]!;
    if (r.id !== `tunnel-${spec.name}` || r.ownership !== spec.ownership || r.adoptId !== spec.adoptId) throw new Error("tunnel resource disagrees with resolved specification");
    const file = `/run/secrets/tunnels/${spec.name}.token`;
    return { id: r.id, name: r.name, ownership: r.ownership, retain: r.retain,
      ...(spec.ownership === "adopted" ? { tunnelId: spec.adoptId } : { create: { name: r.name, config_src: "cloudflare" as const } }),
      config: { ingress: [...spec.ingress, { service: "http_status:404" as const }] },
      connector: { executable: "cloudflared" as const, args: ["tunnel", "--no-autoupdate", "run", "--token-file", file], credential: { ...spec.connector.tokenRef, file, mode: "0600" as const } } };
  });
}
