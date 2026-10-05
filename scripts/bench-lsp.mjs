#!/usr/bin/env node
// Synthetic end-to-end LSP latency over framed stdio. No changes to repository files.
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';

const count = Number(process.env.FORGE_BENCH_FILES ?? 500);
const samples = Number(process.env.FORGE_BENCH_SAMPLES ?? 30);
if (!Number.isSafeInteger(count) || count < 1 || !Number.isSafeInteger(samples) || samples < 1) {
  throw new Error('FORGE_BENCH_FILES and FORGE_BENCH_SAMPLES must be positive integers');
}
const root = await mkdtemp(join(tmpdir(), 'forge-lsp-bench-'));
let child;
const pending = new Map();
try {
  await mkdir(join(root, 'src'));
  await writeFile(join(root, 'forge.toml'), '[package]\nname = "@bench/lsp"\nversion = "0.1.0"\n');
  const source = (i, type = 'integer') => `resource R${i} {\n id : id\n value : ${type}\n}\n`;
  await Promise.all(Array.from({ length: count }, (_, i) => writeFile(join(root, 'src', `r${i}.forge`), source(i))));
  child = spawn(process.env.FORGEC ?? resolve('target/debug/forgec'), ['lsp'], { stdio: ['pipe', 'pipe', 'inherit'] });
  const fail = error => {
    for (const { reject, timer } of pending.values()) { clearTimeout(timer); reject(error); }
    pending.clear();
  };
  child.on('error', fail);
  child.on('exit', (code, signal) => fail(new Error(`LSP exited: ${code ?? signal}`)));
  let buffer = Buffer.alloc(0);
  child.stdout.on('data', chunk => {
    buffer = Buffer.concat([buffer, chunk]);
    for (;;) {
      const split = buffer.indexOf('\r\n\r\n');
      if (split < 0) return;
      const length = Number(/Content-Length: (\d+)/i.exec(buffer.subarray(0, split).toString())?.[1]);
      if (!Number.isSafeInteger(length)) { fail(new Error('invalid LSP framing')); return; }
      if (buffer.length < split + 4 + length) return;
      const message = JSON.parse(buffer.subarray(split + 4, split + 4 + length).toString());
      buffer = buffer.subarray(split + 4 + length);
      const request = pending.get(message.id);
      if (request) {
        pending.delete(message.id);
        clearTimeout(request.timer);
        if (message.error) request.reject(new Error(JSON.stringify(message.error)));
        else request.resolve(message.result);
      }
    }
  });
  let nextId = 1;
  const send = (method, params, id) => {
    const body = JSON.stringify({ jsonrpc: '2.0', ...(id === undefined ? {} : { id }), method, params });
    child.stdin.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
  };
  const request = (method, params) => new Promise((resolve, reject) => {
    const id = nextId++;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`${method} timed out`)); }, 30_000);
    pending.set(id, { resolve, reject, timer });
    send(method, params, id);
  });
  await request('initialize', { rootUri: pathToFileURL(root).href, capabilities: {} });
  const uri = pathToFileURL(join(root, 'src', 'r0.forge')).href;
  const hover = () => request('textDocument/hover', { textDocument: { uri }, position: { line: 0, character: 10 } });
  let started = performance.now();
  send('textDocument/didOpen', { textDocument: { uri, languageId: 'forge', version: 1, text: source(0) } });
  await hover(); // ordered behind didOpen, includes its diagnostics work
  const coldMs = performance.now() - started;
  const warm = [], edited = [];
  for (let i = 0; i < samples; i++) {
    started = performance.now();
    await hover();
    warm.push(performance.now() - started);
    started = performance.now();
    send('textDocument/didChange', { textDocument: { uri, version: i + 2 }, contentChanges: [{ text: source(0, i % 2 === 0 ? 'text' : 'integer') }] });
    await hover(); // includes edit analysis and diagnostic publication
    edited.push(performance.now() - started);
  }
  const summarize = values => {
    const sorted = [...values].sort((a, b) => a - b);
    return { p50Ms: sorted[Math.ceil(sorted.length * .5) - 1], p95Ms: sorted[Math.ceil(sorted.length * .95) - 1], maxMs: sorted.at(-1) };
  };
  const stats = await request('forge/analysisStats', {});
  console.log(JSON.stringify({ files: count, samples, coldMs, warmHover: summarize(warm), editedThenHover: summarize(edited), stats }, null, 2));
  await request('shutdown', null);
  send('exit', null);
} finally {
  child?.kill();
  for (const { timer } of pending.values()) clearTimeout(timer);
  await rm(root, { recursive: true, force: true });
}
