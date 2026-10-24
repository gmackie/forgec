// The capability policy of one child isolate: which handles the host injects and how far each
// is narrowed. It is derived from the manifest only (the entry point's closure imports and unit
// bindings), plus the app's SQL schema to map resources to tables. Anything not derived here gets
// no handle, so the child fails closed when it reaches for it.
import { jsUnits, type ClosureManifest, type EntryPoint } from "./manifest.ts";

export interface SqlSchema {
  tables: Array<{ name: string; resource: string; foreignKeys?: Array<{ references: string }> }>;
  systemTables: Array<{ name: string }>;
}

export interface Policy {
  /** What the policy was derived from, for logs and problems. */
  label: string;
  /** Unrestricted runtime child (the sweep, and `uncovered` fallback). Always reported. */
  privileged: boolean;
  tables: { read: string[]; write: string[] };
  /** R2 bindings (object store handles). */
  objects: string[];
  /** Queue producer bindings. */
  queues: string[];
  /** Workflow bindings. */
  workflows: string[];
  /** Origins reachable with fetch()/connect(); empty = no network. */
  egress: string[];
  /** js-module units whose modules the child loads. */
  units: string[];
  /** Manifest bindings this linker cannot hand to a child (reported, never silently dropped). */
  unlinked: string[];
  /**
   * Handles other entry points declare and this one does not. The child's runtime gets a stub for
   * each that refuses with 403 CapabilityDenied, instead of nothing, which it would silently replace
   * (BLOBS with an in-memory store, a workflow binding with the cron timer). FORG-34.
   */
  withheld: { objects: string[]; queues: string[]; workflows: string[] };
}

const sorted = (s: Iterable<string>) => [...new Set(s)].sort();

/** Every binding of `type` the manifest names, on any entry point or unit. */
const declaredOf = (manifest: ClosureManifest, type: string) =>
  sorted([...manifest.entryPoints.flatMap((e) => e.bindings), ...Object.values(manifest.units).flatMap((u) => u.bindings)].filter((b) => b.type === type).map((b) => b.name));

function withheldFrom(manifest: ClosureManifest, granted: { objects: string[]; queues: string[]; workflows: string[] }): Policy["withheld"] {
  const minus = (type: string, have: string[]) => declaredOf(manifest, type).filter((n) => !have.includes(n));
  return { objects: minus("r2", granted.objects), queues: minus("queue-producer", granted.queues), workflows: minus("workflow", granted.workflows) };
}
const WRITE_MODES = new Set(["write", "create", "delete"]);

/** Runtime-owned tables (receipts, audit, outbox, documents). Not narrowed: see README finding. */
export const systemTables = (schema: SqlSchema) => schema.systemTables.map((t) => t.name);

export function derivePolicy(manifest: ClosureManifest, entry: EntryPoint, schema: SqlSchema): Policy {
  if (entry.runtimeService === "outbox-and-workflow-sweep") return privilegedPolicy(manifest, schema, `runtime:${entry.runtimeService}`);
  const tableOf = new Map(schema.tables.map((t) => [t.resource, t]));
  const read = new Set<string>();
  const write = new Set<string>();
  const unlinked: string[] = [];
  let usesStorage = entry.runtimeService === "workflow-instances";
  for (const i of entry.imports) {
    const m = /^resource:([^#]+)#([A-Za-z]+)$/.exec(i.capability);
    if (!m) continue;
    const t = tableOf.get(m[1]!);
    if (!t) {
      unlinked.push(`${i.capability} (no table for ${m[1]})`);
      continue;
    }
    usesStorage = true;
    read.add(t.name);
    if (WRITE_MODES.has(m[2]!)) write.add(t.name);
  }
  // Integrity the runtime enforces inside a write, which the manifest does not list as imports:
  // reference guards read the referenced table, restrict-delete reads the referencing tables.
  for (const name of [...write]) {
    const t = schema.tables.find((x) => x.name === name)!;
    for (const fk of t.foreignKeys ?? []) read.add(fk.references);
    for (const other of schema.tables) if ((other.foreignKeys ?? []).some((fk) => fk.references === name)) read.add(other.name);
  }
  if (usesStorage || entry.imports.some((i) => i.capability.startsWith("send:") || i.capability.startsWith("wait:") || i.capability === "sleep")) {
    for (const s of systemTables(schema)) {
      read.add(s);
      write.add(s);
    }
  }
  const objects: string[] = [];
  const queues: string[] = [];
  const workflows: string[] = [];
  for (const b of entry.bindings) {
    if (b.type === "r2") objects.push(b.name);
    else if (b.type === "queue-producer") queues.push(b.name);
    else if (b.type === "workflow") workflows.push(b.name);
    else if (b.type === "durable-object") unlinked.push(`durable-object:${b.name} (realtime fan-out is not linked by T4)`);
  }
  const granted = { objects: sorted(objects), queues: sorted(queues), workflows: sorted(workflows) };
  return {
    label: `${entry.kind}:${entry.id}`,
    privileged: false,
    tables: { read: sorted(read), write: sorted(write) },
    ...granted,
    egress: sorted(entry.egress ?? []),
    units: jsUnits(manifest, entry.closure).map((u) => u.hash),
    unlinked: sorted(unlinked),
    withheld: withheldFrom(manifest, granted),
  };
}

/** Every table, every binding the manifest names, every js unit. Used only where the runtime needs the whole app. */
export function privilegedPolicy(manifest: ClosureManifest, schema: SqlSchema, label: string): Policy {
  const all = sorted([...schema.tables.map((t) => t.name), ...systemTables(schema)]);
  const of = (type: string) => declaredOf(manifest, type);
  return {
    label,
    privileged: true,
    tables: { read: all, write: all },
    objects: of("r2"),
    queues: of("queue-producer"),
    workflows: of("workflow"),
    egress: [],
    units: Object.entries(manifest.units).filter(([, u]) => u.kind === "js-module").map(([h]) => h).sort(),
    unlinked: of("durable-object").map((n) => `durable-object:${n} (realtime fan-out is not linked by T4)`),
    withheld: { objects: [], queues: [], workflows: [] },
  };
}

/** The signed object-bytes route (`/_forge/objects/<token>`) has no manifest entry point (README finding). */
export function objectRoutePolicy(manifest: ClosureManifest): Policy {
  const r2 = sorted(manifest.entryPoints.flatMap((e) => e.bindings).filter((b) => b.type === "r2").map((b) => b.name));
  return { label: "runtime:object-bytes", privileged: false, tables: { read: [], write: [] }, objects: r2, queues: [], workflows: [], egress: [], units: [], unlinked: [], withheld: withheldFrom(manifest, { objects: r2, queues: [], workflows: [] }) };
}
