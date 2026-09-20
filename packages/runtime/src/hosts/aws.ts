/** AWS Lambda host (API Gateway HTTP API v2 payload -> Fetch Request -> Response -> v2 result). */
import { Effect, Layer } from "effect";
import { DynamoStorage } from "../adapters/dynamodb.js";
import { S3ObjectStore } from "../adapters/s3.js";
import { MemoryObjectStore } from "../adapters/memory-objects.js";
import { Engine } from "../engine.js";
import { createHttpHandler, devHeaderAuth, type AuthHost } from "../http.js";
import { Model, type AppBundle } from "../model.js";
import { Dispatcher } from "../dispatch.js";
import { internalSubscriptions, withProjections } from "../readmodels.js";
import { SendTaskSuccessCommand, SFNClient, StartExecutionCommand } from "@aws-sdk/client-sfn";
import type { WorkflowDriver } from "../workflows.js";
import { decodeEnvelope, sqsTransport } from "../transports.js";
import type { EngineOptions } from "../engine.js";
import { SendMessageCommand, SQSClient } from "@aws-sdk/client-sqs";
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
  /** JSON map: subscription name -> SQS queue URL. */
  FORGE_QUEUES?: string;
  /** JSON map: workflow name -> Step Functions state machine ARN. */
  FORGE_WORKFLOWS?: string;
}

export interface LambdaOptions extends EngineOptions {
  auth?: AuthHost;
  env?: LambdaEnv;
}

