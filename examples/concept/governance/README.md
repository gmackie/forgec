# External constraints

These deliberately illustrative models are schema/conformance fixtures, not legal interpretations or assertions of compliance with an actual regulation.

| Fixture | Authority | Applicability | Required contract | Later revision |
| --- | --- | --- | --- | --- |
| privacy | PrivacyAuthority | engagement.regulated | consentRecorded | suspend Respond |
| safety | StandardsBody | engagement.regulated | inspectionPassed | suspend Respond |
| consumer | ConsumerAuthority | engagement.regulated | disclosureRecorded | suspend Respond |

Each model retains internal contracts separately and adds external source citations, a typed jurisdiction Entity, an authority Subject, applicability as a typed process-context predicate, effective intervals, and explicit supersession. Requirements point to business contracts; prohibitions point to processes. Profiles and citations are authored declarations, not authentication or evidence of legal authority.

`validFrom` is inclusive and `validUntil` exclusive, in epoch milliseconds. The original rule ends at 1000; its successor starts at 1000. Supersession links retain history and reject cycles/backwards effective starts. A supersession link alone does not implicitly rewrite or end an earlier rule: explicit validity intervals remain authoritative, allowing partially overlapping requirements.

Run `forgec concept explain-constraints examples/concept/governance/privacy.json @governance/privacy/_/Respond --at 999` to see source, authority, jurisdiction, required contracts, and the applicability predicate. At 1000 the successor prohibits the process. The command explicitly leaves applicability unevaluated: adapters must evaluate it in the specified typed business context. The query is an explanation of declarations, not an authorization decision.

Storage tables, event history, ABAC adapters, and enforcement providers are outside the L0 model. Changing those implementation choices leaves the ConceptIR hash unchanged. Existing realization reporting keeps an omitted external-constraint declaration unproven. No provenance evidence or enforcement is fabricated for these examples.
