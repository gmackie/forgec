import type { PlaygroundDocument, PlaygroundPosition, PlaygroundSample } from "../../src/playground-document.js";
import { readDraft } from "./draft.js";

/** Layout and samples are playground session state. They are not written into `.forge`. */
export const playgroundKey = "forge.playground.v1";

export interface SessionSample {
  path: string;
  name: string;
  clock: string;
  payload: string;
}

export interface PlaygroundSessionState {
  positions: PlaygroundPosition[];
  samples: SessionSample[];
}

const empty: PlaygroundSessionState = { positions: [], samples: [] };

function isPosition(value: unknown): value is PlaygroundPosition {
  if (!value || typeof value !== "object") return false;
  const position = value as PlaygroundPosition;
  return (
    typeof position.path === "string" &&
    typeof position.name === "string" &&
    typeof position.x === "number" &&
    typeof position.y === "number" &&
    Number.isFinite(position.x) &&
    Number.isFinite(position.y)
  );
}

function isSample(value: unknown): value is SessionSample {
  if (!value || typeof value !== "object") return false;
  const sample = value as SessionSample;
  return (
    typeof sample.path === "string" &&
    typeof sample.name === "string" &&
    typeof sample.clock === "string" &&
    typeof sample.payload === "string"
  );
}

export function readPlaygroundSession(): PlaygroundSessionState {
  try {
    const stored = JSON.parse(localStorage.getItem(playgroundKey) || "null");
    if (!stored || typeof stored !== "object") return empty;
    return {
      positions: Array.isArray(stored.positions) ? stored.positions.filter(isPosition) : [],
      samples: Array.isArray(stored.samples) ? stored.samples.filter(isSample) : [],
    };
  } catch {
    return empty;
  }
}

export function writePlaygroundSession(state: PlaygroundSessionState) {
  localStorage.setItem(
    playgroundKey,
    JSON.stringify({
      positions: state.positions.filter(isPosition),
      samples: state.samples.filter(isSample),
    }),
  );
}

export function payloadText(payload: unknown): string {
  if (typeof payload === "string") return payload;
  try {
    return JSON.stringify(payload ?? {});
  } catch {
    return "{}";
  }
}

export function payloadValue(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function liveKey(node: { path: string; name: string }) {
  return `${node.path}\0${node.name}`;
}

/** A renamed declaration keeps its source and drops the position stored under the old name. */
export function matchingPositions(
  nodes: { path: string; name: string }[],
  positions: PlaygroundPosition[],
): PlaygroundPosition[] {
  const live = new Set(nodes.map(liveKey));
  return positions.filter((position) => live.has(liveKey(position)) && isPosition(position));
}

/** Samples whose declaration is no longer in the graph are dropped. */
export function matchingSamples(
  nodes: { path: string; name: string }[],
  samples: PlaygroundSample[],
): SessionSample[] {
  const live = new Set(nodes.map(liveKey));
  return samples.flatMap((sample) => {
    if (!live.has(liveKey(sample)) || typeof sample.clock !== "string") return [];
    return [
      {
        path: sample.path,
        name: sample.name,
        clock: sample.clock,
        payload: payloadText(sample.payload),
      },
    ];
  });
}

/** The current browser draft, ready to attach to a publish. The server stamps the bundle digest. */
export function draftPlaygroundDocument(): Omit<PlaygroundDocument, "bundleDigest"> | null {
  const draft = readDraft();
  if (!draft) return null;
  const session = readPlaygroundSession();
  return {
    version: "playground/1",
    name: draft.project.name,
    currentFile: draft.project.currentFile,
    files: draft.project.files.map((file) => ({ path: file.path, text: file.text })),
    positions: session.positions,
    samples: session.samples.map((sample) => ({
      path: sample.path,
      name: sample.name,
      clock: sample.clock,
      payload: payloadValue(sample.payload),
    })),
  };
}
