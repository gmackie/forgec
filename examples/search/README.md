# Portable exact-text search

The Issue, AgentTask and DeliveryEvidence fixtures cover KanBanger-style issue
lookup, Bob task labels and ForgeGraph delivery evidence.

```forge
search exact by project, title
```

The canonical index lives in Resource.lists with `searchMode: "exact"` and a
`search_` name. It generates the bounded list operation
`Issue.list.search_byProjectTitle` and, with CRUD routes enabled,
`GET /v1/issues/search/by-project-title`. Supply the equality fields as query
parameters. Declared normalizers apply on both writes and searches. ID is the
final stable ordering key; page cursors bind tenant, operation and normalized
search values.

The planner emits ordinary equality B-tree indexes for SQLite/PostgreSQL and
transactionally maintained partitioned access items for DynamoDB. There is no
LIKE scan or residual text matching. This profile requires at least one required
text field, text length <= 128, and at most four equality fields. Normal adapter
key/action budgets still apply. Changes require index rebuild and cursor review.

Exact means the whole normalized value, not substring, token, prefix or ranked
search. Those modes fail with an explicit diagnostic and still need dedicated
provider plans and conformance. Large transcript/evidence body search is not
implemented by this slice. Tests cover generated index/routes and actual
memory/SQLite pagination, query-bound cursors and updates. Live PostgreSQL and
DynamoDB certification remains outstanding.
