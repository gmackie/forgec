# Party (experimental)

Party owns durable business identity. It references an optional IdentifierSet;
canonical Party IDs remain distinct from external identifiers and authenticated
Principal IDs. Person and Organization are typed consumer satellites, not subclasses.
Customer and Worker fixtures demonstrate business roles without adding them to Party.

Party, PrincipalRepresentation and RepresentationRevocation are append-only,
tenant-scoped facts. Representation is many-to-many: a principal may represent
several parties and a party may have several representatives. Its principal field
is the external authentication identity in the current tenant, not a foreign key
whose deletion could remove business history. Deprovisioning is an explicit
revocation supplied by the identity integration; this package does not watch an
external identity provider or authenticate a principal.

`Parties.represent` records a half-open validity window, actor and reason. Duplicate
principal/party/start triples conflict. A unique terminal revocation records when
representation ceased; competing revocations cannot replace history. Historical
queries before effectiveAt still return the association. A later reappointment is
a new representation with a new start. Different-start overlapping representations
are permitted; a caller interpreting them as a set should deduplicate Party IDs.

`listRepresentedAt` returns paginated facts. Follow `next` even for an empty page.
It reads both the Party and any terminal revocation through Engine authorization;
unreadable revocations never mean active representation. Representation grants no
authority. The Participation PIP fixture composes representation and membership
under an independent policy using a separately authorized fact reader.

Tests use generated consumer bundles on memory and local SQLite through the D1
adapter. They cover typed satellites, identifier references, representation and
revocation races, history, pagination, tenant isolation and policy denial. This is
not hosted D1/PostgreSQL/DynamoDB certification. The shared verifier/fixture registry
must register `party` and `party-consumer` when integrating this package.
