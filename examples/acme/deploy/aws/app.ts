// CDK app for the Acme reference application: DynamoDB TableV2 (+ sparse
// pending index), one Lambda, one HTTP API. Plain constructs (plan §21).
import * as cdk from "aws-cdk-lib";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as apigwv2 from "aws-cdk-lib/aws-apigatewayv2";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as sqs from "aws-cdk-lib/aws-sqs";
import * as events from "aws-cdk-lib/aws-events";
import * as targets from "aws-cdk-lib/aws-events-targets";
import * as sfn from "aws-cdk-lib/aws-stepfunctions";
import * as iam from "aws-cdk-lib/aws-iam";
import * as scheduler from "aws-cdk-lib/aws-scheduler";
import { WebSocketLambdaIntegration } from "aws-cdk-lib/aws-apigatewayv2-integrations";
import { SqsEventSource } from "aws-cdk-lib/aws-lambda-event-sources";
import bundle from "../../generated/app.json" with { type: "json" };
import { HttpLambdaIntegration } from "aws-cdk-lib/aws-apigatewayv2-integrations";
import * as path from "node:path";

const app = new cdk.App();
const stage = app.node.tryGetContext("stage") ?? "dev";
const stack = new cdk.Stack(app, `forge-acme-${stage}`, { env: { region: process.env["CDK_DEFAULT_REGION"] ?? "us-east-1", account: process.env["CDK_DEFAULT_ACCOUNT"] } });

const table = new dynamodb.TableV2(stack, "Data", {
  tableName: `forge-acme-${stage}`,
  partitionKey: { name: "PK", type: dynamodb.AttributeType.STRING },
  sortKey: { name: "SK", type: dynamodb.AttributeType.STRING },
  billing: dynamodb.Billing.onDemand(),
  removalPolicy: cdk.RemovalPolicy.RETAIN, // authoritative data is retained by default (plan §21)
  globalSecondaryIndexes: [
    {
      indexName: "pending-index",
      partitionKey: { name: "pendingShard", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "pendingAt", type: dynamodb.AttributeType.NUMBER },
      projectionType: dynamodb.ProjectionType.ALL,
    },
  ],
});

const bucket = new s3.Bucket(stack, "Blobs", {
  bucketName: `forge-acme-${stage}-blobs-${cdk.Stack.of(stack).account}`,
  blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
  encryption: s3.BucketEncryption.S3_MANAGED,
  removalPolicy: cdk.RemovalPolicy.RETAIN,
  cors: [{ allowedMethods: [s3.HttpMethods.PUT, s3.HttpMethods.GET], allowedOrigins: ["*"], allowedHeaders: ["*"] }],
});

// One durable queue per logical subscription (plan §14), from the compiled messaging plan.
const dlq = new sqs.Queue(stack, "Dlq", { queueName: `forge-acme-${stage}-dlq`, retentionPeriod: cdk.Duration.days(14) });
const queues: Record<string, sqs.Queue> = {};
for (const sub of (bundle as any).messaging.subscriptions as { name: string; queue: string }[]) {
  queues[sub.name] = new sqs.Queue(stack, `Queue-${sub.name}`, { queueName: `${sub.queue}-${stage}`, visibilityTimeout: cdk.Duration.seconds(60), deadLetterQueue: { queue: dlq, maxReceiveCount: 5 } });
}

// Workflows (plan §15): one Step Functions Standard state machine per declared workflow. The Lambda
// learns the ARNs by deterministic name (no circular dependency with the machine's Lambda reference).
const workflowPlans = bundle.workflows?.workflows ?? [];
const machineName = (w: { aws: { stateMachine: string } }) => `${w.aws.stateMachine}-${stage}`;
const machineArns = Object.fromEntries(workflowPlans.map((w) => [w.name, stack.formatArn({ service: "states", resource: "stateMachine", resourceName: machineName(w), arnFormat: cdk.ArnFormat.COLON_RESOURCE_NAME })]));