/** One handler for API Gateway requests, SQS batches (consumer) and EventBridge schedules (sweep). */
export function createLambdaHandler(bundle: AppBundle, options: LambdaOptions = {}) {
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
  const engine = new Engine(model, layer, options);
  const queues: Record<string, string> = env.FORGE_QUEUES ? (JSON.parse(env.FORGE_QUEUES) as Record<string, string>) : {};
  const sqs = new SQSClient({ region: env.AWS_REGION ?? "us-east-1" });
  const machines: Record<string, string> = env.FORGE_WORKFLOWS ? (JSON.parse(env.FORGE_WORKFLOWS) as Record<string, string>) : {};
  const sfn = new SFNClient({ region: env.AWS_REGION ?? "us-east-1" });
  // Step Functions Standard drives instances: Wait states for sleeps, callback task tokens for waits.
  const driver: WorkflowDriver = {
    async started(tenant, wf, id) {
      const arn = machines[wf.name];
      if (!arn) return;
      await sfn.send(new StartExecutionCommand({ stateMachineArn: arn, name: `${tenant}-${id}`.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 80), input: JSON.stringify({ tenant, id }) }));
    },
    async wake(tenant, _wf, inst) {
      const token = inst.driver?.["taskToken"] as string | undefined;
      if (!token) return;
      await sfn.send(new SendTaskSuccessCommand({ taskToken: token, output: JSON.stringify({ woke: true }) })).catch(() => undefined);
      await Effect.runPromise(engine.workflows.setDriverState(tenant, inst.id, { taskToken: null }).pipe(Effect.provide(layer))).catch(() => undefined);
    },
  };
  engine.workflows.driver = driver;
  const subscriptions: Record<string, string[]> = {};
  for (const s of model.bundle.messaging?.subscriptions ?? []) (subscriptions[s.channel] ??= []).push(s.name);
  const dispatcher = new Dispatcher(model, storage, withProjections(engine, sqsTransport({ send: async (url, body, dedup) => void (await sqs.send(new SendMessageCommand({ QueueUrl: url, MessageBody: body, MessageAttributes: { messageId: { DataType: "String", StringValue: dedup } } }))) }, queues)), { subscriptions: internalSubscriptions(engine, subscriptions), leaseMs: 30_000, maxAttempts: 8 });
  const handler = auth ? createHttpHandler(model, engine, { auth, requestId: () => crypto.randomUUID(), ...(env.FORGE_CORS ? { cors: { origins: env.FORGE_CORS.split(",") } } : {}) }) : null;

  return async (ev: ApiGatewayV2Event | SqsEvent | ScheduledEvent | WorkflowDriverEvent | ScheduleTickEvent): Promise<ApiGatewayV2Result | SqsBatchResponse | WorkflowDriverResult | void> => {
    if ("forge" in ev && ev.forge === "workflow.advance") {
      const st = await Effect.runPromise(engine.workflows.advance(ev.tenant, ev.id).pipe(Effect.provide(layer)));
      const dueAt = ((st["sleeping"] as { dueAt?: string } | undefined)?.dueAt ?? (st["waiting"] as { dueAt?: string } | undefined)?.dueAt) as string | undefined;
      // Step Functions needs a numeric timeout for the callback wait; a wait without a deadline gets a year.
      const timeoutSeconds = dueAt ? Math.max(1, Math.ceil((Date.parse(dueAt) - Date.now()) / 1000)) : 365 * 24 * 3600;
      return { status: st["status"] as string, dueAt: dueAt ?? new Date(Date.now() + 1000).toISOString(), timeoutSeconds };
    }
    if ("forge" in ev && ev.forge === "workflow.wait") {
      // Park the callback token; a signal consumed after this point wakes the execution immediately.
      await Effect.runPromise(engine.workflows.setDriverState(ev.tenant, ev.id, { taskToken: ev.taskToken }).pipe(Effect.provide(layer)));
      // Re-check after parking: a signal consumed in between would have found no token to wake.
      const inst = await Effect.runPromise(engine.workflows.load(ev.tenant, ev.id).pipe(Effect.provide(layer)));
      if (inst.status !== "waiting") await driver.wake(ev.tenant, model.workflows.find((w) => w.id === inst.workflow)!, inst);
      return;
    }
    if ("Records" in ev) {
      const failures: { itemIdentifier: string }[] = [];
      for (const r of ev.Records) {
        // Queue URLs are authoritative (deployments may suffix physical names with a stage).
        const arnName = r.eventSourceARN.split(":").pop() ?? "";
        const sub = (model.bundle.messaging?.subscriptions ?? []).find((s) => queues[s.name]?.endsWith(`/${arnName}`) || arnName === s.queue);
        if (!sub) continue;
        try {
          await engine.consume(sub.name, decodeEnvelope(r.body));
        } catch (e) {
          console.error("forge: consumer failed", sub.name, e);
          failures.push({ itemIdentifier: r.messageId });
        }
      }
      return { batchItemFailures: failures };
    }
    if ("forge" in ev && ev.forge === "schedule.tick") {
      // EventBridge delivers the intended instant in `time`; the ledger decides what is due.
      const tenants = await Effect.runPromise(storage.outboxTenants());
      const now = new Date((ev as { time?: string }).time ?? Date.now()).toISOString();
      await Promise.all(tenants.map((t: string) => Effect.runPromise(engine.schedules.tick(t, now))));
      return;
    }
    if ("source" in ev && ev.source === "aws.events") {
      const tenants = await Effect.runPromise(storage.outboxTenants());
      await Promise.all(tenants.map((t: string) => Effect.runPromise(dispatcher.sweep(t, { now: Date.now() }))));
      await Promise.all(tenants.map((t: string) => Effect.runPromise(engine.workflows.sweep(t))));
      return;
    }
    const apiEv = ev as ApiGatewayV2Event;
    if (!handler) return { statusCode: 401, headers: { "content-type": "application/problem+json" }, body: JSON.stringify({ code: "Unauthenticated", detail: "no authentication host configured" }) };
    const res = await handler(toRequest(apiEv));
    const out = await toResult(res);
    out.headers["x-request-id"] = apiEv.requestContext.requestId;
    // Prompt nudge; the EventBridge sweep is the guarantee.
    const tenant = apiEv.headers?.["x-forge-tenant"];
    if (tenant && apiEv.requestContext.http.method !== "GET" && res.status < 300) {
      await Effect.runPromise(dispatcher.sweep(tenant, { now: Date.now() })).catch(() => undefined);
    }
    return out;
  };
}

export interface ScheduleTickEvent {
  forge: "schedule.tick";
  source?: string;
  /** Intended occurrence instant (EventBridge `time`, or `<aws.scheduler.scheduled-time>`). */
  time?: string;
}
export interface WorkflowDriverEvent {
  forge: "workflow.advance" | "workflow.wait";
  tenant: string;
  id: string;
  taskToken?: string;
}
export interface WorkflowDriverResult {
  status: string;
  dueAt: string;
  timeoutSeconds: number;
}
export interface SqsEvent {
  Records: { messageId: string; body: string; eventSourceARN: string }[];
}
export interface SqsBatchResponse {
  batchItemFailures: { itemIdentifier: string }[];
}
export interface ScheduledEvent {
  source: string;
}
