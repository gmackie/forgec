//! Workflow deployment plan (plan §15): one native durable driver per workflow
//! on each target, both calling the same portable executor (`advance`).
//! Cloudflare: a WorkflowEntrypoint class + binding. AWS: a Step Functions
//! Standard state machine (the generic driver loop as ASL) invoking the
//! application Lambda; waits use callback task tokens, sleeps use Wait states.
use crate::messaging::pkg_slug;
use forgegraph_semantic::ir::*;
use serde::Serialize;
use serde_json::{Value, json};

pub const WORKFLOWS_VERSION: &str = "workflows/1";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowsPlan {
    pub version: String,
    pub workflows: Vec<WorkflowPlan>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowPlan {
    pub id: String,
    pub name: String,
    pub version: u32,
    pub graph_hash: String,
    pub cloudflare: CloudflareWorkflow,
    pub aws: AwsWorkflow,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CloudflareWorkflow {
    /// wrangler `workflows[].name`
    pub name: String,
    /// `env.<binding>`
    pub binding: String,
    /// Exported class name the Worker must define via `createWorkflowEntrypoint`.
    pub class_name: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AwsWorkflow {
    pub state_machine: String,
    /// Amazon States Language: the driver loop. `${LambdaArn}` is substituted at deploy time.
    pub definition: Value,
}

pub fn plan(ir: &DomainIR) -> WorkflowsPlan {
    let slug = pkg_slug(&ir.package.name);
    let mut workflows = Vec::new();
    for m in &ir.modules {
        for w in &m.workflows {
            let kebab = crate::naming::kebab(&w.name);
            let upper = crate::naming::snake(&w.name).to_uppercase();
            workflows.push(WorkflowPlan {
                id: w.id.clone(),
                name: w.name.clone(),
                version: w.version,
                graph_hash: w.graph_hash.clone(),
                cloudflare: CloudflareWorkflow {
                    name: format!("forge-{slug}-{kebab}"),
                    binding: format!("WF_{upper}"),
                    class_name: format!("{}Workflow", w.name),
                },
                aws: AwsWorkflow {
                    state_machine: format!("forge-{slug}-{kebab}"),
                    definition: driver_asl(&w.id),
                },
            });
        }
    }
    WorkflowsPlan {
        version: WORKFLOWS_VERSION.into(),
        workflows,
    }
}

/// The generic driver: Advance -> route on status -> Wait (sleep) | WaitForSignal (callback token,
/// timed out by the wait step's deadline) -> Advance ... until a terminal status.
fn driver_asl(workflow_id: &str) -> Value {
    json!({
      "Comment": format!("Forge workflow driver for {workflow_id}; all step semantics live in the portable executor."),
      "StartAt": "Advance",
      "States": {
        "Advance": {
          "Type": "Task",
          "Resource": "arn:aws:states:::lambda:invoke",
          "Parameters": { "FunctionName": "${LambdaArn}", "Payload": { "forge": "workflow.advance", "tenant.$": "$.tenant", "id.$": "$.id" } },
          "ResultSelector": { "status.$": "$.Payload.status", "dueAt.$": "$.Payload.dueAt", "timeoutSeconds.$": "$.Payload.timeoutSeconds" },
          "ResultPath": "$.state",
          "Retry": [{ "ErrorEquals": ["States.TaskFailed", "Lambda.ServiceException", "Lambda.TooManyRequestsException"], "IntervalSeconds": 2, "MaxAttempts": 6, "BackoffRate": 2.0 }],
          "Next": "Route"
        },
        "Route": {
          "Type": "Choice",
          "Choices": [
            { "Variable": "$.state.status", "StringEquals": "sleeping", "Next": "Sleep" },
            { "Variable": "$.state.status", "StringEquals": "waiting", "Next": "WaitForSignal" },
            { "Variable": "$.state.status", "StringEquals": "running", "Next": "Advance" }
          ],
          "Default": "Done"
        },
        "Sleep": { "Type": "Wait", "TimestampPath": "$.state.dueAt", "Next": "Advance" },
        "WaitForSignal": {
          "Type": "Task",
          "Resource": "arn:aws:states:::lambda:invoke.waitForTaskToken",
          "Parameters": { "FunctionName": "${LambdaArn}", "Payload": { "forge": "workflow.wait", "tenant.$": "$.tenant", "id.$": "$.id", "taskToken.$": "$$.Task.Token" } },
          "TimeoutSecondsPath": "$.state.timeoutSeconds",
          "ResultPath": null,
          "Catch": [{ "ErrorEquals": ["States.Timeout"], "ResultPath": null, "Next": "Advance" }],
          "Next": "Advance"
        },
        "Done": { "Type": "Succeed" }
      }
    })
}
