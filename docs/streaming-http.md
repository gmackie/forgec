# Streaming and binary HTTP

The Fetch HTTP boundary supports explicitly configured authenticated endpoints
alongside generated domain operations. Node and Workers return response streams
incrementally. The current Lambda/API Gateway host buffers responses and rejects
endpoints declaring `responseMode: "stream"`; it does not claim SSE or Lambda
response streaming support.

Configure `endpoints` on `createHttpHandler`, `createNodeHost`, `createWorker`, or
`createLambdaHandler`. Workers additionally accept `(env) => endpoints` to resolve
deployment bindings. An endpoint specifies its method, path, response mode,
optional `maxBodyBytes`, and Fetch handler:

```ts
import { sseResponse } from "@forgegraph/runtime";

const endpoints = [{
  method: "GET" as const,
  path: "/logs/{run}",
  responseMode: "stream" as const,
  async handle(request, { principal, params }) {
    // Application-owned lookup must authorize this run within principal.tenant.
    return sseResponse(signal => logs.follow({
      tenant: principal.tenant, actor: principal.actor,
      run: params.run, signal,
    }), { signal: request.signal });
  },
}];
```

These are host extension routes, not new `.forge` syntax or generated OpenAPI
operations. Do not overlap generated domain paths, signed webhooks, legacy
mounts, object URLs, health routes, or discovery routes. Endpoint matching is
method-specific and accepts named parameters within segments, such as
`/git/{owner}/{repo}.git`. Identical method/pattern bindings are rejected.
Authentication runs before endpoint path/method selection. The handler receives
the verified principal and a request ID; a path parameter is never authorization.
Methods outside the configured set return 405 after authentication. OPTIONS
continues through the existing CORS preflight boundary.

Request bodies are buffered as bytes up to `maxBodyBytes` (default 1 MiB). The
limit applies to actual consumed bytes, including chunked input, and oversized
bodies return 413 before the handler runs. Binary input is never decoded to text.
Large streaming uploads and Git pack ingestion are not provided by this bounded
input contract; a Git protocol implementation and its authorization remain
application work. Response streams are not buffered by the Fetch boundary.

`sseResponse` frames `data`, optional `event`/`id`, and optional nonnegative
integer `retry`. Multiline data becomes multiple data fields; control characters
in metadata cannot inject events. Each encoded event is limited to 1 MiB and
metadata fields to 256 characters. Its source is pulled on demand and receives
an AbortSignal. It must honor that signal when waiting for upstream work.
Client cancellation signals the producer and terminates the response, even if
the producer is waiting. Source cleanup is best-effort; JavaScript cannot force
an arbitrary iterator's pending operation to finish.

Node's response pipeline honors socket backpressure and cancels the response
body on disconnect. Request signals abort on premature disconnect. Shutdown
allows a grace period (`drainTimeoutMs`, default 5 seconds), then aborts active
requests and closes remaining HTTP connections. Errors after headers are sent
terminate the socket instead of appending a JSON problem to binary or SSE data.
Errors before streaming starts return a redacted problem response.

Workers use native Fetch streams. The Worker host wiring is tested against its
binding interface; this slice does not claim a new live Cloudflare certification.
Proxy/client buffering can still affect observed latency. SSE sets
`cache-control: no-cache, no-transform` and `x-accel-buffering: no`.

Lambda decodes base64 request bodies into bytes and base64-encodes binary
responses with `isBase64Encoded: true`. JSON, XML and `text/*` responses keep their
text representation. Buffered responses are capped at 4 MiB before base64
expansion. Endpoints must declare their response mode honestly; SSE responses
are also rejected at conversion time. Other unbounded streams cannot be
identified from a Response alone, so never label them buffered.

HTTP streaming does not itself provide log replay, event persistence, reconnect
deduplication or authorization refresh. Applications own those semantics; use
stable SSE IDs with a validated continuation policy when replay is required.
