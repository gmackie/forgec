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
export interface Analysis {
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
export async function language(bytes: BufferSource) {
  const { instance } = await WebAssembly.instantiate(bytes, {});
  const wasm = instance.exports as unknown as {
    memory: WebAssembly.Memory;
    editor_alloc(n: number): number;
    editor_free(p: number, n: number): void;
    editor_inspect(p: number, n: number): bigint;
  };
  return (project: Project): Analysis => {
    const input = new TextEncoder().encode(JSON.stringify(project));
    const ptr = wasm.editor_alloc(input.length);
    let result: bigint;
    try {
      new Uint8Array(wasm.memory.buffer, ptr, input.length).set(input);
      result = wasm.editor_inspect(ptr, input.length);
    } finally {
      wasm.editor_free(ptr, input.length);
    }
    const out = Number(result >> 32n),
      len = Number(result & 0xffffffffn);
    try {
      return JSON.parse(
        new TextDecoder().decode(new Uint8Array(wasm.memory.buffer, out, len)),
      );
    } finally {
      wasm.editor_free(out, len);
    }
  };
}
