# Bounded engagements

These six closed ConceptIR models exercise the Interaction candidate from #89. They use domain-owned actor entities and carried Participation relationships (participant, role, context), following #29's participation semantics without importing a Foundation package. Subject profiles (#90) and compiled Foundation integration remain separate work.

| Fixture | Engagement | Participant | Occurrence | Work |
| --- | --- | --- | --- | --- |
| support | Conversation | Customer | MessageReceived | Respond, Review |
| healthcare | Encounter | Patient | ObservationRecorded | Assess, Review |
| negotiation | Negotiation | Negotiator | OfferRecorded | Agree, Review |
| inspection | Inspection | Inspector | FindingRecorded | Inspect, Review |
| incident-response | ResponseSession | Responder | UpdateRecorded | Coordinate, Review |
| economic-exchange | Exchange | Trader | TransferRecorded | Settle, Review |

Each engagement also has a Closed occurrence. Negotiation and economic exchange produce an Agreement with a typed origin reference to the engagement. No compiler subtype is created for these domain names. These are type-level contracts, not instance traces or certified industry implementations.

The optional parent reference supports distinct nested instances of the same engagement type: a support Conversation may contain follow-up Conversations. Parent fields may also target another declared interaction carrier. Actual instance-cycle prevention and interval ordering remain realization obligations. An open episode has no endedAt value yet.

Identity matters: two conversations can have the same participants, event types and processes while remaining different engagements. Removing the engagement identity and its typed context links loses the partition of occurrences and activities between them. An Event captures an occurrence, a Process describes work, and a Relationship describes an association; none alone records that partition. A runtime Session may serve several business engagements, or an engagement may survive multiple runtime sessions and restarts. These fixtures contain no transport, provider, storage, or runtime-session fields.

Run `cargo test -p forgegraph-semantic --test interactions`. The tests check closed loading, graph links, nested-parent bindings, semantic identity/diff, and invalid references. Existing realization checking treats an omitted interaction contract as unproven; declaring it is not evidence of implementation enforcement.
