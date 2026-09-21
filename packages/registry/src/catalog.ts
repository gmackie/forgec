/**
 * Derived catalog (FORGE-058; PAR-126). An index over verified artifacts:
 * exports, fields with data classes and subjects, purposes, actions, effects,
 * owners and declared dependencies. Indexing is keyed by the artifact's
 * qualified identity and digest, so reindexing is idempotent and the whole
 * index can be dropped and rebuilt from the artifact store without touching
 * package authority. Every read goes through `AccessPolicy` (PAR-127).
 */
import type { AppBundle } from "@forge/runtime";
import { Registry, type Pulled, type TrustPolicy } from "./artifacts.js";
import { AccessPolicy, qualifiedId, type CatalogPrincipal } from "./security.js";

export interface Export { kind: "resource" | "function" | "shape" | "enum" | "purpose" | "dataClass" | "channel" | "workflow" | "view" | "surface" | "capability"; name: string; id: string }
export interface FieldEntry { resource: string; field: string; class?: string; subject?: string }
export interface ActionEntry { id: string; kind: string; resource?: string }
export interface EffectEntry { function: string; sends: string[]; uses: string[] }
export interface PackageEntry {
  id: string;
  authority: string;
  name: string;
  version: string;
  digest: string;
  namespace: string;
  owner?: string;
  audience?: string[];
  dependencies: string[];
  exports: Export[];
  fields: FieldEntry[];
  actions: ActionEntry[];
  effects: EffectEntry[];
}
export interface SearchHit { package: string; kind: string; name: string; id: string; owner?: string }

const ADMIN: CatalogPrincipal = { subject: "catalog", namespaces: ["*"], audiences: ["*"] };

function namespaceOf(name: string): string {
  return name; // `@scope/name`: the whole package name is the namespace unit patterns match against
}

export function entryFrom(authority: string, pulled: Pulled): PackageEntry {
  const m = pulled.manifest;
  const b: AppBundle = pulled.bundle;
  const exports: Export[] = [];
  const fields: FieldEntry[] = [];
  const actions: ActionEntry[] = [];
  const effects: EffectEntry[] = [];
  const subjects = new Map<string, string>();
  for (const s of b.dataSemantics?.subjects ?? []) subjects.set(s.resource, s.kind);
  for (const mod of b.ir.modules) {
    for (const r of mod.resources) {
      exports.push({ kind: "resource", name: r.name, id: r.id });
      for (const op of r.operations) actions.push({ id: op.id, kind: op.kind, resource: r.id });
    }
    for (const f of mod.functions) {
      exports.push({ kind: "function", name: f.name, id: f.id });
      actions.push({ id: f.id, kind: "function" });
      effects.push({ function: f.id, sends: f.sends.map((s) => `${s.channel}.${s.message}`), uses: f.uses.map((u) => (u.kind === "resource" ? `${u.resource}:${u.capability}` : u.kind === "transition" ? `${u.resource}.${u.action}` : u.function)) });
    }
    for (const c of mod.channels ?? []) exports.push({ kind: "channel", name: c.name, id: c.id });
    for (const w of mod.workflows ?? []) exports.push({ kind: "workflow", name: w.name, id: w.id });
    for (const v of mod.views ?? []) exports.push({ kind: "view", name: v.name, id: v.id });
    for (const e of mod.enums ?? []) exports.push({ kind: "enum", name: e.name, id: e.id });
    for (const p of mod.purposes ?? []) exports.push({ kind: "purpose", name: p.name, id: p.id });
    for (const d of mod.dataClasses ?? []) exports.push({ kind: "dataClass", name: d.name, id: d.id });
    const shapes = (mod as unknown as { shapes?: { name: string; id: string }[] }).shapes ?? [];
    for (const s of shapes) exports.push({ kind: "shape", name: s.name, id: s.id });
    for (const r of mod.resources) {
      for (const f of r.fields) {
        const cls = b.dataSemantics?.fields.find((x) => x.resource === r.id && x.field === f.name)?.class;
        const subject = subjects.get(r.id);
        fields.push({ resource: r.id, field: f.name, ...(cls ? { class: cls } : {}), ...(subject ? { subject } : {}) });
      }
    }
  }
  // Purpose surfaces and capability fragments used by this package (declared here or imported): the
  // names a confidentiality policy most needs to hide, so they are indexed as first-class exports.
  const caps = (b as { capabilities?: { surfaces?: { resource: string; purpose: string; capabilities: string[]; allowAtoms: { name: string }[] }[] } }).capabilities;
  const seenPurposes = new Set<string>();
  const seenCaps = new Set<string>();
  for (const sf of caps?.surfaces ?? []) {
    if (!seenPurposes.has(sf.purpose)) { seenPurposes.add(sf.purpose); exports.push({ kind: "purpose", name: sf.purpose.slice(sf.purpose.lastIndexOf("/_/") + 3), id: sf.purpose }); }
    exports.push({ kind: "surface", name: `${sf.resource.slice(sf.resource.lastIndexOf("/_/") + 3)}:${sf.purpose.slice(sf.purpose.lastIndexOf("/_/") + 3)}`, id: `${sf.resource}#${sf.purpose}` });
    for (const c of sf.capabilities) if (!seenCaps.has(c)) { seenCaps.add(c); exports.push({ kind: "capability", name: c, id: `${sf.resource}#${c}` }); }
  }
  const dependencies = (m.provenance.dependencies ?? []).map((d) => `${d.name}@${d.version}`);
  for (const imp of (b.ir as { imports?: { package: string }[] }).imports ?? []) if (!dependencies.some((d) => d.startsWith(imp.package + "@"))) dependencies.push(imp.package);
  const sortBy = <T>(xs: T[], key: (x: T) => string) => xs.sort((a, c) => key(a).localeCompare(key(c)));
  return {
    id: qualifiedId(authority, m.name, m.packageVersion),
    authority,
    name: m.name,
    version: m.packageVersion,
    digest: pulled.digest,
    namespace: namespaceOf(m.name),
    ...(m.provenance.owner ? { owner: m.provenance.owner } : {}),
    ...(m.audience ? { audience: m.audience } : {}),
    dependencies: dependencies.sort(),
    exports: sortBy(exports, (e) => `${e.kind}:${e.id}`),
    fields: sortBy(fields, (f) => `${f.resource}.${f.field}`),
    actions: sortBy(actions, (a) => a.id),
    effects: sortBy(effects, (e) => e.function),
  };
}

