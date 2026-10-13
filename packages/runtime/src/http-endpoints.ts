/** Explicit authenticated Fetch extensions; domain operations remain compiler-owned. */
import type { Principal } from "./http.js";
import { err } from "./errors.js";

export interface HttpEndpointContext {
  principal: Principal;
  requestId: string;
  params: Record<string, string>;
}
export interface HttpEndpoint {
  method: "GET" | "HEAD" | "POST" | "PUT" | "PATCH" | "DELETE";
  /** Concrete path with named parameters, including /git/{owner}/{repo}.git. */
  path: string;
  /** Buffered/bounded binary input; default 1 MiB. Response streams are never buffered here. */
  maxBodyBytes?: number;
  /** Required for live streams; lets buffered hosts fail explicitly during configuration. */
  responseMode: "buffered" | "stream";
  handle(request: Request, context: HttpEndpointContext): Promise<Response>;
}

export function compileEndpoints(endpoints: HttpEndpoint[]) {
  const keys = new Set<string>();
  return endpoints.map(endpoint => {
    if (!/^(GET|HEAD|POST|PUT|PATCH|DELETE)$/.test(endpoint.method) || !["buffered", "stream"].includes(endpoint.responseMode)) throw new Error("invalid HTTP endpoint method or response mode");
    if (!endpoint.path.startsWith("/") || endpoint.path.includes("//") || /[?#\\\s]/.test(endpoint.path)) throw new Error("invalid HTTP endpoint path");
    const names: string[] = [];
    const parts = endpoint.path.split(/(\{[^{}]*\})/);
    const pattern = parts.map(part => {
      if (part.startsWith("{")) {
        const name = part.slice(1, -1);
        if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(name) || names.includes(name)) throw new Error("invalid or duplicate HTTP endpoint parameter");
        names.push(name); return "([^/]+)";
      }
      if (/[{}]/.test(part)) throw new Error("invalid HTTP endpoint parameter");
      return part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    }).join("");
    const key = endpoint.method + pattern;
    if (keys.has(key)) throw new Error("duplicate HTTP endpoint route");
    keys.add(key);
    const limit = endpoint.maxBodyBytes ?? 1_048_576;
    if (!Number.isSafeInteger(limit) || limit <= 0) throw new Error("endpoint maxBodyBytes must be a positive safe integer");
    return { endpoint, regex: new RegExp(`^${pattern}$`), names, limit };
  });
}

/** Consume bytes once, preserving binary data and rejecting before handler side effects. */
export async function endpointRequest(request: Request, limit: number): Promise<Request> {
  if (!request.body) return request;
  const tooLarge = () => err("PayloadTooLarge", "endpoint body exceeds configured limit");
  const declared = request.headers.get("content-length");
  if (declared && Number(declared) > limit) {
    void request.body.cancel().catch(() => {}); throw tooLarge();
  }
  const reader = request.body.getReader();
  let size = 0;
  const chunks: Uint8Array[] = [];
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) { void reader.cancel().catch(() => {}); throw tooLarge(); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.byteLength; }
  return new Request(request.url, { method: request.method, headers: request.headers, body, signal: request.signal });
}
