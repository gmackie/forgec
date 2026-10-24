// Coverage summary of a sealed Closure Manifest: what is a unit, what is an entry point, what is
// served by the runtime alone, and what is left uncovered. Used for both sides of the before/after
// table (`measure.ts`); `node summarize.ts <manifest.json>` prints one.
import { readFileSync } from "node:fs";

type Manifest = {
  manifestHash: string;
  units: Record<string, { symbol: string; role: string; kind: string; sources?: Array<{ part: string }> }>;
  entryPoints: Array<{ kind: string; id: string; root: string | null; runtimeService?: string; bindings: Array<{ type: string; name: string }> }>;
  hostBindings: Array<{ type: string; name: string }>;
  uncovered: Array<{ kind: string; id: string; reason: string }>;
};

const count = <T>(xs: T[], key: (x: T) => string) => Object.fromEntries(Object.entries(xs.reduce<Record<string, number>>((a, x) => ({ ...a, [key(x)]: (a[key(x)] ?? 0) + 1 }), {})).sort(([a], [b]) => (a < b ? -1 : 1)));

export function summarize(m: Manifest) {
  const units = Object.values(m.units);
  return {
    manifestHash: m.manifestHash,
    units: { total: units.length, byRole: count(units, (u) => u.role), byKind: count(units, (u) => u.kind) },
    entryPoints: { total: m.entryPoints.length, byKind: count(m.entryPoints, (e) => e.kind), rooted: m.entryPoints.filter((e) => e.root).length },
    servedByRuntimeAlone: m.entryPoints.filter((e) => !e.root).map((e) => `${e.id} (${e.runtimeService})`).sort(),
    uncovered: m.uncovered.map((u) => `${u.kind} ${u.id}`),
    hostBindings: m.hostBindings.map((b) => b.name),
    cancelRouteBindings: m.entryPoints.filter((e) => e.runtimeService === "workflow-instances" && e.id.endsWith("/cancel")).map((e) => ({ id: e.id, bindings: e.bindings.map((b) => b.name) })),
    sources: {
      unitsWithDeclaration: units.filter((u) => u.sources?.some((s) => s.part === "declaration")).length,
      unitsWithBody: units.filter((u) => u.sources?.some((s) => s.part === "body")).length,
      unitsWithout: units.filter((u) => !u.sources?.length).map((u) => u.symbol).sort(),
    },
  };
}

if (import.meta.main) console.log(JSON.stringify(summarize(JSON.parse(readFileSync(process.argv[2]!, "utf8")) as Manifest), null, 2));