const fn = new lambda.Function(stack, "Api", {
  runtime: lambda.Runtime.NODEJS_24_X,
  handler: "index.handler",
  code: lambda.Code.fromAsset(path.join(import.meta.dirname, "dist")),
  memorySize: 512,
  timeout: cdk.Duration.seconds(15),
  environment: {
    FORGE_TABLE: table.tableName,
    FORGE_BUCKET: bucket.bucketName,
    FORGE_AUTH: "dev-headers", // development only; a production build requires a real auth host
    FORGE_CORS: "http://localhost:5173,https://forge-acme-workspace.example.workers.dev",
    FORGE_QUEUES: JSON.stringify(Object.fromEntries(Object.entries(queues).map(([name, q]) => [name, q.queueUrl]))),
    FORGE_WORKFLOWS: JSON.stringify(machineArns),
    CURSOR_SECRET: process.env["FORGE_CURSOR_SECRET"] ?? "dev-cursor-secret-change-me",
  },
});
table.grantReadWriteData(fn);
bucket.grantReadWrite(fn);
for (const q of Object.values(queues)) {
  q.grantSendMessages(fn);
  fn.addEventSource(new SqsEventSource(q, { batchSize: 10, reportBatchItemFailures: true }));
}
for (const w of workflowPlans) {
  const definition = JSON.stringify(w.aws.definition).replaceAll("${LambdaArn}", fn.functionArn);
  const sm = new sfn.StateMachine(stack, `Workflow-${w.name}`, { stateMachineName: machineName(w), stateMachineType: sfn.StateMachineType.STANDARD, definitionBody: sfn.DefinitionBody.fromString(definition), timeout: cdk.Duration.days(365) });
  fn.grantInvoke(sm);
}
if (workflowPlans.length) {
  fn.addToRolePolicy(new iam.PolicyStatement({ actions: ["states:StartExecution"], resources: Object.values(machineArns) }));
  fn.addToRolePolicy(new iam.PolicyStatement({ actions: ["states:SendTaskSuccess", "states:SendTaskFailure"], resources: ["*"] }));
}
// Schedules (plan §19): EventBridge rules deliver the intended instant (`time`); the ledger decides
// what is due. Local-time schedules use EventBridge Scheduler (timezone-aware) via the same input.
for (const s of bundle.schedules?.schedules ?? []) {
  if (s.aws.timezone === "UTC") {
    new events.Rule(stack, `Schedule-${s.name}`, {
      schedule: events.Schedule.expression(s.aws.expression),
      targets: [new targets.LambdaFunction(fn, { event: events.RuleTargetInput.fromObject({ forge: "schedule.tick", source: s.source, time: events.EventField.time }) })],
    });
  } else {
    const role = new iam.Role(stack, `ScheduleRole-${s.name}`, { assumedBy: new iam.ServicePrincipal("scheduler.amazonaws.com") });
    fn.grantInvoke(role);
    new scheduler.CfnSchedule(stack, `Scheduler-${s.name}`, {
      scheduleExpression: s.aws.expression,
      scheduleExpressionTimezone: s.aws.timezone,
      flexibleTimeWindow: { mode: "OFF" },
      target: { arn: fn.functionArn, roleArn: role.roleArn, input: JSON.stringify({ forge: "schedule.tick", source: s.source, time: "<aws.scheduler.scheduled-time>" }) },
    });
  }
}
// Durable outbox sweep (plan §14): the request-time nudge is not a delivery guarantee.
new events.Rule(stack, "OutboxSweep", { schedule: events.Schedule.rate(cdk.Duration.minutes(5)), targets: [new targets.LambdaFunction(fn)] });

const api = new apigwv2.HttpApi(stack, "HttpApi", { apiName: `forge-acme-${stage}` });
api.addRoutes({ path: "/{proxy+}", methods: [apigwv2.HttpMethod.ANY], integration: new HttpLambdaIntegration("ApiIntegration", fn) });

// Realtime (plan §19): one WebSocket API; the stream is the `stream` query parameter on connect.
const wsApi = new apigwv2.WebSocketApi(stack, "RealtimeApi", {
  apiName: `${bundle.realtime?.aws.apiName ?? "forge-realtime"}-${stage}`,
  connectRouteOptions: { integration: new WebSocketLambdaIntegration("WsConnect", fn) },
  disconnectRouteOptions: { integration: new WebSocketLambdaIntegration("WsDisconnect", fn) },
  defaultRouteOptions: { integration: new WebSocketLambdaIntegration("WsDefault", fn) },
});
const wsStage = new apigwv2.WebSocketStage(stack, "RealtimeStage", { webSocketApi: wsApi, stageName: stage, autoDeploy: true });
wsApi.grantManageConnections(fn);
fn.addEnvironment("FORGE_WS_ENDPOINT", `https://${wsApi.apiId}.execute-api.${stack.region}.amazonaws.com/${stage}`);

new cdk.CfnOutput(stack, "ApiUrl", { value: api.apiEndpoint });
new cdk.CfnOutput(stack, "RealtimeUrl", { value: wsStage.url });
new cdk.CfnOutput(stack, "TableName", { value: table.tableName });
