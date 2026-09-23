# Project portfolio aggregates

`Issue` changes maintain a per-project portfolio with conditional count/sum, existence/not-existence, numeric extrema and latest update time. Build with `forgec build examples/project-portfolio`.

Each aggregate can append `where <predicate>` after its alias. `exists` and `notExists` return booleans over the matching contribution count. `min`, `max` and `latest` support numeric/date/datetime fields; `latest` means maximum field value, not the entire record associated with it. Empty extrema return null. Money and decimal arithmetic uses exact minor units.

The runtime maintains a bounded value-count multiset for extrema, allowing deletions and decreases without source scans. Each aggregate supports 256 distinct values per group; the group document supports at most 256 KiB. Exceeding either limit returns `BudgetExceeded` before committing an event. This is an explicit portable limit, not an approximate result.

Group updates, contribution revision and projection progress commit atomically through a bounded document compare-and-swap batch. SQLite/D1 and Postgres use guarded transactional batches; DynamoDB uses TransactWriteItems; memory validates all versions before applying changes. The shared batch supports at most 24 distinct document keys.

Projection sources must be versioned. Event retries compare ledger versions and re-read current source state. Rebuild retains the existing generation-switch mechanism and refuses to publish after exceeding its source-page limit. Concurrent rebuild snapshot/cutover coordination and recovery of abandoned rebuild generations still need further work.

Runtime regression fixtures exercise filtered counts, sums, boolean existence, extrema, latest, removal, duplicate events and rebuild against memory, SQLite and real PostgreSQL through raw-pg and Drizzle (when FORGE_PG_URL is configured). Atomic document rollback is tested against memory and SQLite. DynamoDB and live Cloudflare conformance remain outstanding.

Bounded joins/reference traversal, top-N/ranking and full EnvironmentState composition remain outstanding in #10. The new aggregate semantics are marked `projection-aggregates/1`, so older runtimes reject affected artifacts rather than misinterpreting them.
