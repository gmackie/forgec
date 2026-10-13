import type { CloudflareTunnelProjection } from "./tunnels.js";

export interface TunnelRecord { tunnelId: string; name: string; ownership: "managed" | "adopted" }
/** Persistent journal and cross-process exclusion supplied by the native state owner. */
export interface TunnelJournal {
  exclusive<T>(key: string, action: () => Promise<T>): Promise<T>;
  read(key: string): Promise<TunnelRecord | null>;
  write(key: string, record: TunnelRecord): Promise<void>;
}
export interface TunnelSecrets { put(path: string, value: string): Promise<void> }
export interface TunnelProvider {
  find(name: string): Promise<{ id: string }[]>;
  create(name: string): Promise<{ id: string }>;
  inspect(id: string): Promise<{ id: string; name: string; config_src: string; deleted_at?: string | null }>;
  configuration(id: string): Promise<unknown>;
  configure(id: string, config: unknown): Promise<void>;
  token(id: string): Promise<string>;
}
function stable(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) => item && typeof item === "object" && !Array.isArray(item)
    ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item);
}

/** No DNS or Access writes. Their existing controllers retain exclusive ownership. */
export async function reconcileTunnel(
  desired: CloudflareTunnelProjection,
  options: { provider: TunnelProvider; journal: TunnelJournal; secrets: TunnelSecrets },
): Promise<{ tunnelId: string; configurationChanged: boolean; dns: "external"; access: "external" }> {
  const { provider, journal, secrets } = options;
  if (!desired.name || desired.connector.credential.source !== "external-secret-store") throw new Error("Invalid tunnel projection");
  // Name is app/stage scoped; a bare tunnel-<name> resource ID is not globally unique.
  return journal.exclusive(desired.name, async () => {
    let record = await journal.read(desired.name);
    if (record && (record.name !== desired.name || record.ownership !== desired.ownership ||
      (desired.ownership === "adopted" && record.tunnelId !== desired.tunnelId))) {
      throw new Error("Tunnel journal conflicts with desired ownership");
    }
    if (!record) {
      if (desired.ownership === "adopted") {
        if (!desired.tunnelId) throw new Error("Adoption requires a tunnel ID");
        record = { tunnelId: desired.tunnelId, name: desired.name, ownership: "adopted" };
      } else {
        // A previous create may have succeeded before the journal was committed.
        // Refuse collisions instead of creating a duplicate or silently claiming ownership.
        if ((await provider.find(desired.name)).length) throw new Error("Existing tunnel requires explicit adoption or journal recovery");
        const created = await provider.create(desired.name);
        record = { tunnelId: created.id, name: desired.name, ownership: "managed" };
        // Commit identity before configuration/secret work, so retries do not create again.
        await journal.write(desired.name, record);
      }
    }
    const actual = await provider.inspect(record.tunnelId);
    if (actual.id !== record.tunnelId || actual.config_src !== "cloudflare" || actual.deleted_at ||
      (record.ownership === "managed" && actual.name !== record.name)) throw new Error("Tunnel identity or remote management mode changed");
    const config = await provider.configuration(record.tunnelId) as { ingress?: unknown[] };
    if (!config || typeof config !== "object" || (config.ingress !== undefined && !Array.isArray(config.ingress))) throw new Error("Invalid existing tunnel configuration");
    // Updating an adopted tunnel must not silently delete someone else's ingress rules.
    if (record.ownership === "adopted" && config.ingress?.some(rule => {
      if (!rule || typeof rule !== "object") return true;
      const r = rule as { hostname?: string; service?: string; path?: string };
      if (r.path) return true; // This primitive does not own path-specific routes.
      return r.hostname ? !desired.config.ingress.some(w => "hostname" in w && w.hostname === r.hostname) : r.service !== "http_status:404";
    })) throw new Error("Adopted tunnel has ingress outside the declared ownership scope");
    // Preserve provider settings outside ingress (e.g. private-network routing).
    const next = { ...config, ingress: desired.config.ingress };
    const configurationChanged = stable(config) !== stable(next);
    if (configurationChanged) await provider.configure(record.tunnelId, next);
    const token = await provider.token(record.tunnelId);
    if (typeof token !== "string" || !token || token.length > 16_384 || /[\s\x00-\x1f]/.test(token)) throw new Error("Tunnel provider returned an invalid connector credential");
    try { await secrets.put(desired.connector.credential.path, token); }
    catch { throw new Error("Tunnel connector credential could not be stored"); }
    await journal.write(desired.name, record);
    return { tunnelId: record.tunnelId, configurationChanged, dns: "external", access: "external" };
  });
}

/** Cloudflare API transport. Token callback uses the existing external secret store. */
export class CloudflareTunnelApi implements TunnelProvider {
  constructor(private readonly options: { accountId: string; apiToken: () => Promise<string>; fetch?: typeof fetch }) {
    if (!/^[a-f0-9]{32}$/i.test(options.accountId)) throw new Error("Invalid Cloudflare account ID");
  }
  private async request<T>(path: string, method = "GET", body?: unknown): Promise<T> {
    let response: Response;
    try {
      response = await (this.options.fetch ?? fetch)(`https://api.cloudflare.com/client/v4/accounts/${this.options.accountId}/cfd_tunnel${path}`, {
        method, redirect: "error", signal: AbortSignal.timeout(30_000),
        headers: { authorization: `Bearer ${await this.options.apiToken()}`, "content-type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch { throw new Error("Cloudflare tunnel request failed"); }
    if (!response.ok) { await response.body?.cancel(); throw new Error(`Cloudflare tunnel HTTP ${response.status}`); }
    let envelope: { success: boolean; result: T };
    try {
      const reader = response.body?.getReader();
      if (!reader) throw new Error();
      let length = 0;
      const chunks: Uint8Array[] = [];
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        length += chunk.value.length;
        if (length > 1_048_576) { await reader.cancel(); throw new Error(); }
        chunks.push(chunk.value);
      }
      const bytes = new Uint8Array(length);
      let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
      envelope = JSON.parse(new TextDecoder().decode(bytes)) as typeof envelope;
    }
    catch { throw new Error("Invalid Cloudflare tunnel response"); }
    if (!envelope || envelope.success !== true || !("result" in envelope)) throw new Error("Cloudflare tunnel operation rejected");
    return envelope.result;
  }
  private id(id: string) {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) throw new Error("Invalid tunnel ID");
    return `/${id}`;
  }
  find(name: string) { return this.request<{ id: string }[]>(`?name=${encodeURIComponent(name)}&is_deleted=false`); }
  create(name: string) { return this.request<{ id: string }>("", "POST", { name, config_src: "cloudflare" }); }
  inspect(id: string) { return this.request<{ id: string; name: string; config_src: string; deleted_at?: string | null }>(this.id(id)); }
  async configuration(id: string) { return (await this.request<{ config: unknown }>(`${this.id(id)}/configurations`)).config; }
  async configure(id: string, config: unknown) { await this.request(`${this.id(id)}/configurations`, "PUT", { config }); }
  token(id: string) { return this.request<string>(`${this.id(id)}/token`); }
}
