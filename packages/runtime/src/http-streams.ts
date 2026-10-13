/** Demand-driven SSE framing for Fetch hosts. Source must honor its cancellation signal. */
export interface ServerSentEvent { data: string; event?: string; id?: string; retry?: number }

export function sseResponse(source: (signal: AbortSignal) => AsyncIterable<ServerSentEvent>, options: { signal?: AbortSignal } = {}): Response {
  const abort = new AbortController();
  if (options.signal?.aborted) abort.abort();
  const iterator = source(abort.signal)[Symbol.asyncIterator]();
  const encoder = new TextEncoder();
  let ended = false;
  let controller: ReadableStreamDefaultController<Uint8Array>;
  const cleanup = () => options.signal?.removeEventListener("abort", cancelled);
  const cancelSource = () => {
    abort.abort();
    try { void iterator.return?.().catch(() => {}); } catch { /* Cleanup cannot replace stream termination. */ }
  };
  const cancelled = () => {
    if (ended) return;
    ended = true; cleanup(); cancelSource();
    controller.error(new DOMException("SSE request aborted", "AbortError"));
  };
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
      if (options.signal?.aborted) cancelled();
      else options.signal?.addEventListener("abort", cancelled, { once: true });
    },
    async pull(c) {
      try {
        const next = await iterator.next();
        if (ended) return;
        if (next.done) { ended = true; cleanup(); c.close(); return; }
        const event = next.value;
        if (typeof event.data !== "string" || event.data.length > 1_048_576 || [event.id, event.event].some(v => v !== undefined && (typeof v !== "string" || v.length > 256 || /[\r\n\0]/.test(v))) || (event.retry !== undefined && (!Number.isSafeInteger(event.retry) || event.retry < 0))) throw new Error("invalid SSE event");
        const frame = (event.event !== undefined ? `event: ${event.event}\n` : "") + (event.id !== undefined ? `id: ${event.id}\n` : "") + (event.retry !== undefined ? `retry: ${event.retry}\n` : "") + event.data.replace(/\r\n?/g, "\n").split("\n").map(line => `data: ${line}\n`).join("") + "\n";
        const bytes = encoder.encode(frame);
        if (bytes.byteLength > 1_048_576) throw new Error("SSE event exceeds 1 MiB");
        c.enqueue(bytes);
      } catch {
        if (ended) return;
        ended = true; cleanup(); cancelSource(); c.error(new Error("SSE stream failed"));
      }
    },
    cancel() { if (!ended) { ended = true; cleanup(); cancelSource(); } },
  }, { highWaterMark: 0 });
  return new Response(stream, { headers: { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache, no-transform", "x-accel-buffering": "no" } });
}
