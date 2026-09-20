# 0001 — M0 toolchain and provider version baseline

Status: partially decided (2026-09-20). Plan M0 asks us to "decide supported
versions for Rust, TypeScript, Effect, Alchemy, CDK, Cloudflare compatibility
date, and AWS runtime". Registry versions checked 2026-09-20.

## Decided

| concern | pin | rationale |
| --- | --- | --- |
| Rust | 1.97.x stable, edition 2024 | current stable on the dev machine; nothing in the plan needs nightly |
| Node | 24.x | current LTS-track; used by both spikes |
| Package manager | pnpm 10.32 | workspace already uses it (`packageManager` field) |
| TypeScript | 5.9.x for M0–M1 | 7.0 (native port) is `latest` but tooling compatibility (vitest, wrangler, workers-types) is unverified; revisit at M2 |
| Test runner | vitest 5 | used by both spikes |
| wrangler | 4.83+ (4.135 current) | spike deployed and validated with 4.83 |
| Cloudflare `compatibility_date` | `2026-09-01` | validated by the D1 spike deployment |
| AWS SDK | `@aws-sdk/*` 3.1136.x | validated by the Dynamo spike |
| aws-cdk-lib | 2.270.x | current; not yet exercised (CDK CLI not installed locally) |
| Alchemy | 2.0.0-beta.79 | **only beta exists**; the Alchemy adapter must pin an exact beta and expect churn |
| Effect | **4.0.0-rc** (currently rc.116) | decided 2026-09-20: the plan's R10 cites v4 docs; adopting the RC now avoids a 3→4 migration of every generated service interface before 1.0. Pin an exact RC per commit and track breakage in M2–M3. |

## Open — needs a decision before M1/M2 code depends on it

1. **AWS Lambda runtime.** `nodejs22.x` is the safe pin; verify whether
   `nodejs24.x` is GA in us-east-1 before M2 provisions functions.
2. **TypeScript 7** adoption point (see above).

## Evidence produced by M0 spikes

- `spikes/d1-guarded-batch/README.md` — assertion-table + named CHECK lowering certified on live D1.
- `spikes/dynamodb-conditional-tx/README.md` — transaction protocol certified on live DynamoDB; `TransactionConflict` retry and `unmarshall` findings.
