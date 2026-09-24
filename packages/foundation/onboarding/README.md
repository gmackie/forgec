# Onboarding / Lifecycle Transition

Onboarding is a case-based composition for a QualificationSubject, with optional
Party and principal mappings. It binds domain-owned intake, accepted validation,
qualification requirement, activation criteria and a preselected approval option.
A fixed 1–16 gate chain orders relationship, access, delegation, configuration and
provisioning facts. Relationship establishment and complete provisioning are
mandatory; profiles select other gates explicitly. Each gate follows approval.

`Onboarding.inspect/activate/activation` validates complete gate history, accepted
intake evaluation, qualification, decision, active relationship, effective grants
for the mapped principal, configuration verification and completed provisioning.
Activation preserves an evidence-backed historical explanation. Current access is
still governed by AccessGovernance and Delegation, not an activation boolean.
For device/service profiles, the relationship may be the responsible parties'
relationship; the domain owns that mapping and typed intake interpretation.

Configuration #94 is not implemented in this tree. OnboardingConfiguration is an
explicit pinned definition, completed evaluation and sealed evidence hook. It
does not apply or infer configuration. Hosts perform and verify provisioning.

Offboarding names a separate Case, cleanup and transfer Fulfillments, obligation
review EvaluationRun and acceptance Decision, policy and retention Record.
`completion` verifies all of these, and requires explicit terminal ends for every
relationship, access grant and delegation declared by the onboarding gates. A
replacement grant is not revocation. Original activation remains queryable at its
historical instant. The profile owns completeness of its gate inventory; this is
not a discovery scan of every external account. Obligations are certified through
pinned evaluation and decision; this reader does not transfer funds or infer that
an evaluation alone settles a payable. Records retains its independent legal-hold
and disposition lifecycle. No cleanup is executed implicitly by reading a result.

Employee, vendor, SaaS tenant and device/service consumer profiles share the model.
Memory/SQLite/PostgreSQL tests cover qualification and provisioning failures,
configuration evidence, staged activation, delegation revocation, relationship
termination, cleanup/transfer, accepted obligation review, retention and isolation.
