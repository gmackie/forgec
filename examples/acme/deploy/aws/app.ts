// CDK app for the Acme reference application: DynamoDB TableV2 (+ sparse
// pending index), one Lambda, one HTTP API. Plain constructs (plan §21).
import * as cdk from "aws-cdk-lib";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as apigwv2 from "aws-cdk-lib/aws-apigatewayv2";
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

const fn = new lambda.Function(stack, "Api", {
  runtime: lambda.Runtime.NODEJS_22_X,
  handler: "index.handler",
  code: lambda.Code.fromAsset(path.join(import.meta.dirname, "dist")),
  memorySize: 512,
  timeout: cdk.Duration.seconds(15),
  environment: {
    FORGE_TABLE: table.tableName,
    FORGE_AUTH: "dev-headers", // development only; a production build requires a real auth host
    CURSOR_SECRET: process.env["FORGE_CURSOR_SECRET"] ?? "dev-cursor-secret-change-me",
  },
});
table.grantReadWriteData(fn);

const api = new apigwv2.HttpApi(stack, "HttpApi", { apiName: `forge-acme-${stage}` });
api.addRoutes({ path: "/{proxy+}", methods: [apigwv2.HttpMethod.ANY], integration: new HttpLambdaIntegration("ApiIntegration", fn) });

new cdk.CfnOutput(stack, "ApiUrl", { value: api.apiEndpoint });
new cdk.CfnOutput(stack, "TableName", { value: table.tableName });
