# Lineage (experimental)

Business resources reference LineageNode; no universal EntityRef points back into
applications. Derived, Aggregated, Copied and Extracted are explicit relation kinds.
Transformation owns explicit input/output sets and a specification pin. Traversal
returns transformation records with input/output node arrays, never manufactures
Cartesian pairwise edges. Software build, batch, dataset transformation and level
fixtures include a typed BuildExecution satellite for execution provenance.

Nodes have immutable unique graph-local ranks. Every relation goes from lower to
higher rank; every transformation input is below its rank and every output above.
Raw schema rules enforce graph equality and rank inequalities. **This deliberately
refines the earlier graph-guard proposal:** immutable topological ranks prove cycle
safety even for concurrent edge insertions, without a serialized graph guard. Rank
is ordering, not time or quantity. Planning ranks is caller responsibility; new
physical generations use new node identities. Changing rank requires a new node.

TransformationInput/Output rows are candidate membership chains. Their immutable
strictly decreasing depth in 1..128 bounds length and prohibits cycles. A unique
TransformationSeal pins nonempty input and output heads; competing seals conflict.
Late candidates or different chains cannot alter selected provenance. Unsealed
transformations and unselected candidates do not participate in traversal. Each
sealed transform emits its exact hyperedge membership, retaining identifiable
children for aggregation and explicit input/output identity for transformation.

Relations are immutable; correction creates a successor relation with the same
graph/endpoints and a larger bounded revision. A predecessor has at most one direct
successor. Traversal retains both historical records and identifies `supersededBy`;
it does not silently discard old provenance or claim all historical kinds currently
apply. There is no destructive edge correction or automatic transformation rewrite.
A changed transform is a newly identified transformation with its own seal.

Traversal enforces node, edge, transformation, membership, fanout and index-read
budgets. It enumerates a bounded complete storage index internally and then checks
normal list/get authorization on every row. A filtered public list cannot prove
hidden links are absent: denied links, seals, nodes, definition pins or selected
membership cause failure rather than a misleading disconnected graph. Even hidden
unselected candidates can conservatively deny traversal. No unauthorized row data
is returned. All queries remain tenant-scoped; no unbounded scan is introduced.

Memory and SQLite consumer tests cover all four domain fixtures, exact specification
pins, late memberships, seal races, supersession, raw DAG/graph constraints, true
depth and fanout limits, and hidden links/seals. This is local evidence; hosted D1,
PostgreSQL and DynamoDB certification is not claimed.
