/**
 * Resolved physical deployment plan (M18; PAR-151/154). One plan, derived
 * from the app bundle and the operator's choices, feeds every emitter (the
 * native wrangler/CDK adapters and the Terraform/self-hosted packs) so they
 * cannot disagree about which resources exist, how they are bound, who owns
 * them and where secrets come from. Adopted resources (an existing database
 * or bucket the customer supplies) are recorded as `adopted` with a
 * `retain` policy; nothing here ever emits a destroy for them.
 */
import type { AppBundle } from "@forgegraph/runtime";

export type TargetKind = "cloudflare" | "aws" | "self-hosted";
export type Ownership = "managed" | "adopted";

export interface ResourceSpec {
  id: string;
  kind: string;
  name: string;
  ownership: Ownership;
  /** Provider identifier for adopted resources (database id, bucket name, table ARN). */
  adoptId?: string;
  bindings: Record<string, string>;
  properties: Record<string, unknown>;
  /** Retain on destroy: always true for adopted and for authoritative data stores. */
  retain: boolean;
}

export interface SecretRef { name: string; env: string; source: "external-secret-store"; path: string }

export interface DeploymentPlan {
  version: "deployment-plan/1";
  target: TargetKind;
  app: string;
  stage: string;
  artifact: string;
  /** Exactly one IaC owner for the resources in this plan. */
  stateOwner: "native" | "terraform" | "self-hosted";
  resources: ResourceSpec[];
  secrets: SecretRef[];
  /** Migration jobs are separate from resource creation: applied by the deployment ledger, never by IaC. */
  migrations: { kind: "d1" | "postgres" | "dynamo"; job: string; digest: string }[];
}

export interface PlanOptions {
  target: TargetKind;
  stage: string;
  stateOwner: DeploymentPlan["stateOwner"];
  adopt?: { database?: string; bucket?: string; table?: string };
  secrets?: string[];
  secretStore?: { path: string };
}

const slug = (s: string) => s.replace(/^@/, "").replace(/[^a-z0-9]+/gi, "-").toLowerCase();

