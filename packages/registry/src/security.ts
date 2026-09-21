/**
 * Confidential catalog access and federation (FORGE-059; PAR-127/129).
 * Metadata visibility is decided once, by namespace and audience, and every
 * catalog endpoint goes through the same decision, so a name hidden from
 * search is also hidden from graph neighbours, actions and field listings.
 * Identities are authority-qualified (`registry.acme/@acme/commerce@0.1.0`);
 * grants are keyed by that identity and never transfer across authorities.
 */
export interface CatalogPrincipal {
  subject: string;
  /** Namespace patterns the principal may see (`@acme/*`, `*`). */
  namespaces: string[];
  /** Audiences the principal belongs to (`org:acme`, `*`). */
  audiences: string[];
}

export interface Visibility { namespace: string; audience?: string[] }

export function qualifiedId(authority: string, name: string, version: string): string {
  return `${authority}/${name}@${version}`;
}

function globMatch(pattern: string, value: string): boolean {
  if (pattern === "*") return true;
  if (pattern.endsWith("*")) return value.startsWith(pattern.slice(0, -1));
  return pattern === value;
}

export class AccessPolicy {
  private grants = new Map<string, Set<string>>();

  explain(p: CatalogPrincipal, v: Visibility): { allowed: boolean; reason: "namespace" | "audience" | null } {
    if (!p.namespaces.some((n) => globMatch(n, v.namespace))) return { allowed: false, reason: "namespace" };
    if (v.audience && v.audience.length && !p.audiences.includes("*") && !v.audience.some((a) => p.audiences.includes(a))) return { allowed: false, reason: "audience" };
    return { allowed: true, reason: null };
  }
  allows(p: CatalogPrincipal, v: Visibility): boolean {
    return this.explain(p, v).allowed;
  }

  grant(qualified: string, g: { subject: string; capability: string }): void {
    const set = this.grants.get(qualified) ?? new Set<string>();
    set.add(`${g.subject}:${g.capability}`);
    this.grants.set(qualified, set);
  }
  granted(qualified: string, subject: string, capability: string): boolean {
    return this.grants.get(qualified)?.has(`${subject}:${capability}`) ?? false;
  }
}
