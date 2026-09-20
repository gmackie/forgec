# M0 spikes

Throwaway executable evidence for the highest-risk commit protocols in the
Forge plan (§10.3, §11.3–11.5, milestone M0). Nothing here is product code;
the point is to prove or disprove a protocol against the **live** provider
before the compiler or adapters depend on it.

| spike | proves | provider resources |
| --- | --- | --- |
| `d1-guarded-batch` | a failed version precondition inside `D1Database.batch()` aborts the audit/outbox writes (assertion-table + CHECK); concurrent guarded updates admit one winner | Worker `forge-spike-d1-guarded-batch`, D1 `forge-spike-guarded-batch` |
| `dynamodb-conditional-tx` | `TransactWriteItems` with entity + unique claim + audit + outbox cancels atomically on a stale version; concurrent unique claims admit one winner; parent delete vs child create cannot orphan under an integrity guard; client-token replay semantics | table `forge-spike-tx` (us-east-1, on-demand) |

Each spike's README records the observed result, including the raw provider
error shapes, so the adapter design can be grounded in evidence.
