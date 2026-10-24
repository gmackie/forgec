// forgec check/build of examples/acme inside a Worker isolate, from the forgegraph-wasm module.
import wasm from "./generated/forgec.wasm";
import acme from "./generated/acme-request.json";

// The module has no imports: no WASI, no JS glue. Instantiated once per isolate.
const instance = new WebAssembly.Instance(wasm, {});
const { memory, forgec_alloc, forgec_free } = instance.exports;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

function call(name, request) {
  const input = encoder.encode(JSON.stringify(request));
  const ptr = forgec_alloc(input.length);
  new Uint8Array(memory.buffer, ptr, input.length).set(input);
  const packed = instance.exports[`forgec_${name}`](ptr, input.length);
  forgec_free(ptr, input.length);
  const outPtr = Number(packed >> 32n);
  const outLen = Number(packed & 0xffffffffn);
  const text = decoder.decode(new Uint8Array(memory.buffer, outPtr, outLen));
  forgec_free(outPtr, outLen);
  return JSON.parse(text);
}

function timed(name, request) {
  // Workers clocks only advance across I/O, so in-isolate deltas are expected to read 0;
  // they are reported as observed, and client-side wall time is measured separately.
  const date = Date.now();
  const perf = performance.now();
  const result = call(name, request);
  return { result, inIsolateMs: { date: Date.now() - date, performance: performance.now() - perf } };
}

export default {
  async fetch(req) {
    const url = new URL(req.url);
    const request = req.method === "POST" ? await req.json() : acme;
    const op = url.pathname.slice(1) || "both";
    const body = { op, memoryBytes: 0 };
    if (op === "check" || op === "both") body.check = timed("check", request);
    if (op === "build" || op === "both") body.build = timed("build", request);
    if (!body.check && !body.build) return Response.json({ error: "use /check, /build or /" }, { status: 404 });
    body.memoryBytes = memory.buffer.byteLength;
    return Response.json(body);
  },
};
