# M0 spikes

Throwaway executable evidence for the highest-risk commit protocols in the
Forge plan (§10.3, §11.3–11.5, milestone M0). Nothing here is product code;
the point is to prove or disprove a protocol against the **live** provider
before the compiler or adapters depend on it.

| spike | proves | provider resources |
| --- | --- | --- |
| `d1-guarded-batch` | a failed version precondition inside `D1Database.batch()` aborts the audit/outbox writes (assertion-table + named CHECK); concurrent guarded updates admit one winner; outbox lease/claim/complete with fencing and expiry | Worker `forge-spike-d1-guarded-batch`, D1 `forge-spike-guarded-batch` |
| `dynamodb-conditional-tx` | `TransactWriteItems` with entity + unique claim + access item + audit + outbox cancels atomically on a stale version; concurrent unique claims admit one winner; parent delete vs child create cannot orphan; strong access-item queries; outbox lease over a sparse GSI; client-token replay semantics; engine retry is a liveness requirement | table `forge-spike-tx` + GSI `pending-index` (us-east-1, on-demand) |

**M0 gate (2026-09-20): met.** 14 D1 scenarios and 21 DynamoDB scenarios pass
against the live providers; every commit-protocol claim in plan §10–§14 that
the compiler will depend on has a passing executable test.

Each spike's README records the observed result, including the raw provider
error shapes, so the adapter design can be grounded in evidence.
