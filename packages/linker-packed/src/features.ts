// Which runtime features a packed script links (FORG-37). A sliced group links only what its slice
// uses (`requiredFeatures` over the slice's model), so the bundle carries none of the other features'
// code; a fallback group runs the whole app and links every feature, like the whole-app Worker.
// The runtime builds a Worker from the slice with exactly these features at link time, so a slice the
// runtime would refuse with them fails the link, not a request.
import { Model, type AppBundle } from "@forgegraph/runtime";
import { cloudflareObjects, createWorkerWith } from "@forgegraph/runtime/cloudflare";
import { allFeatures, featuresNamed, requiredFeatures, type FeatureName } from "@forgegraph/runtime/features";
import type { HostConfig } from "./host.ts";
import { LinkError } from "./manifest.ts";

export interface ScriptFeatures {
  /** `all`: the fallback groups (every feature, as `createWorker`). */
  mode: "all" | "slice";
  names: FeatureName[];
  /** Blob storage (`cloudflareObjects`) is linked: always with `blobs`. */
  objects: boolean;
}

export function featuresFor(app: AppBundle, sliced: boolean, host: HostConfig): ScriptFeatures {
  if (!sliced) return { mode: "all", names: allFeatures.map((f) => f.name).sort(), objects: true };
  const names = requiredFeatures(new Model(app));
  if (host.dispatch === "local") names.push("dispatch");
  names.sort();
  const objects = names.includes("blobs");
  try {
    createWorkerWith(app, {
      features: featuresNamed(names),
      sweeps: host.sweeps,
      ...(objects ? { objects: cloudflareObjects } : {}),
      ...(host.dispatch === "forward" ? { postCommit: async () => undefined } : {}),
    });
  } catch (e) {
    throw new LinkError("slice", `the runtime refuses ${host.script} with features [${names.join(", ")}]: ${(e as Error).message}`);
  }
  return { mode: "slice", names, objects };
}

/** The generated entry's imports, and the `features`/`objects` it passes to the host. */
export function featureSource(f: ScriptFeatures): { imports: string[]; options: string } {
  const objects = f.objects ? [`import { cloudflareObjects } from "@forgegraph/runtime/cloudflare";`] : [];
  if (f.mode === "all") return { imports: [`import { allFeatures } from "@forgegraph/runtime/features";`, ...objects], options: `features: allFeatures${f.objects ? ", objects: cloudflareObjects" : ""}` };
  const named = f.names.length ? [`import { ${f.names.map((n) => `${n} as feature_${n}`).join(", ")} } from "@forgegraph/runtime/features";`] : [];
  return { imports: [...named, ...objects], options: `features: [${f.names.map((n) => `feature_${n}`).join(", ")}]${f.objects ? ", objects: cloudflareObjects" : ""}` };
}
