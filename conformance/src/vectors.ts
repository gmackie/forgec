/** Golden-vector file shape (specs/codecs/README.md). Consumed by the TS codecs and mirrored by the Rust tests. */
export interface VectorCase {
  name: string;
  params: Record<string, unknown>;
  input?: unknown;
  input_json?: string;
  input_list?: unknown[];
  expect?: unknown;
  error?: string;
  expect_order?: unknown[];
  expect_distinct?: boolean;
}

export interface VectorFile {
  codec: string;
  version: number;
  cases: VectorCase[];
}

export function loadVectorFile(text: string): VectorFile {
  const v = JSON.parse(text) as VectorFile;
  if (typeof v.codec !== "string" || !Array.isArray(v.cases)) throw new Error("not a vector file");
  return v;
}
