/**
 * Retention, crypto and recovery capability checks (FORGE-080; PAR-163).
 * Bindings are described, not assumed: a backup that exists in configuration
 * is `configured`; only a measured restore drill within the evidence window
 * yields RPO/RTO numbers; a checkbox never becomes a compliance claim. TTL
 * retention is enforced on read: an item past its retention instant is
 * invisible before physical cleanup, whatever the store still holds.
 */
export interface RecoveryConfig {
  backups: { configured: boolean; kind?: string; schedule?: string };
  restoreDrills: { at: string; rpoMs: number; rtoMs: number; evidenceRef: string; ok: boolean }[];
  keys: { managed: boolean; rotationDays?: number; lastRotatedAt?: string };
  legalHolds: { id: string; scope: string; until?: string }[];
  /** Evidence older than this is stale. */
  evidenceWindowMs: number;
}
export interface ControlCheck { control: string; state: "measured" | "configured" | "unknown" | "external-evidence-required" | "stale"; detail: string; value?: unknown }

export function recoveryEvidence(cfg: RecoveryConfig, now = Date.now()): { checks: ControlCheck[]; rpoRtoProven: boolean } {
  const checks: ControlCheck[] = [];
  if (!cfg.backups.configured) checks.push({ control: "backup", state: "unknown", detail: "no backup binding configured" });
  else checks.push({ control: "backup", state: "configured", detail: `${cfg.backups.kind ?? "backup"} ${cfg.backups.schedule ?? ""}`.trim() });
  const drills = cfg.restoreDrills.filter((d) => d.ok).sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
  const latest = drills[0];
  if (!latest) checks.push({ control: "rpo-rto", state: "external-evidence-required", detail: "backup configuration exists but no successful restore drill was recorded: RPO/RTO cannot be inferred from configuration" });
  else if (now - Date.parse(latest.at) > cfg.evidenceWindowMs) checks.push({ control: "rpo-rto", state: "stale", detail: `last successful drill ${latest.at} is outside the evidence window`, value: { rpoMs: latest.rpoMs, rtoMs: latest.rtoMs, evidenceRef: latest.evidenceRef } });
  else checks.push({ control: "rpo-rto", state: "measured", detail: `restore drill ${latest.at} (${latest.evidenceRef})`, value: { rpoMs: latest.rpoMs, rtoMs: latest.rtoMs } });
  if (!cfg.keys.managed) checks.push({ control: "key-management", state: "unknown", detail: "keys are not bound to a managed key service" });
  else if (cfg.keys.rotationDays && cfg.keys.lastRotatedAt && now - Date.parse(cfg.keys.lastRotatedAt) > cfg.keys.rotationDays * 86_400_000) checks.push({ control: "key-management", state: "stale", detail: `last rotation ${cfg.keys.lastRotatedAt} exceeds ${cfg.keys.rotationDays} days` });
  else checks.push({ control: "key-management", state: "configured", detail: "managed keys" });
  for (const h of cfg.legalHolds) checks.push({ control: `legal-hold:${h.id}`, state: h.until && Date.parse(h.until) < now ? "stale" : "configured", detail: `${h.scope}${h.until ? ` until ${h.until}` : ""}` });
  return { checks, rpoRtoProven: checks.some((c) => c.control === "rpo-rto" && c.state === "measured") };
}

/** Retention on read: an item whose retention instant passed is absent, even before TTL cleanup removes the row. */
export function retentionVisible(record: { retainUntil?: string | null; ttl?: number | null }, now = Date.now()): boolean {
  if (typeof record.retainUntil === "string" && Date.parse(record.retainUntil) <= now) return false;
  if (typeof record.ttl === "number" && record.ttl * 1000 <= now) return false; // DynamoDB-style epoch seconds
  return true;
}
