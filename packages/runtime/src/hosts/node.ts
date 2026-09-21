/**
 * Node host (FORGE-035, plan §5.4): the same Effect runtime behind a
 * Fetch-compatible HTTP server, an in-process WebSocket realtime hub, a
 * periodic durable sweep (outbox, crashed workflows, schedules), readiness/
 * liveness probes, bounded concurrency with 503 on overflow, and graceful
 * drain: on `stop()` the listener closes, in-flight requests finish, the sweep
 * completes its current pass and pending timers are cancelled. Durable state
 * (outbox rows, workflow instances, schedule ledgers) lives in the store, so
 * a restart resumes acknowledged work instead of losing it.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { WebSocketServer, type WebSocket } from "ws";
import { R2ObjectStore } from "../adapters/r2.js";
import { FsBucket } from "../adapters/fs-objects.js";
import { createHttpHandler, devHeaderAuth, type AuthHost } from "../http.js";
import { SessionProtocol, upgradeAuthRequest, type EventFrame, type RealtimeHub } from "../realtime.js";
import { emfLine, workersLogLine, type OperationEvent } from "../telemetry.js";
import { OtlpSink, type OtlpOptions } from "../otlp.js";
import { composeRuntime, type ComposedRuntime, type RuntimeComposition } from "./compose.js";

export interface NodeHostOptions extends Omit<RuntimeComposition, "realtimeHub" | "telemetry" | "objects"> {
  /**
   * Authentication host. Required: the server refuses to start without one, so a deployment can never
   * silently trust caller-supplied identity headers. For local development set `FORGE_AUTH=dev-headers`
   * (or pass `devHeaderAuth()`) to trust `x-forge-tenant`/`x-forge-actor`.
   */
  auth?: AuthHost;
  /** Object storage: a directory (served by this host through signed URLs) or any object store adapter (S3, R2). */
  objects?: RuntimeComposition["objects"] | { directory: string };
  /** Public base URL used inside signed object URLs; defaults to the bound address. */
  publicUrl?: string;
  cors?: string[];
  /** Sweep period; 0 disables the loop (tests drive `sweepAll` themselves). */
  sweepIntervalMs?: number;
  maxInFlight?: number;
  /** "json" (Workers-Logs shaped lines) or "emf" (CloudWatch EMF) on stdout, "otlp" (OTLP/HTTP to `otlp.endpoint`); default json. */
  telemetryFormat?: "json" | "emf" | "silent" | "otlp";
  otlp?: Omit<OtlpOptions, "serviceName" | "boundaries"> & { serviceName?: string };
  telemetrySink?: (e: OperationEvent) => void;
}

export interface NodeHost {
  runtime: ComposedRuntime;
  server: Server;
  /** Bound address once listening. */
  address(): { port: number; url: string };
  listen(port?: number, host?: string): Promise<{ port: number; url: string }>;
  stop(): Promise<void>;
  ready: boolean;
}

/** Node request → Fetch Request. */
export function toFetchRequest(req: IncomingMessage, base: string): Request {
  const url = new URL(req.url ?? "/", base);
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) {
    if (v === undefined) continue;
    headers.set(k, Array.isArray(v) ? v.join(", ") : v);
  }
  const method = req.method ?? "GET";
  const body = method === "GET" || method === "HEAD" ? null : (Readable.toWeb(req) as unknown as ReadableStream);
  return new Request(url, { method, headers, body, ...(body ? { duplex: "half" } : {}) } as RequestInit);
}

export async function writeFetchResponse(res: ServerResponse, r: Response): Promise<void> {
  res.statusCode = r.status;
  r.headers.forEach((v, k) => res.setHeader(k, v));
  if (!r.body) return void res.end();
  for await (const chunk of r.body as unknown as AsyncIterable<Uint8Array>) res.write(chunk);
  res.end();
}

