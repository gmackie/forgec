/** AWS Lambda host (API Gateway HTTP API v2 payload -> Fetch Request -> Response -> v2 result). */
import { Layer } from "effect";
import { DynamoStorage } from "../adapters/dynamodb.js";
import { S3ObjectStore } from "../adapters/s3.js";
import { MemoryObjectStore } from "../adapters/memory-objects.js";
import { Engine } from "../engine.js";
import { createHttpHandler, devHeaderAuth, type AuthHost } from "../http.js";
import { Model, type AppBundle } from "../model.js";
import { Clock, CursorSecret, IdGen, Objects, Storage } from "../services.js";
import { productionIds } from "./ids.js";

export interface ApiGatewayV2Event {
  rawPath: string;
  rawQueryString?: string;
  headers?: Record<string, string | undefined>;
  requestContext: { http: { method: string }; requestId: string; domainName?: string };
  body?: string;
  isBase64Encoded?: boolean;
}
export interface ApiGatewayV2Result {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
}

export function toRequest(ev: ApiGatewayV2Event): Request {
  const host = ev.requestContext.domainName ?? "lambda";
  const url = `https://${host}${ev.rawPath}${ev.rawQueryString ? `?${ev.rawQueryString}` : ""}`;
  const headers = new Headers();
  for (const [k, v] of Object.entries(ev.headers ?? {})) if (v !== undefined) headers.set(k, v);
  const body = ev.body === undefined ? null : ev.isBase64Encoded ? Buffer.from(ev.body, "base64").toString("utf8") : ev.body;
  const method = ev.requestContext.http.method;
  return new Request(url, { method, headers, body: method === "GET" || method === "HEAD" ? null : body });
}

export async function toResult(res: Response): Promise<ApiGatewayV2Result> {
  const headers: Record<string, string> = {};
  res.headers.forEach((v, k) => (headers[k] = v));
  return { statusCode: res.status, headers, body: await res.text() };
}

export interface LambdaEnv {
  FORGE_TABLE: string;
  FORGE_BUCKET?: string;
  AWS_REGION?: string;
  CURSOR_SECRET: string;
  FORGE_AUTH?: string;
  FORGE_CORS?: string;
}

export function createLambdaHandler(bundle: AppBundle, options: { auth?: AuthHost; env?: LambdaEnv } = {}) {
  const model = new Model(bundle);
  const env = options.env ?? (process.env as unknown as LambdaEnv);
  const auth = options.auth ?? (env.FORGE_AUTH === "dev-headers" ? devHeaderAuth() : null);
  // Process-level clients are reused across invocations; tenant/request context is per call (plan §8).
  const storage = new DynamoStorage({ table: env.FORGE_TABLE, region: env.AWS_REGION ?? "us-east-1" }, model);
  const layer = Layer.mergeAll(
    Layer.succeed(Clock)({ now: () => new Date().toISOString() }),
    Layer.succeed(IdGen)(productionIds()),
    Layer.succeed(Storage)(storage),
    Layer.succeed(CursorSecret)({ key: env.CURSOR_SECRET }),
    Layer.succeed(Objects)(env.FORGE_BUCKET ? new S3ObjectStore(env.FORGE_BUCKET, env.AWS_REGION ?? "us-east-1") : new MemoryObjectStore()),
  );
  const engine = new Engine(model, layer);
  const handler = auth ? createHttpHandler(model, engine, { auth, requestId: () => crypto.randomUUID(), ...(env.FORGE_CORS ? { cors: { origins: env.FORGE_CORS.split(",") } } : {}) }) : null;
  return async (ev: ApiGatewayV2Event): Promise<ApiGatewayV2Result> => {
    if (!handler) return { statusCode: 401, headers: { "content-type": "application/problem+json" }, body: JSON.stringify({ code: "Unauthenticated", detail: "no authentication host configured" }) };
    const res = await handler(toRequest(ev));
    const out = await toResult(res);
    out.headers["x-request-id"] = ev.requestContext.requestId;
    return out;
  };
}
