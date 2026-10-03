import type { AppBundle, DomainIR } from "@forgegraph/runtime";
import {
  PLAYGROUND_BYTES,
  type PlaygroundDocument,
} from "../../src/playground-document.js";
import { byteLength, canonical, digestOf } from "./digest.js";
import { isProject } from "./draft.js";
import type { Analysis, Project } from "./language.js";
import { playgroundGraph } from "./playground-model.js";
import {
  matchingPositions,
  matchingSamples,
  type PlaygroundSessionState,
} from "./playground-session.js";

type Inspect = (project: Project & { emit?: "ir" }) => Analysis | Promise<Analysis>;

export type ReopenDecision =
  | ({ mode: "edit"; project: Project } & PlaygroundSessionState)
  | { mode: "readonly"; ir: DomainIR; reason: string };

function readonly(ir: DomainIR, reason: string): ReopenDecision {
  return { mode: "readonly", ir, reason };
}

/**
 * Continue editing only when the recorded bundle digest matches the signed bundle
 * and the draft's domain IR matches that bundle's IR. Anything else is the compiled contract.
 */
export async function decideReopen(
  bundle: AppBundle,
  playground: PlaygroundDocument | null,
  inspect: Inspect,
): Promise<ReopenDecision> {
  const ir = bundle.ir;
  if (!ir) return { mode: "readonly", ir: { version: "", package: { name: "", version: "" }, modules: [] }, reason: "This package has no compiled contract." };
  if (!playground) return readonly(ir, "This package has no playground source layer.");
  if (byteLength(canonical(playground)) > PLAYGROUND_BYTES) {
    return readonly(ir, "The playground layer is too large to edit.");
  }
  if (playground.bundleDigest !== (await digestOf(canonical(bundle)))) {
    return readonly(ir, "The playground layer does not match this package.");
  }
  const project = {
    name: playground.name,
    currentFile: playground.currentFile,
    files: playground.files.map((file) => ({ path: file.path, text: file.text })),
  };
  if (!isProject(project)) return readonly(ir, "The playground layer is not a Forge draft.");
  let analysis: Analysis;
  try {
    analysis = await inspect({ ...project, emit: "ir" });
  } catch {
    return readonly(ir, "The playground source could not be compiled.");
  }
  if (!analysis.ir || (await digestOf(canonical(analysis.ir))) !== (await digestOf(canonical(ir)))) {
    return readonly(ir, "The playground source does not recompile to this package.");
  }
  const nodes = analysis.documents ? playgroundGraph(project, analysis).nodes : [];
  return {
    mode: "edit",
    project,
    positions: matchingPositions(nodes, playground.positions),
    samples: matchingSamples(nodes, playground.samples),
  };
}