export function createNodeHost(options: NodeHostOptions): NodeHost {
  const sessions = new Map<WebSocket, { tenant: string; session: SessionProtocol }>();
  const hub: RealtimeHub = {
    async broadcast(tenant, channel, frame: EventFrame) {
      const text = JSON.stringify(frame);
      for (const [ws, s] of sessions) if (s.session.accepts(tenant, channel)) { try { ws.send(text); } catch { /* closing */ } }
    },
  };
  const format = options.telemetryFormat ?? "json";
  const otlp = format === "otlp" && options.otlp ? new OtlpSink({ ...options.otlp, serviceName: options.otlp.serviceName ?? `forge/${options.bundle.ir.package.name}`, boundaries: Object.fromEntries((options.bundle.observability?.operations ?? []).map((o) => [o.operation, o.histogramBoundariesMs])) }) : null;
  const sink = options.telemetrySink
    ? { write: options.telemetrySink }
    : otlp ? otlp : format === "silent" ? { write: () => undefined } : { write: (e: OperationEvent) => console.log(format === "emf" ? emfLine(e, `forge/${options.bundle.ir.package.name}`) : workersLogLine(e)) };
  // Signed object URLs must name the address clients reach; with `objects: { directory }` the host serves them itself.
  let publicUrl = options.publicUrl ?? "http://localhost";
  const fsStore = options.objects && "directory" in options.objects ? new R2ObjectStore(new FsBucket(options.objects.directory), { get baseUrl() { return publicUrl; }, secret: options.cursorSecret }) : null;
  const objects = fsStore ?? (options.objects as RuntimeComposition["objects"] | undefined);
  const { objects: _o, publicUrl: _p, ...composition } = options;
  void _o;
  void _p;
  const runtime = composeRuntime({ ...composition, ...(objects ? { objects } : {}), realtimeHub: hub, telemetry: { sink, target: "node-postgres" } });
  const auth = options.auth ?? (process.env["FORGE_AUTH"] === "dev-headers" ? devHeaderAuth() : null);
  if (!auth) {
    throw new Error(
      "createNodeHost: no authentication host configured. Pass `auth` (for example jwtAuth({ issuer, audience, secret, claims })), " +
        "or set FORGE_AUTH=dev-headers to trust x-forge-tenant/x-forge-actor headers — development only, never in a deployment.",
    );
  }
  if (auth.scheme === "dev-header") console.warn("forge: DEVELOPMENT AUTH ACTIVE — x-forge-tenant/x-forge-actor headers are trusted verbatim. Never run this configuration where untrusted callers can reach it.");
  const handler = createHttpHandler(runtime.model, runtime.engine, { auth, requestId: () => crypto.randomUUID(), ...(options.cors ? { cors: { origins: options.cors } } : {}) });
  const maxInFlight = options.maxInFlight ?? 256;
  let inFlight = 0;
  let stopping = false;
  const host: NodeHost = { runtime, server: undefined as unknown as Server, ready: false, address: () => bound!, listen, stop };
  let bound: { port: number; url: string } | null = null;
  let sweepTimer: NodeJS.Timeout | null = null;
  let sweeping: Promise<void> | null = null;
  const drained = new Set<() => void>();

  const server = createServer(async (req, res) => {
    const base = bound?.url ?? "http://localhost";
    const path = new URL(req.url ?? "/", base).pathname;
    if (path === "/healthz") return void res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ ok: true }));
    const obj = fsStore && /^\/_forge\/objects\/([^/]+)$/.exec(path);
    if (obj) {
      inFlight++;
      try {
        await writeFetchResponse(res, await fsStore.serve(toFetchRequest(req, base), obj[1]!));
      } finally {
        inFlight--;
        if (inFlight === 0) for (const f of drained) f();
      }
      return;
    }
    if (path === "/readyz") return void res.writeHead(host.ready && !stopping ? 200 : 503, { "content-type": "application/json" }).end(JSON.stringify({ ready: host.ready && !stopping, inFlight, telemetry: runtime.engine.telemetry.stats() }));
    if (stopping) return void res.writeHead(503, { connection: "close", "retry-after": "1" }).end();
    if (inFlight >= maxInFlight) return void res.writeHead(503, { "retry-after": "1", "content-type": "application/problem+json" }).end(JSON.stringify({ code: "Overloaded", status: 503, retryable: true }));
    inFlight++;
    try {
      const request = toFetchRequest(req, base);
      const response = await handler(request);
      await writeFetchResponse(res, response);
      // Prompt post-commit nudge; the periodic sweep is the guarantee.
      const tenant = request.headers.get("x-forge-tenant");
      if (tenant && request.method !== "GET" && response.status < 300) void runtime.sweep(tenant).catch(() => undefined);
    } catch (e) {
      if (!res.headersSent) res.writeHead(500, { "content-type": "application/problem+json" });
      res.end(JSON.stringify({ code: "Internal", status: 500, detail: String((e as Error).message ?? e) }));
    } finally {
      inFlight--;
      if (inFlight === 0) for (const f of drained) f();
    }
  });
  host.server = server;

  // Realtime: upgrade on a stream path, query-string auth, shared session protocol.
  const wss = new WebSocketServer({ noServer: true });
  server.on("upgrade", async (req, socket, head) => {
    const url = new URL(req.url ?? "/", bound?.url ?? "http://localhost");
    const stream = runtime.engine.realtime.streamByPath(url.pathname);
    if (!stream || stopping) return void socket.destroy();
    const headers = new Headers();
    for (const [k, v] of Object.entries(req.headers)) if (typeof v === "string") headers.set(k, v);
    const principal = await auth.authenticate(upgradeAuthRequest(url, headers));
    if (!("tenant" in principal)) return void socket.destroy();
    wss.handleUpgrade(req, socket, head, (ws) => {
      const session = new SessionProtocol(runtime.engine, principal.tenant);
      sessions.set(ws, { tenant: principal.tenant, session });
      ws.on("message", async (data) => {
        const replies = await session.handle(data.toString());
        for (const r of replies) ws.send(JSON.stringify(r));
      });
      ws.on("close", () => sessions.delete(ws));
    });
  });

  async function listen(port = 0, hostName = "127.0.0.1") {
    await new Promise<void>((resolve, reject) => server.once("error", reject).listen(port, hostName, () => resolve()));
    const a = server.address() as { port: number };
    bound = { port: a.port, url: `http://${hostName}:${a.port}` };
    if (!options.publicUrl) publicUrl = bound.url;
    host.ready = true;
    const period = options.sweepIntervalMs ?? 5_000;
    if (period > 0) {
      const tick = () => {
        if (stopping) return;
        sweeping = runtime.sweepAll().catch(() => undefined).finally(() => { sweeping = null; });
      };
      sweepTimer = setInterval(tick, period);
      sweepTimer.unref();
    }
    return bound;
  }

  async function stop() {
    stopping = true;
    host.ready = false;
    if (sweepTimer) clearInterval(sweepTimer);
    for (const ws of sessions.keys()) ws.close(1001, "shutting down");
    await new Promise<void>((resolve) => server.close(() => resolve()));
    if (inFlight > 0) await new Promise<void>((resolve) => drained.add(resolve));
    if (sweeping) await sweeping;
    if (otlp) await otlp.flush(); // drain telemetry with the requests
  }

  return host;
}