export class Catalog {
  readonly schemaVersion = "catalog/1";
  readonly authority: string;
  readonly policy: AccessPolicy;
  private entries = new Map<string, PackageEntry>();
  constructor(o: { authority: string; policy?: AccessPolicy }) {
    this.authority = o.authority;
    this.policy = o.policy ?? new AccessPolicy();
  }

  /** Idempotent: the same digest under the same identity is a no-op; a different digest replaces the entry (tags moved). */
  async index(pulled: Pulled, authority = this.authority): Promise<PackageEntry> {
    const entry = entryFrom(authority, pulled);
    const existing = this.entries.get(entry.id);
    if (existing && existing.digest === entry.digest) return existing;
    this.entries.set(entry.id, entry);
    return entry;
  }

  /** Drop everything from an authority and re-derive it from its verified artifacts. */
  async rebuild(registry: Registry, o: { federated?: { authority: string; trust: TrustPolicy } } = {}): Promise<number> {
    const authority = o.federated?.authority ?? registry.authority;
    const source = o.federated ? new Registry({ authority: o.federated.authority, store: registry.store, trust: o.federated.trust }) : registry;
    for (const [id, e] of [...this.entries]) if (e.authority === authority) this.entries.delete(id);
    let n = 0;
    for (const tag of await source.store.listTags()) {
      await this.index(await source.pull(tag.digest), authority); // throws on any verification failure: nothing partial
      n++;
    }
    return n;
  }

  snapshot(): PackageEntry[] {
    return [...this.entries.values()].sort((a, b) => a.id.localeCompare(b.id));
  }

  private visible(p: CatalogPrincipal): PackageEntry[] {
    return this.snapshot().filter((e) => this.policy.allows(p, { namespace: e.namespace, ...(e.audience ? { audience: e.audience } : {}) }));
  }
  private get(id: string, p: CatalogPrincipal): PackageEntry | null {
    return this.visible(p).find((e) => e.id === id) ?? null;
  }

  packages(p: CatalogPrincipal = ADMIN): { id: string; name: string; version: string; digest: string; owner?: string }[] {
    return this.visible(p).map((e) => ({ id: e.id, name: e.name, version: e.version, digest: e.digest, ...(e.owner ? { owner: e.owner } : {}) }));
  }

  search(term: string, p: CatalogPrincipal = ADMIN): SearchHit[] {
    const q = term.toLowerCase();
    const hits: SearchHit[] = [];
    for (const e of this.visible(p)) {
      const owner = e.owner ? { owner: e.owner } : {};
      for (const x of e.exports) if (x.name.toLowerCase().includes(q)) hits.push({ package: e.id, kind: x.kind, name: x.name, id: x.id, ...owner });
      for (const f of e.fields) if (f.field.toLowerCase().includes(q)) hits.push({ package: e.id, kind: "field", name: f.field, id: `${f.resource}.${f.field}`, ...owner });
      for (const a of e.actions) if (a.id.toLowerCase().includes(q) && !hits.some((h) => h.id === a.id)) hits.push({ package: e.id, kind: "action", name: a.id.slice(a.id.lastIndexOf("/_/") + 3), id: a.id, ...owner });
    }
    return hits.sort((a, b) => `${a.package}|${a.kind}|${a.id}`.localeCompare(`${b.package}|${b.kind}|${b.id}`));
  }

  graph(id: string, p: CatalogPrincipal = ADMIN): { id: string; dependencies: string[]; dependents: string[] } | null {
    const e = this.get(id, p);
    if (!e) return null;
    const dependents = this.visible(p).filter((x) => x.dependencies.some((d) => d === `${e.name}@${e.version}` || d === e.name)).map((x) => x.id);
    return { id: e.id, dependencies: e.dependencies, dependents };
  }

  actions(id: string, p: CatalogPrincipal = ADMIN): ActionEntry[] {
    return this.get(id, p)?.actions ?? [];
  }
  fields(id: string, p: CatalogPrincipal = ADMIN): FieldEntry[] {
    return this.get(id, p)?.fields ?? [];
  }
  effects(id: string, p: CatalogPrincipal = ADMIN): EffectEntry[] {
    return this.get(id, p)?.effects ?? [];
  }
}
