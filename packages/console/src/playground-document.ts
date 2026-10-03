/** Unsigned OCI layer. It is not part of the signed Forge manifest. */
export const PLAYGROUND_MEDIA = "application/vnd.forgegraph.playground.v1+json";
/** Same byte cap the OCI adapter applies to every descriptor. */
export const PLAYGROUND_BYTES = 8_000_000;

export interface PlaygroundFile {
  path: string;
  text: string;
}

export interface PlaygroundPosition {
  path: string;
  name: string;
  x: number;
  y: number;
}

export interface PlaygroundSample {
  path: string;
  name: string;
  clock: string;
  payload: unknown;
}

/** Open draft, node positions, and source samples stored beside a signed package. */
export interface PlaygroundDocument {
  version: "playground/1";
  /** `digestOf(canonical(bundle))` for the signed bundle this draft was published with. */
  bundleDigest: string;
  name: string;
  currentFile: string;
  files: PlaygroundFile[];
  positions: PlaygroundPosition[];
  samples: PlaygroundSample[];
}

/** What a publisher may send. The registry stamps `bundleDigest` from the signed bundle. */
export type PlaygroundAttachment = Omit<PlaygroundDocument, "bundleDigest"> & {
  bundleDigest?: string;
};

const digest = /^sha256:[a-f0-9]{64}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function position(value: unknown): PlaygroundPosition | null {
  if (!isRecord(value)) return null;
  if (typeof value.path !== "string" || typeof value.name !== "string") return null;
  if (typeof value.x !== "number" || typeof value.y !== "number") return null;
  if (!Number.isFinite(value.x) || !Number.isFinite(value.y)) return null;
  return { path: value.path, name: value.name, x: value.x, y: value.y };
}

function sample(value: unknown): PlaygroundSample | null {
  if (!isRecord(value)) return null;
  if (typeof value.path !== "string" || typeof value.name !== "string") return null;
  if (typeof value.clock !== "string") return null;
  return {
    path: value.path,
    name: value.name,
    clock: value.clock,
    payload: value.payload ?? null,
  };
}

/** Returns the document, or null when the layer cannot be read. Pull still succeeds. */
export function parsePlayground(text: string): PlaygroundDocument | null {
  try {
    const value = JSON.parse(text) as unknown;
    if (!isRecord(value) || value.version !== "playground/1") return null;
    if (typeof value.bundleDigest !== "string" || !digest.test(value.bundleDigest)) return null;
    if (typeof value.name !== "string" || typeof value.currentFile !== "string") return null;
    if (!Array.isArray(value.files) || value.files.length < 1 || value.files.length > 50) return null;
    const files: PlaygroundFile[] = [];
    for (const file of value.files) {
      if (!isRecord(file) || typeof file.path !== "string" || typeof file.text !== "string") return null;
      if (!file.path || file.path.length > 500) return null;
      files.push({ path: file.path, text: file.text });
    }
    if (!files.some((file) => file.path === value.currentFile)) return null;
    return {
      version: "playground/1",
      bundleDigest: value.bundleDigest,
      name: value.name,
      currentFile: value.currentFile,
      files,
      positions: Array.isArray(value.positions)
        ? value.positions.flatMap((item) => {
            const next = position(item);
            return next ? [next] : [];
          })
        : [],
      samples: Array.isArray(value.samples)
        ? value.samples.flatMap((item) => {
            const next = sample(item);
            return next ? [next] : [];
          })
        : [],
    };
  } catch {
    return null;
  }
}
