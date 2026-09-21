/**
 * Terraform physical-plan emitter (FORGE-074; PAR-151/154). Emits pinned
 * `.tf.json` from a resolved deployment plan: one file per concern (providers,
 * resources, secrets as `sensitive` variables that only *reference* an
 * external store, adopted resources as `import` blocks with
 * `prevent_destroy`, and a separate migration job the deployment ledger
 * drives). The plan is the single source of truth: the native projection
 * (`nativeProjection`) and the Terraform projection are compared resource by
 * resource so the same requirements are satisfied by exactly one state owner.
 */
import type { DeploymentPlan, ResourceSpec } from "./deployment-plan.js";

export const PROVIDER_VERSIONS = { cloudflare: "5.4.0", aws: "5.100.0", null: "3.2.4" } as const;

type Json = Record<string, unknown>;

function tfName(id: string): string {
  return id.replace(/[^A-Za-z0-9_]/g, "_");
}

function resourceBlock(plan: DeploymentPlan, r: ResourceSpec): { type: string; name: string; body: Json } | null {
  const lifecycle = r.retain || r.ownership === "adopted" ? { lifecycle: { prevent_destroy: true } } : {};
  const p = r.properties;
  switch (r.kind) {
    case "cloudflare_d1_database":
      return { type: "cloudflare_d1_database", name: tfName(r.id), body: { account_id: "${var.cloudflare_account_id}", name: r.name, ...lifecycle } };
    case "cloudflare_r2_bucket":
      return { type: "cloudflare_r2_bucket", name: tfName(r.id), body: { account_id: "${var.cloudflare_account_id}", name: r.name, ...lifecycle } };
    case "cloudflare_queue":
      return { type: "cloudflare_queue", name: tfName(r.id), body: { account_id: "${var.cloudflare_account_id}", queue_name: r.name, ...lifecycle } };
    case "cloudflare_workers_script": {
      const bindings: Json[] = [];
      for (const res of plan.resources) {
        for (const [binding, kind] of Object.entries(res.bindings)) {
          if (kind === "d1") bindings.push({ type: "d1", name: binding, id: `\${cloudflare_d1_database.${tfName(res.id)}.id}` });
          if (kind === "r2") bindings.push({ type: "r2_bucket", name: binding, bucket_name: res.name });
          if (kind === "queue") bindings.push({ type: "queue", name: binding, queue_name: res.name });
          // provider 5.4.0 has no `workflow` binding type: workflows are reported as unsupported by this pack (see emitTerraform)
          if (kind === "durable_object") bindings.push({ type: "durable_object_namespace", name: binding, class_name: String(res.properties["className"]) });
        }
      }
      for (const s of plan.secrets) bindings.push({ type: "secret_text", name: s.env, text: `\${var.${s.env.toLowerCase()}}` });
      const doClasses = plan.resources.filter((x) => x.kind === "cloudflare_durable_object").map((x) => String(x.properties["className"]));
      return { type: "cloudflare_workers_script", name: tfName(r.id), body: { account_id: "${var.cloudflare_account_id}", script_name: r.name, content: "${file(\"${path.module}/dist/worker.js\")}", compatibility_date: p["compatibilityDate"], main_module: "worker.js", bindings, ...(doClasses.length ? { migrations: { new_tag: "v1", new_sqlite_classes: doClasses } } : {}) } };
    }
    case "cloudflare_workflow":
    case "cloudflare_durable_object":
      return null; // declared through the worker's bindings and migrations, not standalone resources
    case "aws_dynamodb_table":
      return { type: "aws_dynamodb_table", name: tfName(r.id), body: { name: r.name, billing_mode: p["billing"], hash_key: "pk", range_key: "sk", attribute: [{ name: "pk", type: "S" }, { name: "sk", type: "S" }], point_in_time_recovery: { enabled: p["pointInTimeRecovery"] }, ...lifecycle } };
    case "aws_s3_bucket":
      return { type: "aws_s3_bucket", name: tfName(r.id), body: { bucket: r.name, ...lifecycle } };
    case "aws_sqs_queue":
      return { type: "aws_sqs_queue", name: tfName(r.id), body: { name: r.name, ...(p["retentionSeconds"] ? { message_retention_seconds: p["retentionSeconds"] } : {}), ...(p["visibilityTimeout"] ? { visibility_timeout_seconds: p["visibilityTimeout"], redrive_policy: `\${jsonencode({ deadLetterTargetArn = aws_sqs_queue.dlq.arn, maxReceiveCount = ${String(p["maxReceiveCount"])} })}` } : {}), ...lifecycle } };
    case "aws_lambda_function": {
      const env: Json = {};
      for (const res of plan.resources) for (const [binding, kind] of Object.entries(res.bindings)) if (kind === "dynamodb" || kind === "s3" || kind === "sqs" || kind === "sfn") env[binding] = kind === "dynamodb" ? `\${aws_dynamodb_table.${tfName(res.id)}.name}` : kind === "s3" ? `\${aws_s3_bucket.${tfName(res.id)}.bucket}` : kind === "sqs" ? `\${aws_sqs_queue.${tfName(res.id)}.url}` : `\${aws_sfn_state_machine.${tfName(res.id)}.arn}`;
      for (const s of plan.secrets) env[s.env] = `\${var.${s.env.toLowerCase()}}`;
      return { type: "aws_lambda_function", name: tfName(r.id), body: { function_name: r.name, runtime: p["runtime"], handler: p["handler"], memory_size: p["memory"], timeout: p["timeout"], filename: "${path.module}/dist/lambda.zip", role: "${aws_iam_role.api.arn}", environment: { variables: env } } };
    }
    case "aws_sfn_state_machine":
      return { type: "aws_sfn_state_machine", name: tfName(r.id), body: { name: r.name, role_arn: "${aws_iam_role.api.arn}", type: p["type"], definition: `\${file("\${path.module}/${r.id}.asl.json")}` } };
    case "aws_scheduler_schedule":
      return { type: "aws_scheduler_schedule", name: tfName(r.id), body: { name: r.name, schedule_expression: p["expression"], schedule_expression_timezone: p["timezone"], flexible_time_window: { mode: "OFF" }, target: { arn: "${aws_lambda_function.api.arn}", role_arn: "${aws_iam_role.api.arn}" } } };
    case "aws_apigatewayv2_api":
      return { type: "aws_apigatewayv2_api", name: tfName(r.id), body: { name: r.name, protocol_type: p["protocol"], ...(p["protocol"] === "WEBSOCKET" ? { route_selection_expression: "$request.body.action" } : {}) } };
    default:
      return null;
  }
}

