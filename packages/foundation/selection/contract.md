# selection contract

Issue #59; implementation acceptance remains planned.

## Ownership

Solicitation, typed submission envelope, evaluated shortlist and durable award/agreement link.

## Composition

Required dependencies: specification, participation, evaluation, decision, agreement-catalog.

Artifact submissions, Intake and Quote-to-Submission adapters; no reverse Agreement-to-Selection or Quote-to-Selection core edge.

## Independent acceptance

Procurement/hiring/grants; pinned criteria, deadlines, ties/ranking when enabled, duplicate award guard and winning agreement trace.

- F59-01: solicitation/call model
- F59-02: submission envelope
- F59-03: evaluation/decision integration
- F59-04: award/selection fact
- F59-05: shortlist/ranking support where justified
- F59-06: fixtures for procurement, hiring and grants

Compile typed consumer fixtures, execute generated-bundle behaviors and adversarial cases, and bind evidence to accepted dependency revisions. Provider certification is separate from local tests.

## Implemented bounded shortlist profile

Solicitation pins separate immutable criteria and agreement-term SpecificationPins, a ParticipationSet, open/close deadline and tie policy. Submission is a typed immutable envelope referring to one participant and EvaluationSet; domain satellites own procurement, hiring and grant payloads. Generated timestamp rules reject late creation, and authoritative reads verify membership at submission time. Score facts require a completed real EvaluationRun against the exact criteria pin, matching EvaluationSet, valid start/finish and any sealed evidence. Failed validation occurs before publishing the unique score.

`shortlist` accepts an explicit closed list of 1–16 scored submissions after the deadline, sorts exact decimal quantities with BigInt and binds each rank to one option in a fresh DecisionCase. Higher score ranks first. Ties either reject or compare immutable submission keys in deterministic code-unit order. This is a nominated shortlist, not a claim that every submission was included. The Decision electorate and voting rule independently choose among shortlisted options; highest score does not automatically become the award. Shortlist consumption revalidates order, membership, exact criteria, option count and the pre-response binding timestamp.

`award` requires the validated Decision outcome and a fully issued Agreement whose supplier is the winning submitter and whose terms equal the solicitation's pinned terms. Unique solicitation and agreement constraints guard duplicate awards. `inspectAward` revalidates the complete provenance chain after restart. Agreement approval and issuance are separate durable workflows; Selection records their link and does not pretend to atomically negotiate or issue a contract. Historical Agreement termination does not erase the award.

Local memory, SQLite and PostgreSQL tests exercise real Evaluation, Decision and AgreementCatalog implementations, typed procurement/hiring/grant satellites, early-shortlist and late-submission rejection, wrong criteria, exact close scores, rejected and deterministic ties, wrong winning supplier, duplicate award races, restart and authorization/tenant boundaries. Artifact/Intake/Quotation submission adapters remain separate upper-layer bridges and are not claimed by these core fixtures. No multi-provider transaction, unbounded ranking, automatic reviewer assignment or atomic revocation/decision-read snapshot is implemented. Live D1/DynamoDB certification remains planned.
