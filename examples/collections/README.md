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
element types. GraphQL rejects open map objects explicitly. The routed LevelDefinition and MailingGroup examples also run a shared HTTP
conformance corpus through TypeScript, Python and Go clients. It covers nested
lists, normalized set ordering, arbitrary map keys, exact safe integers, PATCH
preservation and invalid collection values. GraphQL preserves input element
nullability and rejects maps, open objects and unsupported unions explicitly.

Element classifications appear as wildcard paths such as `recipients[]`.
Audit sinks conservatively redact entire collection containers. This does not
provide selective element-level purpose release. Collection codec/bound changes
require compatibility and existing-data review before rollout.

Build: `cargo run -p forgegraph-cli --bin forgec -- build examples/collections`.
Runtime tests use the tracked fixture in `conformance/fixtures/collections`.

Storage conformance runs the same round-trip and record-size checks against memory,
SQLite and real PostgreSQL through raw-pg and Drizzle. PostgreSQL runs when
FORGE_PG_URL is configured, using an isolated schema per test.