export interface TerraformPack {
  files: Record<string, string>;
  resources: { type: string; name: string; ownership: string }[];
  /** Plan resources this provider version cannot express; named, never silently dropped. */
  unsupported: { id: string; kind: string; reason: string }[];
}

export function emitTerraform(plan: DeploymentPlan): TerraformPack {
  if (plan.stateOwner !== "terraform") throw new Error(`the plan names ${plan.stateOwner} as the state owner; refusing to emit a second owner for the same resources`);
  if (plan.target === "self-hosted") throw new Error("self-hosted plans are packaged by the self-hosted emitter (Docker/Nix), not Terraform");
  const provider = plan.target === "cloudflare" ? { cloudflare: { source: "cloudflare/cloudflare", version: PROVIDER_VERSIONS.cloudflare } } : { aws: { source: "hashicorp/aws", version: PROVIDER_VERSIONS.aws } };
  const providers: Json = { terraform: { required_version: ">= 1.6.0", required_providers: { ...provider, null: { source: "hashicorp/null", version: PROVIDER_VERSIONS.null } } }, provider: plan.target === "cloudflare" ? { cloudflare: { api_token: "${var.cloudflare_api_token}" } } : { aws: { region: "${var.aws_region}" } } };
  const variables: Json = {};
  if (plan.target === "cloudflare") {
    variables["cloudflare_account_id"] = { type: "string" };
    variables["cloudflare_api_token"] = { type: "string", sensitive: true, description: "injected at apply time from the operator's secret store; never stored in this pack" };
  } else {
    variables["aws_region"] = { type: "string", default: "us-east-1" };
  }
  for (const s of plan.secrets) variables[s.env.toLowerCase()] = { type: "string", sensitive: true, description: `reference: ${s.source} ${s.path}; the value is injected at apply time, never written here` };
  const resources: Json = {};
  const imports: Json[] = [];
  const listed: TerraformPack["resources"] = [];
  const unsupported: TerraformPack["unsupported"] = [];
  for (const r of plan.resources) {
    if (r.kind === "cloudflare_workflow") {
      unsupported.push({ id: r.id, kind: r.kind, reason: `cloudflare provider ${PROVIDER_VERSIONS.cloudflare} has no Workflows binding type; deploy workflows with wrangler (native owner) or a provider that supports them` });
      continue;
    }
    const block = resourceBlock(plan, r);
    if (!block) continue;
    resources[block.type] = { ...((resources[block.type] as Json) ?? {}), [block.name]: block.body };
    listed.push({ type: block.type, name: block.name, ownership: r.ownership });
    if (r.ownership === "adopted") imports.push({ to: `${block.type}.${block.name}`, id: r.adoptId });
  }
  if (plan.target === "cloudflare") {
    const worker = plan.resources.find((r) => r.kind === "cloudflare_workers_script");
    if (worker) {
      resources["cloudflare_workers_cron_trigger"] = { sweep: { account_id: "${var.cloudflare_account_id}", script_name: `\${cloudflare_workers_script.${tfName(worker.id)}.script_name}`, schedules: (worker.properties["crons"] as string[]).map((cron) => ({ cron })) } };
      listed.push({ type: "cloudflare_workers_cron_trigger", name: "sweep", ownership: "managed" });
    }
  }
  if (plan.target === "aws") {
    resources["aws_iam_role"] = { api: { name: `forge-${plan.app}-${plan.stage}-api`, assume_role_policy: "${jsonencode({ Version = \"2012-10-17\", Statement = [{ Effect = \"Allow\", Principal = { Service = [\"lambda.amazonaws.com\", \"states.amazonaws.com\", \"scheduler.amazonaws.com\"] }, Action = \"sts:AssumeRole\" }] })}" } };
  }
  // Migrations are a separate job keyed by the artifact digest: IaC creates capacity; the deployment ledger runs schema changes.
  const migrations: Json = { resource: { null_resource: Object.fromEntries(plan.migrations.map((m) => [tfName(m.job), { triggers: { artifact: m.digest, kind: m.kind }, provisioner: { "local-exec": { command: `forge-migrate --kind ${m.kind} --artifact ${m.digest} --ledger \${var.ledger_url}` } } }])) }, variable: { ledger_url: { type: "string", description: "deployment ledger endpoint; migrations resume there, never re-run by terraform" } } };
  const files: Record<string, string> = {
    // state machine definitions travel with the pack (they are part of the resolved plan, not build output)
    ...Object.fromEntries(plan.resources.filter((r) => r.kind === "aws_sfn_state_machine").map((r) => [`${r.id}.asl.json`, JSON.stringify(r.properties["definition"] ?? { Comment: "definition supplied by the workflows plan", StartAt: "Start", States: { Start: { Type: "Pass", End: true } } }, null, 2) + "\n"])),
    // build outputs the pack expects next to it; placeholders keep `terraform validate` meaningful before a build lands
    ...(plan.target === "cloudflare" ? { "dist/worker.js": "// replaced by the built worker (examples/<app>/deploy/cloudflare) before apply\nexport default { fetch() { return new Response('forge: worker not built', { status: 503 }); } };\n" } : {}),
    "providers.tf.json": JSON.stringify(providers, null, 2) + "\n",
    "variables.tf.json": JSON.stringify({ variable: variables }, null, 2) + "\n",
    "resources.tf.json": JSON.stringify({ resource: resources, ...(imports.length ? { import: imports } : {}) }, null, 2) + "\n",
    "migrations.tf.json": JSON.stringify(migrations, null, 2) + "\n",
    "outputs.tf.json": JSON.stringify({ output: { artifact: { value: plan.artifact }, resources: { value: listed.map((l) => `${l.type}.${l.name}`) } } }, null, 2) + "\n",
  };
  return { files, resources: listed, unsupported };
}

