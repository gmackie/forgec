# Reconciliation contract

Implementation for [issue #46](https://github.com/gmackie/forgec/issues/46), under
Foundation epic #25. Ownership and stable acceptance IDs are in contract.json;
executable semantics and limitations are in README.md.

## Composition and authority

Direct dependencies are Specification, Evaluation, Fulfillment and Evidence. Desired
revisions pin exact specifications. Completed evaluations support observations;
semantic drift points to the matching pin and anchor. Corrective attempts reference
typed fulfillment, and results reference immutable sealed evidence. Domain-owned
satellites preserve deployment, device and repository vocabulary. These synthetic
fixtures demonstrate composition; they are not application dogfooding claims.

Every resource is tenant-scoped and append-only. The authoritative journal validates
same-scope consecutive history, strictly advancing desired revisions, attempt/result
identity and desired-revision fences through generated resource rules. A unique
scope/ordinal claim serializes competing publications. Generic writes cannot bypass
those rules. Candidate facts may remain after a failed publication; they do not
change the selected desired revision. The bounded journal retains at most 128 facts.

## Verification

F46-01 through F46-07, F46-R01, F46-R02 and F46-AUTH have local passing evidence:
actual generated consumer models on memory and SQLite, concurrent journal claims,
stale-result rejection, successful current-result publication, immutable retained
history, idempotent retry, real keyed ActorHost restart/effect acknowledgment and
stale-generation rejection, plus denied and cross-tenant operations. Controller
and business fixtures compile separately because their target profiles differ.

F46-STORE remains planned: no live PostgreSQL/D1/DynamoDB certification is claimed.
External side effects require provider revision fencing; the local journal cannot
make an unfenced external request safe. Semantic source-map hooks expose exact pins
and anchors; resolving them into file positions is a consumer responsibility.

Independent verification builds package, consumer and controller fixtures twice
and compares artifacts, then runs test/foundation-reconciliation.test.ts and runtime
typecheck. Set FORGE_FOUNDATION_CONSUMER and FORGE_RECONCILIATION_CONTROLLER to the
corresponding generated output directories when using temporary build locations.