export function resolvePlan(bundle: AppBundle, o: PlanOptions): DeploymentPlan {
  const app = slug(bundle.ir.package.name);
  const name = (suffix: string) => `forge-${app}-${o.stage}-${suffix}`;
  const resources: ResourceSpec[] = [];
  const secrets: SecretRef[] = (o.secrets ?? ["FORGE_CURSOR_SECRET", "FORGE_JWT_SECRET"]).map((s) => ({ name: s, env: s, source: "external-secret-store", path: `${o.secretStore?.path ?? "forge"}/${app}/${o.stage}/${s}` }));
  const migrations: DeploymentPlan["migrations"] = [];
  const subs = (bundle.messaging?.subscriptions ?? []) as { name: string; queue: string }[];
  const workflows = (bundle.workflows?.workflows ?? []) as { name: string; cloudflare: { name: string; binding: string; className: string }; aws: { stateMachine: string; definition: unknown } }[];
  const schedules = (bundle.schedules?.schedules ?? []) as { name: string; aws: { expression: string; timezone: string }; cloudflare: { cron?: string } }[];
  const crons = (bundle.schedules?.cloudflareCrons ?? []) as string[];
  const hasRealtime = Boolean((bundle.realtime?.streams ?? []).length);

  if (o.target === "cloudflare") {
    resources.push({ id: "db", kind: "cloudflare_d1_database", name: name("db"), ownership: o.adopt?.database ? "adopted" : "managed", ...(o.adopt?.database ? { adoptId: o.adopt.database } : {}), bindings: { DB: "d1" }, properties: {}, retain: true });
    resources.push({ id: "blobs", kind: "cloudflare_r2_bucket", name: name("blobs"), ownership: o.adopt?.bucket ? "adopted" : "managed", ...(o.adopt?.bucket ? { adoptId: o.adopt.bucket } : {}), bindings: { BLOBS: "r2" }, properties: {}, retain: true });
    for (const s of subs) resources.push({ id: `queue-${s.name}`, kind: "cloudflare_queue", name: `${s.queue}-${o.stage}`, ownership: "managed", bindings: { [`Q_${s.name.replace(/-/g, "_").toUpperCase()}`]: "queue" }, properties: { maxBatchSize: 10, maxRetries: 5, deadLetterQueue: name("dlq") }, retain: false });
    resources.push({ id: "dlq", kind: "cloudflare_queue", name: name("dlq"), ownership: "managed", bindings: {}, properties: {}, retain: true });
    for (const w of workflows) resources.push({ id: `workflow-${w.name}`, kind: "cloudflare_workflow", name: `${w.cloudflare.name}-${o.stage}`, ownership: "managed", bindings: { [w.cloudflare.binding]: "workflow" }, properties: { className: w.cloudflare.className }, retain: false });
    if (hasRealtime) resources.push({ id: "realtime", kind: "cloudflare_durable_object", name: name("realtime"), ownership: "managed", bindings: { REALTIME: "durable_object" }, properties: { className: (bundle.realtime as { cloudflare: { className: string } }).cloudflare.className }, retain: false });
    resources.push({ id: "worker", kind: "cloudflare_workers_script", name: name("api"), ownership: "managed", bindings: {}, properties: { crons: ["*/5 * * * *", ...crons], compatibilityDate: "2026-09-01" }, retain: false });
    migrations.push({ kind: "d1", job: name("migrate"), digest: bundle.buildHash });
  } else if (o.target === "aws") {
    resources.push({ id: "table", kind: "aws_dynamodb_table", name: name("data"), ownership: o.adopt?.table ? "adopted" : "managed", ...(o.adopt?.table ? { adoptId: o.adopt.table } : {}), bindings: { TABLE: "dynamodb" }, properties: { billing: "PAY_PER_REQUEST", pointInTimeRecovery: true }, retain: true });
    resources.push({ id: "blobs", kind: "aws_s3_bucket", name: name("blobs"), ownership: o.adopt?.bucket ? "adopted" : "managed", ...(o.adopt?.bucket ? { adoptId: o.adopt.bucket } : {}), bindings: { BUCKET: "s3" }, properties: { versioning: true, encryption: "AES256", blockPublicAccess: true }, retain: true });
    resources.push({ id: "dlq", kind: "aws_sqs_queue", name: name("dlq"), ownership: "managed", bindings: {}, properties: { retentionSeconds: 1209600 }, retain: true });
    for (const s of subs) resources.push({ id: `queue-${s.name}`, kind: "aws_sqs_queue", name: `${s.queue}-${o.stage}`, ownership: "managed", bindings: { [`QUEUE_${s.name.replace(/-/g, "_").toUpperCase()}`]: "sqs" }, properties: { visibilityTimeout: 60, deadLetter: name("dlq"), maxReceiveCount: 5 }, retain: false });
    resources.push({ id: "api", kind: "aws_lambda_function", name: name("api"), ownership: "managed", bindings: {}, properties: { runtime: "nodejs22.x", handler: "index.handler", memory: 1024, timeout: 30 }, retain: false });
    for (const w of workflows) resources.push({ id: `workflow-${w.name}`, kind: "aws_sfn_state_machine", name: `${w.aws.stateMachine}-${o.stage}`, ownership: "managed", bindings: { [`SFN_${w.name.toUpperCase()}`]: "sfn" }, properties: { type: "STANDARD", definition: w.aws.definition }, retain: false });
    for (const s of schedules) resources.push({ id: `schedule-${s.name}`, kind: "aws_scheduler_schedule", name: name(`schedule-${slug(s.name)}`), ownership: "managed", bindings: {}, properties: { expression: s.aws.expression, timezone: s.aws.timezone }, retain: false });
    resources.push({ id: "sweep", kind: "aws_scheduler_schedule", name: name("sweep"), ownership: "managed", bindings: {}, properties: { expression: "rate(5 minutes)", timezone: "UTC" }, retain: false });
    resources.push({ id: "http", kind: "aws_apigatewayv2_api", name: name("http"), ownership: "managed", bindings: {}, properties: { protocol: "HTTP" }, retain: false });
    if (hasRealtime) resources.push({ id: "ws", kind: "aws_apigatewayv2_api", name: name("ws"), ownership: "managed", bindings: {}, properties: { protocol: "WEBSOCKET", routes: ["$connect", "$disconnect", "$default"] }, retain: false });
    migrations.push({ kind: "dynamo", job: name("migrate"), digest: bundle.buildHash });
  } else {
    resources.push({ id: "db", kind: "postgres_database", name: name("db"), ownership: o.adopt?.database ? "adopted" : "managed", ...(o.adopt?.database ? { adoptId: o.adopt.database } : {}), bindings: { FORGE_PG_URL: "postgres" }, properties: { serializable: true }, retain: true });
    resources.push({ id: "blobs", kind: "object_store", name: name("blobs"), ownership: o.adopt?.bucket ? "adopted" : "managed", ...(o.adopt?.bucket ? { adoptId: o.adopt.bucket } : {}), bindings: { FORGE_OBJECTS: "s3-compatible-or-directory" }, properties: {}, retain: true });
    resources.push({ id: "api", kind: "container", name: name("api"), ownership: "managed", bindings: {}, properties: { image: `forge-${app}:${bundle.buildHash.slice(0, 12)}`, role: "api", port: 8080 }, retain: false });
    resources.push({ id: "worker", kind: "container", name: name("worker"), ownership: "managed", bindings: {}, properties: { image: `forge-${app}:${bundle.buildHash.slice(0, 12)}`, role: "worker" }, retain: false });
    migrations.push({ kind: "postgres", job: name("migrate"), digest: bundle.buildHash });
  }
  return { version: "deployment-plan/1", target: o.target, app, stage: o.stage, artifact: bundle.buildHash, stateOwner: o.stateOwner, resources, secrets, migrations };
}

/** Which resources a destroy may touch: adopted and retained resources need explicit, per-resource approval (PAR-154). */
export function destroyPlan(plan: DeploymentPlan, o: { approveDestroy?: string[] } = {}): { destroy: string[]; retained: { id: string; reason: string }[] } {
  const destroy: string[] = [];
  const retained: { id: string; reason: string }[] = [];
  for (const r of plan.resources) {
    const approved = o.approveDestroy?.includes(r.id) ?? false;
    if (r.ownership === "adopted" && !approved) retained.push({ id: r.id, reason: `adopted from the customer (${r.adoptId ?? "external"}); externally owned resources are never destroyed without explicit approval` });
    else if (r.retain && !approved) retained.push({ id: r.id, reason: "authoritative data store; retained unless explicitly approved for destruction" });
    else destroy.push(r.id);
  }
  return { destroy, retained };
}