/** The native adapter's view of the same plan (what wrangler.jsonc / the CDK app would create), for equivalence checks. */
export function nativeProjection(plan: DeploymentPlan): { resources: { id: string; kind: string; name: string; ownership: string }[]; bindings: Record<string, string> } {
  const bindings: Record<string, string> = {};
  for (const r of plan.resources) for (const [b, k] of Object.entries(r.bindings)) bindings[b] = `${k}:${r.name}`;
  return { resources: plan.resources.map((r) => ({ id: r.id, kind: r.kind, name: r.name, ownership: r.ownership })), bindings };
}

/** Terraform's view of the emitted pack, reduced to the same shape as `nativeProjection` for comparison. */
export function terraformProjection(plan: DeploymentPlan, pack: TerraformPack): { resources: { id: string; kind: string; name: string; ownership: string }[]; bindings: Record<string, string> } {
  const emitted = new Set(pack.resources.map((r) => `${r.type}.${r.name}`));
  const unsupported = new Set(pack.unsupported.map((u) => u.id));
  const resources = plan.resources.filter((r) => !unsupported.has(r.id) && (emitted.has(`${r.kind}.${tfName(r.id)}`) || r.kind === "cloudflare_durable_object")).map((r) => ({ id: r.id, kind: r.kind, name: r.name, ownership: r.ownership }));
  const bindings: Record<string, string> = {};
  const res = JSON.parse(pack.files["resources.tf.json"]!) as { resource: Record<string, Record<string, Json>> };
  const worker = res.resource["cloudflare_workers_script"]?.["worker"];
  const lambda = res.resource["aws_lambda_function"]?.["api"];
  if (worker) for (const b of worker["bindings"] as Json[]) if (b["type"] !== "secret_text") bindings[String(b["name"])] = String(b["type"]);
  if (lambda) for (const k of Object.keys((lambda["environment"] as { variables: Json }).variables)) if (!plan.secrets.some((s) => s.env === k)) bindings[k] = "env";
  // map back to the plan's binding names -> resource names
  const named: Record<string, string> = {};
  for (const r of plan.resources) for (const [b, k] of Object.entries(r.bindings)) if (b in bindings) named[b] = `${k}:${r.name}`;
  return { resources, bindings: named };
}
