export interface SyntaxNode {
  kind: string;
  start: number;
  end: number;
  token?: boolean;
  children: SyntaxNode[];
}
export interface SourceFile {
  path: string;
  text: string;
}
export interface Project {
  name: string;
  files: SourceFile[];
  currentFile: string;
}
export interface Diagnostic {
  code: string;
  severity: string;
  message: string;
  file: string;
  start: number;
  end: number;
  suggestion?: string;
}
export interface FieldSemantics {
  resource: string;
  field: string;
  class: string;
  ancestors: string[];
  handling: string;
  personal: string;
  identifiability: string;
  evidence: string;
  completeness: string;
}
export interface Analysis {
  /** Present only when the inspect request set `emit` to `"ir"`. */
  ir?: import("@forgegraph/runtime").DomainIR;
  dataClasses?: {
    id: string;
    name: string;
    parent: string;
    handling: string;
    personal: string;
  }[];
  dataSemantics?: {
    fields: FieldSemantics[];
    summary: Record<string, number>;
  } | null;
  tree: SyntaxNode;
  documents: { path: string; module: string; tree: SyntaxNode }[];
  symbols: { name: string; kind: string; file: string }[];
  diagnostics: Diagnostic[];
  taxonomy: {
    version: string;
    nodes: {
      id: string;
      parent?: string;
      handling: string;
      personal: string;
    }[];
  };
  scalars: string[];
  error?: string;
}
export interface OpenApiImportRequest {
  text: string;
  package: string;
  allowHosts?: string[];
}
export interface OpenApiOperation {
  operationId: string;
  function: string;
  method: string;
  path: string;
}
export interface OpenApiReport {
  source: { title: string; version: string; openapi: string };
  hosts: string[];
  operations: OpenApiOperation[];
  skippedOperations: string[];
  unsupported: { feature: string; at: string; note: string }[];
  foreignIdentifiers: { shape: string; field: string }[];
  callbacks: { name: string; kind: string }[];
}
export interface OpenApiImport {
  files?: { path: string; text: string }[];
  report?: OpenApiReport;
  error?: string;
}
export interface Language {
  (project: Project & { emit?: "ir" }): Analysis;
  importOpenApi(request: OpenApiImportRequest): OpenApiImport;
}

interface WasmExports {
  memory: WebAssembly.Memory;
  editor_alloc(n: number): number;
  editor_free(p: number, n: number): void;
  editor_inspect?(p: number, n: number): bigint;
  editor_import_openapi?(p: number, n: number): bigint;
}

function bind(
  wasm: WasmExports,
  fn: ((p: number, n: number) => bigint) | undefined,
): ((value: unknown) => unknown) | null {
  if (!fn) return null;
  return (value) => {
    const input = new TextEncoder().encode(JSON.stringify(value));
    const ptr = wasm.editor_alloc(input.length);
    let result: bigint;
    try {
      new Uint8Array(wasm.memory.buffer, ptr, input.length).set(input);
      result = fn(ptr, input.length);
    } finally {
      wasm.editor_free(ptr, input.length);
    }
    const out = Number(result >> 32n);
    const len = Number(result & 0xffffffffn);
    try {
      return JSON.parse(
        new TextDecoder().decode(new Uint8Array(wasm.memory.buffer, out, len)),
      );
    } finally {
      wasm.editor_free(out, len);
    }
  };
}

export async function language(bytes: BufferSource): Promise<Language> {
  const { instance } = await WebAssembly.instantiate(bytes, {});
  const wasm = instance.exports as unknown as WasmExports;
  const inspect = bind(wasm, wasm.editor_inspect);
  const importOpenApi = bind(wasm, wasm.editor_import_openapi);
  if (!inspect) throw new Error("This compiler cannot inspect Forge source");
  return Object.assign(
    (project: Project & { emit?: "ir" }): Analysis => inspect(project) as Analysis,
    {
      importOpenApi(request: OpenApiImportRequest): OpenApiImport {
        if (!importOpenApi) throw new Error("This compiler cannot import OpenAPI");
        return importOpenApi(request) as OpenApiImport;
      },
    },
  );
}
