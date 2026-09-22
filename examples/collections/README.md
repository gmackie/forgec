# Bounded collections

`LevelDefinition` models ordered game objectives, a grid, tags and metadata.
`MailingGroup` models a business mailing list with classified recipient addresses.

The portable profile supports `list<T>`, `set<T>` and `map<text,T>` with an explicit
`length` upper bound no greater than 1024. Collection/shape nesting is limited to
four levels. Resource records in collection-enabled packages are limited to
256 KiB of canonical JSON. Map keys are limited to 256 UTF-8 bytes.

Lists preserve order. Sets normalize members, reject duplicates after
normalization, and sort by canonical JSON. Maps sort keys without normalizing
them. Values support scalar codecs, enums, identities and finite shapes;
resource references, records, messages and opaque JSON inside collections are
rejected by the portable planner. Collections cannot be index, order, uniqueness
or cache keys. SQL stores JSON text; DynamoDB stores document values.

OpenAPI exposes array/object bounds and uniqueItems; generated TypeScript keeps
element types. GraphQL rejects open map objects explicitly. Other client/interface
projections still need collection-specific conformance coverage.

Element classifications appear as wildcard paths such as `recipients[]`.
Audit sinks conservatively redact entire collection containers. This does not
provide selective element-level purpose release. Collection codec/bound changes
require compatibility and existing-data review before rollout.

Build: `cargo run -p forgegraph-cli --bin forgec -- build examples/collections`.
Runtime tests use the tracked fixture in `conformance/fixtures/collections`.
