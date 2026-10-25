// FORG-48 (local): CPU of a child build's non-I/O steps in Node: sha256, decoding, JSON.parse of app.json.
//   node lab/cpu.mjs <repo root>
import { readFileSync } from "node:fs";
const root = process.argv[2];
const files = [`${root}/packages/linker-dynamic/generated/libs/effect@4.0.3.js`, `${root}/packages/linker-dynamic/generated/libs/@forgegraph+runtime@0.5.0.js`, `${root}/examples/acme/generated/app.json`];
const bufs = files.map((f) => new Uint8Array(readFileSync(f)));
const t = async (f, n = 20) => { const xs = []; for (let i = 0; i < n; i++) { const t0 = performance.now(); await f(); xs.push(performance.now() - t0); } xs.sort((a, b) => a - b); return Math.round(xs[n >> 1] * 100) / 100; };
const dec = new TextDecoder();
console.log(JSON.stringify({
  sha256AllMs: await t(async () => { for (const b of bufs) await crypto.subtle.digest("SHA-256", b); }),
  decodeAllMs: await t(async () => { for (const b of bufs) dec.decode(b); }),
  parseAppJsonMs: await t(async () => JSON.parse(dec.decode(bufs[2]))),
  bytes: bufs.map((b) => b.byteLength),
}));
