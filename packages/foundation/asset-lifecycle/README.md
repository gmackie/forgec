# Asset / Resource Lifecycle

AssetProfile gives an existing ResourceSubject a pinned business lifecycle role.
It is not a universal asset root or an accounting object. Industrial equipment,
medical devices, logical/cloud services and fleets use typed consumer profiles.

The guarded lifecycle supports acquisition/provisioning, commissioning, operation,
deactivation, movement, refurbishment, retirement and decommissioning. Each
immutable event records evidence, configuration and optional place/custody and
attestation. Operating assets must deactivate before retirement. Decommissioning
is terminal; refurbishment returns an inactive asset to the acquired state and
requires commissioning before operation resumes.

`Assets.act` accepts the exact prior journal head. Unique ordinals serialize
competing actions; `state` replays at most 128 consecutive authorized events.
Commissioning can require an effective Attestation bound to the resource's subject
and specification. Invalid transitions or missing/hidden evidence fail closed.

Place changes require a move. Custody is an explicit reference to an established
ResourceRelationship of the profile's pinned role, not a second ownership system.
Validation uses the event's occurrence time and publication knowledge time, keeping
old evidence meaningful after a subsequent custody handoff. This package does not
create exclusive legal title or infer authority from an actor's business role.

AssetConfiguration is a typed integration hook: resource, pinned configuration
meaning and optional immutable Artifact snapshot. Configuration #94 is not yet a
deployed package; this hook does not claim to implement it. Configuration changes
are admitted through commissioning/refurbishment. Financial depreciation,
accounting, telemetry and automatic provisioning remain separate systems.

Local memory/SQLite/PostgreSQL tests cover lifecycle ordering, required attestations,
concurrent deactivation, authoritative custody handoff/history, retirement and
cross-tenant reads. Raw lifecycle rows are candidates until interpreted through
Assets; application Gatekeeper policies own write authorization.
