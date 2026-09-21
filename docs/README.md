# Forge documentation

| document | what it covers |
| --- | --- |
| [getting-started.md](getting-started.md) | install the toolchain, build the Acme reference, run it locally on both targets |
| [language.md](language.md) | every declaration kind with the Acme examples: resources, lifecycle, functions, channels, workflows, views, projections, caches, schedules, realtime |
| [portable-profile.md](portable-profile.md) | what `portable-v1` guarantees on both clouds, what it refuses, and the declared limits |
| [deployment.md](deployment.md) | wrangler + Cloudflare (D1, R2, Queues, Workflows, Durable Objects, Cron) and CDK + AWS (DynamoDB, S3, SQS, Step Functions, EventBridge, API Gateway WebSocket); migrations; secrets |
| [operations.md](operations.md) | telemetry and SLOs, schedules and workflow operations, projections, provider switching, compatibility checks |
| [conformance.md](conformance.md) | the executable specification: scenarios, vectors, live certification, benchmarks |
| [decisions/](decisions/) | architecture decision records |
| [../specs/](../specs/) | normative specs: grammar, identity, wire format, error catalogue, codecs and golden vectors, IR |

The design rationale behind all of it is `../Forge_Dual_Target_Implementation_Plan.md`.
