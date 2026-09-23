$version: "2.0"

namespace foundation.probe.quotation.pricing.consumers

@error("client")
structure Problem {
    @required
    code: String
    @required
    title: String
    detail: String
}

structure AgreementRecord {
    @required
    id: String
    @required
    createdAt: String
    @required
    updatedAt: String
    acceptance: String
    @required
    acceptanceKey: String
    @required
    offer: String
    @required
    supplier: String
    @required
    customer: String
    @required
    supplierParticipation: String
    @required
    customerParticipation: String
    supplierEnd: String
    customerEnd: String
    @required
    qualification: String
    @required
    approvalOption: String
    @required
    approval: String
    @required
    terms: String
    document: String
    @required
    validFrom: String
    @required
    validUntil: String
    predecessor: String
    @required
    change: String
    @required
    recordedBy: String
}

structure AgreementCreateInput {
    acceptance: String
    @required
    acceptanceKey: String
    @required
    offer: String
    @required
    supplier: String
    @required
    customer: String
    @required
    supplierParticipation: String
    @required
    customerParticipation: String
    supplierEnd: String
    customerEnd: String
    @required
    qualification: String
    @required
    approvalOption: String
    @required
    approval: String
    @required
    terms: String
    document: String
    @required
    validFrom: String
    @required
    validUntil: String
    predecessor: String
    @required
    change: String
    @required
    recordedBy: String
}

structure AgreementPatchInput {
}

structure AgreementAcceptanceRecord {
    @required
    id: String
    @required
    createdAt: String
    @required
    updatedAt: String
    @required
    acceptanceKey: String
    @required
    offer: String
    @required
    supplier: String
    @required
    customer: String
    @required
    supplierParticipation: String
    @required
    customerParticipation: String
    supplierEnd: String
    customerEnd: String
    @required
    qualification: String
    @required
    approvalOption: String
    @required
    approval: String
    @required
    terms: String
    document: String
    @required
    offerValidFrom: String
    @required
    offerValidUntil: String
    @required
    validFrom: String
    @required
    validUntil: String
    predecessor: String
    @required
    change: String
    @required
    recordedBy: String
}

structure AgreementAcceptanceCreateInput {
    @required
    acceptanceKey: String
    @required
    offer: String
    @required
    supplier: String
    @required
    customer: String
    @required
    supplierParticipation: String
    @required
    customerParticipation: String
    supplierEnd: String
    customerEnd: String
    @required
    qualification: String
    @required
    approvalOption: String
    @required
    approval: String
    @required
    terms: String
    document: String
    @required
    offerValidFrom: String
    @required
    offerValidUntil: String
    @required
    validFrom: String
    @required
    validUntil: String
    predecessor: String
    @required
    change: String
    @required
    recordedBy: String
}

structure AgreementAcceptancePatchInput {
}

structure AgreementAcceptanceCommitRecord {
    @required
    id: String
    @required
    createdAt: String
    @required
    updatedAt: String
    @required
    acceptance: String
    @required
    acceptanceKey: String
    @required
    offer: String
    @required
    supplier: String
    @required
    customer: String
    @required
    supplierParticipation: String
    @required
    customerParticipation: String
    supplierEnd: String
    customerEnd: String
    @required
    qualification: String
    @required
    approvalOption: String
    @required
    approval: String
    @required
    terms: String
    document: String
    @required
    offerValidFrom: String
    @required
    offerValidUntil: String
    @required
    validFrom: String
    @required
    validUntil: String
    predecessor: String
    @required
    change: String
    @required
    recordedBy: String
}

structure AgreementAcceptanceCommitCreateInput {
    @required
    acceptance: String
    @required
    acceptanceKey: String
    @required
    offer: String
    @required
    supplier: String
    @required
    customer: String
    @required
    supplierParticipation: String
    @required
    customerParticipation: String
    supplierEnd: String
    customerEnd: String
    @required
    qualification: String
    @required
    approvalOption: String
    @required
    approval: String
    @required
    terms: String
    document: String
    @required
    offerValidFrom: String
    @required
    offerValidUntil: String
    @required
    validFrom: String
    @required
    validUntil: String
    predecessor: String
    @required
    change: String
    @required
    recordedBy: String
}

structure AgreementAcceptanceCommitPatchInput {
}

structure AgreementEntitlementLinkRecord {
    @required
    id: String
    @required
    agreement: String
    @required
    offer: String
    @required
    entitlement: String
}

structure AgreementEntitlementLinkCreateInput {
    @required
    agreement: String
    @required
    offer: String
    @required
    entitlement: String
}

structure AgreementEntitlementLinkPatchInput {
}

structure AgreementEventRecord {
    @required
    id: String
    @required
    createdAt: String
    @required
    updatedAt: String
    @required
    agreement: String
    @required
    ordinal: Long
    previous: String
    @required
    kind: String
    @required
    reason: String
    @required
    recordedBy: String
}

structure AgreementEventCreateInput {
    @required
    agreement: String
    @required
    ordinal: Long
    previous: String
    @required
    kind: String
    @required
    reason: String
    @required
    recordedBy: String
}

structure AgreementEventPatchInput {
}

structure AgreementIssuedRecord {
    @required
    id: String
    @required
    createdAt: String
    @required
    updatedAt: String
    @required
    agreement: String
    @required
    offer: String
    @required
    terms: String
    @required
    supplier: String
    @required
    customer: String
    right: String
    duty: String
}

structure AgreementIssuedCreateInput {
    @required
    agreement: String
    @required
    offer: String
    @required
    terms: String
    @required
    supplier: String
    @required
    customer: String
    right: String
    duty: String
}

structure AgreementIssuedPatchInput {
}

structure AgreementObligationLinkRecord {
    @required
    id: String
    @required
    agreement: String
    @required
    offer: String
    @required
    obligation: String
}

structure AgreementObligationLinkCreateInput {
    @required
    agreement: String
    @required
    offer: String
    @required
    obligation: String
}

structure AgreementObligationLinkPatchInput {
}

structure AgreementParticipantRecord {
    @required
    id: String
    @required
    agreement: String
    @required
    side: String
    @required
    participant: String
}

structure AgreementParticipantCreateInput {
    @required
    agreement: String
    @required
    side: String
    @required
    participant: String
}

structure AgreementParticipantPatchInput {
}

structure AgreementTermLinkRecord {
    @required
    id: String
    @required
    agreement: String
    @required
    specification: String
    artifact: String
}

structure AgreementTermLinkCreateInput {
    @required
    agreement: String
    @required
    specification: String
    artifact: String
}

structure AgreementTermLinkPatchInput {
}

structure CatalogRecord {
    @required
    id: String
    @required
    key: String
    @required
    label: String
}

structure CatalogCreateInput {
    @required
    key: String
    @required
    label: String
}

structure CatalogPatchInput {
}

structure CatalogEntryRecord {
    @required
    id: String
    @required
    catalog: String
    @required
    key: String
    @required
    specification: String
}

structure CatalogEntryCreateInput {
    @required
    catalog: String
    @required
    key: String
    @required
    specification: String
}

structure CatalogEntryPatchInput {
}

structure OfferRecord {
    @required
    id: String
    @required
    createdAt: String
    @required
    updatedAt: String
    @required
    entry: String
    @required
    revision: Long
    previous: String
    @required
    supplier: String
    @required
    terms: String
    document: String
    support: String
    evaluation: String
    right: String
    requirement: String
    @required
    scope: String
    @required
    validFrom: String
    @required
    validUntil: String
}

structure OfferCreateInput {
    @required
    entry: String
    @required
    revision: Long
    previous: String
    @required
    supplier: String
    @required
    terms: String
    document: String
    support: String
    evaluation: String
    right: String
    requirement: String
    @required
    scope: String
    @required
    validFrom: String
    @required
    validUntil: String
}

structure OfferPatchInput {
}

structure OfferQualificationRecord {
    @required
    id: String
    @required
    createdAt: String
    @required
    updatedAt: String
    @required
    offer: String
    @required
    decisionCase: String
    @required
    approvedOption: String
}

structure OfferQualificationCreateInput {
    @required
    offer: String
    @required
    decisionCase: String
    @required
    approvedOption: String
}

structure OfferQualificationPatchInput {
}

structure ArtifactRecord {
    @required
    id: String
    @required
    key: String
    @required
    label: String
}

structure ArtifactCreateInput {
    @required
    key: String
    @required
    label: String
}

structure ArtifactPatchInput {
}

structure ArtifactComponentRecord {
    @required
    id: String
    @required
    name: String
    @required
    revision: String
    next: String
}

structure ArtifactComponentCreateInput {
    @required
    name: String
    @required
    revision: String
    next: String
}

structure ArtifactComponentPatchInput {
}

structure ArtifactContentRecord {
    @required
    id: String
    @required
    version: Long
    @required
    createdAt: String
    @required
    updatedAt: String
    @required
    uploadState: String
    mediaType: String
    byteCount: String
    digest: String
}

structure ArtifactContentCreateInput {
}

structure ArtifactContentPatchInput {
}

structure ArtifactRevisionRecord {
    @required
    id: String
    @required
    createdAt: String
    @required
    updatedAt: String
    @required
    artifact: String
    @required
    content: String
    @required
    digest: String
    @required
    mediaType: String
    @required
    byteCount: Long
    specificationPin: String
    realization: String
    components: String
}

structure ArtifactRevisionCreateInput {
    @required
    artifact: String
    @required
    content: String
    @required
    digest: String
    @required
    mediaType: String
    @required
    byteCount: Long
    specificationPin: String
    realization: String
    components: String
}

structure ArtifactRevisionPatchInput {
}

structure DecisionCaseRecord {
    @required
    id: String
    @required
    createdAt: String
    @required
    updatedAt: String
    @required
    participationSet: String
    @required
    eligibilityAt: String
    @required
    electors: String
    @required
    rule: String
    @required
    ruleVersion: String
    @required
    threshold: Long
    @required
    optionCount: Long
    @required
    deadline: String
    support: String
    evaluation: String
    reconsideration: String
}

structure DecisionCaseCreateInput {
    @required
    participationSet: String
    @required
    eligibilityAt: String
    @required
    electors: String
    @required
    rule: String
    @required
    ruleVersion: String
    @required
    threshold: Long
    @required
    optionCount: Long
    @required
    deadline: String
    support: String
    evaluation: String
    reconsideration: String
}

structure DecisionCasePatchInput {
}

structure DecisionElectorRecord {
    @required
    id: String
    @required
    participation: String
    ended: String
    next: String
    @required
    depth: Long
}

structure DecisionElectorCreateInput {
    @required
    participation: String
    ended: String
    next: String
    @required
    depth: Long
}

structure DecisionElectorPatchInput {
}

structure DecisionEventRecord {
    @required
    id: String
    @required
    createdAt: String
    @required
    updatedAt: String
    @required
    decisionCase: String
    @required
    ordinal: Long
    previous: String
    @required
    kind: String
    response: String
    outcome: String
    @required
    recordedBy: String
}

structure DecisionEventCreateInput {
    @required
    decisionCase: String
    @required
    ordinal: Long
    previous: String
    @required
    kind: String
    response: String
    outcome: String
    @required
    recordedBy: String
}

structure DecisionEventPatchInput {
}

structure DecisionOptionRecord {
    @required
    id: String
    @required
    decisionCase: String
    @required
    ordinal: Long
    @required
    label: String
}

structure DecisionOptionCreateInput {
    @required
    decisionCase: String
    @required
    ordinal: Long
    @required
    label: String
}

structure DecisionOptionPatchInput {
}

structure DecisionOutcomeRecord {
    @required
    id: String
    @required
    decisionCase: String
    @required
    selected: String
    @required
    responses: String
    @required
    snapshotDigest: String
}

structure DecisionOutcomeCreateInput {
    @required
    decisionCase: String
    @required
    selected: String
    @required
    responses: String
    @required
    snapshotDigest: String
}

structure DecisionOutcomePatchInput {
}

structure DecisionOutcomeMemberRecord {
    @required
    id: String
    @required
    response: String
    next: String
    @required
    depth: Long
}

structure DecisionOutcomeMemberCreateInput {
    @required
    response: String
    next: String
    @required
    depth: Long
}

structure DecisionOutcomeMemberPatchInput {
}

structure DecisionResponseRecord {
    @required
    id: String
    @required
    decisionCase: String
    @required
    voter: String
    @required
    ranking: String
    support: String
    @required
    recordedBy: String
}

structure DecisionResponseCreateInput {
    @required
    decisionCase: String
    @required
    voter: String
    @required
    ranking: String
    support: String
    @required
    recordedBy: String
}

structure DecisionResponsePatchInput {
}

structure EntitlementRecord {
    @required
    id: String
    @required
    createdAt: String
    @required
    updatedAt: String
    @required
    holder: String
    @required
    right: String
    @required
    scope: String
    quantity: String
    unit: String
    @required
    validFrom: String
    validUntil: String
    predecessor: String
    @required
    recordedBy: String
    @required
    reason: String
}

structure EntitlementCreateInput {
    @required
    holder: String
    @required
    right: String
    @required
    scope: String
    quantity: String
    unit: String
    @required
    validFrom: String
    validUntil: String
    predecessor: String
    @required
    recordedBy: String
    @required
    reason: String
}

structure EntitlementPatchInput {
}

structure EntitlementEndRecord {
    @required
    id: String
    @required
    createdAt: String
    @required
    updatedAt: String
    @required
    entitlement: String
    @required
    kind: String
    @required
    effectiveAt: String
    @required
    recordedBy: String
    @required
    reason: String
}

structure EntitlementEndCreateInput {
    @required
    entitlement: String
    @required
    kind: String
    @required
    effectiveAt: String
    @required
    recordedBy: String
    @required
    reason: String
}

structure EntitlementEndPatchInput {
}

structure EntitlementScopeRecord {
    @required
    id: String
    @required
    label: String
}

structure EntitlementScopeCreateInput {
    @required
    label: String
}

structure EntitlementScopePatchInput {
}

structure ObligationRecord {
    @required
    id: String
    @required
    createdAt: String
    @required
    updatedAt: String
    @required
    obligatedParty: String
    @required
    requirement: String
    @required
    scope: String
    quantity: String
    unit: String
    @required
    incurredAt: String
    dueAt: String
    @required
    recordedBy: String
    @required
    reason: String
}

structure ObligationCreateInput {
    @required
    obligatedParty: String
    @required
    requirement: String
    @required
    scope: String
    quantity: String
    unit: String
    @required
    incurredAt: String
    dueAt: String
    @required
    recordedBy: String
    @required
    reason: String
}

structure ObligationPatchInput {
}

structure ObligationEndRecord {
    @required
    id: String
    @required
    createdAt: String
    @required
    updatedAt: String
    @required
    obligation: String
    @required
    kind: String
    @required
    effectiveAt: String
    @required
    recordedBy: String
    @required
    reason: String
}

structure ObligationEndCreateInput {
    @required
    obligation: String
    @required
    kind: String
    @required
    effectiveAt: String
    @required
    recordedBy: String
    @required
    reason: String
}

structure ObligationEndPatchInput {
}

structure RequirementDefinitionRecord {
    @required
    id: String
    @required
    namespace: String
    @required
    name: String
}

structure RequirementDefinitionCreateInput {
    @required
    namespace: String
    @required
    name: String
}

structure RequirementDefinitionPatchInput {
}

structure RightDefinitionRecord {
    @required
    id: String
    @required
    namespace: String
    @required
    name: String
}

structure RightDefinitionCreateInput {
    @required
    namespace: String
    @required
    name: String
}

structure RightDefinitionPatchInput {
}

structure EvaluationExecutorRecord {
    @required
    id: String
    @required
    key: String
    @required
    label: String
}

structure EvaluationExecutorCreateInput {
    @required
    key: String
    @required
    label: String
}

structure EvaluationExecutorPatchInput {
}

structure EvaluationFinishRecord {
    @required
    id: String
    @required
    run: String
    start: String
    @required
    outcome: String
    @required
    finishedAt: String
    support: String
    @required
    reason: String
    @required
    recordedBy: String
}

structure EvaluationFinishCreateInput {
    @required
    run: String
    start: String
    @required
    outcome: String
    @required
    finishedAt: String
    support: String
    @required
    reason: String
    @required
    recordedBy: String
}

structure EvaluationFinishPatchInput {
}

structure EvaluationRunRecord {
    @required
    id: String
    @required
    createdAt: String
    @required
    updatedAt: String
    @required
    evaluationSet: String
    @required
    definition: String
    @required
    executor: String
    parent: String
    @required
    depth: Long
}

structure EvaluationRunCreateInput {
    @required
    evaluationSet: String
    @required
    definition: String
    @required
    executor: String
    parent: String
    @required
    depth: Long
}

structure EvaluationRunPatchInput {
}

structure EvaluationSetRecord {
    @required
    id: String
    @required
    label: String
}

structure EvaluationSetCreateInput {
    @required
    label: String
}

structure EvaluationSetPatchInput {
}

structure EvaluationStartRecord {
    @required
    id: String
    @required
    createdAt: String
    @required
    updatedAt: String
    @required
    run: String
    @required
    startedAt: String
    @required
    recordedBy: String
}

structure EvaluationStartCreateInput {
    @required
    run: String
    @required
    startedAt: String
    @required
    recordedBy: String
}

structure EvaluationStartPatchInput {
}

structure EvidenceBundleRecord {
    @required
    id: String
    @required
    createdAt: String
    @required
    updatedAt: String
    @required
    key: String
    @required
    label: String
    predecessor: String
}

structure EvidenceBundleCreateInput {
    @required
    key: String
    @required
    label: String
    predecessor: String
}

structure EvidenceBundlePatchInput {
}

structure EvidenceItemRecord {
    @required
    id: String
    @required
    createdAt: String
    @required
    updatedAt: String
    @required
    bundle: String
    @required
    source: String
    @required
    sourceRecord: String
    @required
    kind: String
    @required
    observedAt: String
    revision: String
    digest: String
    @required
    provenance: String
}

structure EvidenceItemCreateInput {
    @required
    bundle: String
    @required
    source: String
    @required
    sourceRecord: String
    @required
    kind: String
    @required
    observedAt: String
    revision: String
    digest: String
    @required
    provenance: String
}

structure EvidenceItemPatchInput {
}

structure EvidenceMemberRecord {
    @required
    id: String
    @required
    bundle: String
    @required
    item: String
    next: String
    @required
    depth: Long
}

structure EvidenceMemberCreateInput {
    @required
    bundle: String
    @required
    item: String
    next: String
    @required
    depth: Long
}

structure EvidenceMemberPatchInput {
}

structure EvidenceSealRecord {
    @required
    id: String
    @required
    createdAt: String
    @required
    updatedAt: String
    @required
    bundle: String
    head: String
    @required
    recordedBy: String
}

structure EvidenceSealCreateInput {
    @required
    bundle: String
    head: String
    @required
    recordedBy: String
}

structure EvidenceSealPatchInput {
}

structure EvidenceSourceRecord {
    @required
    id: String
    @required
    key: String
    @required
    label: String
}

structure EvidenceSourceCreateInput {
    @required
    key: String
    @required
    label: String
}

structure EvidenceSourcePatchInput {
}

structure IdentifierRecord {
    @required
    id: String
    @required
    identifierSet: String
    @required
    namespace: String
    issuer: String
    @required
    issuerScope: String
    @required
    value: String
    @required
    validFrom: String
    validUntil: String
}

structure IdentifierCreateInput {
    @required
    identifierSet: String
    @required
    namespace: String
    issuer: String
    @required
    issuerScope: String
    @required
    value: String
    @required
    validFrom: String
    validUntil: String
}

structure IdentifierPatchInput {
}

structure IdentifierDispositionRecord {
    @required
    id: String
    @required
    identifier: String
    replacement: String
    @required
    effectiveAt: String
    @required
    reason: String
}

structure IdentifierDispositionCreateInput {
    @required
    identifier: String
    replacement: String
    @required
    effectiveAt: String
    @required
    reason: String
}

structure IdentifierDispositionPatchInput {
}

structure IdentifierSetRecord {
    @required
    id: String
    @required
    label: String
}

structure IdentifierSetCreateInput {
    @required
    label: String
}

structure IdentifierSetPatchInput {
}

structure IssuerRecord {
    @required
    id: String
    @required
    key: String
}

structure IssuerCreateInput {
    @required
    key: String
}

structure IssuerPatchInput {
}

structure AccountRecord {
    @required
    id: String
    @required
    book: String
    @required
    key: String
    @required
    unit: String
}

structure AccountCreateInput {
    @required
    book: String
    @required
    key: String
    @required
    unit: String
}

structure AccountPatchInput {
}

structure EntryRecord {
    @required
    id: String
    @required
    book: String
    @required
    account: String
    @required
    quantity: String
    next: String
}

structure EntryCreateInput {
    @required
    book: String
    @required
    account: String
    @required
    quantity: String
    next: String
}

structure EntryPatchInput {
}

structure LedgerBookRecord {
    @required
    id: String
    @required
    key: String
}

structure LedgerBookCreateInput {
    @required
    key: String
}

structure LedgerBookPatchInput {
}

structure PostingGroupRecord {
    @required
    id: String
    @required
    createdAt: String
    @required
    updatedAt: String
    @required
    book: String
    @required
    key: String
    @required
    claim: String
    @required
    head: String
    @required
    policy: String
    reversalOf: String
    @required
    reason: String
}

structure PostingGroupCreateInput {
    @required
    book: String
    @required
    key: String
    @required
    claim: String
    @required
    head: String
    @required
    policy: String
    reversalOf: String
    @required
    reason: String
}

structure PostingGroupPatchInput {
}

structure ParticipationRecord {
    @required
    id: String
    @required
    createdAt: String
    @required
    updatedAt: String
    @required
    participationSet: String
    @required
    participant: String
    @required
    role: String
    @required
    validFrom: String
    validUntil: String
    @required
    recordedBy: String
    @required
    reason: String
}

structure ParticipationCreateInput {
    @required
    participationSet: String
    @required
    participant: String
    @required
    role: String
    @required
    validFrom: String
    validUntil: String
    @required
    recordedBy: String
    @required
    reason: String
}

structure ParticipationPatchInput {
}

structure ParticipationEndRecord {
    @required
    id: String
    @required
    createdAt: String
    @required
    updatedAt: String
    @required
    participation: String
    @required
    effectiveAt: String
    @required
    revoked: Boolean
    @required
    recordedBy: String
    @required
    reason: String
}

structure ParticipationEndCreateInput {
    @required
    participation: String
    @required
    effectiveAt: String
    @required
    revoked: Boolean
    @required
    recordedBy: String
    @required
    reason: String
}

structure ParticipationEndPatchInput {
}

structure ParticipationRoleRecord {
    @required
    id: String
    @required
    createdAt: String
    @required
    updatedAt: String
    @required
    namespace: String
    @required
    name: String
}

structure ParticipationRoleCreateInput {
    @required
    namespace: String
    @required
    name: String
}

structure ParticipationRolePatchInput {
}

structure ParticipationSetRecord {
    @required
    id: String
    @required
    createdAt: String
    @required
    updatedAt: String
    @required
    label: String
}

structure ParticipationSetCreateInput {
    @required
    label: String
}

structure ParticipationSetPatchInput {
}

structure PartyRecord {
    @required
    id: String
    @required
    createdAt: String
    @required
    updatedAt: String
    @required
    label: String
    identifiers: String
}

structure PartyCreateInput {
    @required
    label: String
    identifiers: String
}

structure PartyPatchInput {
}

structure PrincipalRepresentationRecord {
    @required
    id: String
    @required
    createdAt: String
    @required
    updatedAt: String
    @required
    party: String
    @required
    principal: String
    @required
    validFrom: String
    validUntil: String
    @required
    recordedBy: String
    @required
    reason: String
}

structure PrincipalRepresentationCreateInput {
    @required
    party: String
    @required
    principal: String
    @required
    validFrom: String
    validUntil: String
    @required
    recordedBy: String
    @required
    reason: String
}

structure PrincipalRepresentationPatchInput {
}

structure RepresentationRevocationRecord {
    @required
    id: String
    @required
    createdAt: String
    @required
    updatedAt: String
    @required
    representation: String
    @required
    effectiveAt: String
    @required
    recordedBy: String
    @required
    reason: String
}

structure RepresentationRevocationCreateInput {
    @required
    representation: String
    @required
    effectiveAt: String
    @required
    recordedBy: String
    @required
    reason: String
}

structure RepresentationRevocationPatchInput {
}

structure PriceAdjustmentRecord {
    @required
    id: String
    @required
    key: String
    @required
    definition: String
    @required
    account: String
    @required
    amount: String
    @required
    reason: String
}

structure PriceAdjustmentCreateInput {
    @required
    key: String
    @required
    definition: String
    @required
    account: String
    @required
    amount: String
    @required
    reason: String
}

structure PriceAdjustmentPatchInput {
}

structure PricingRateRecord {
    @required
    id: String
    @required
    key: String
    @required
    definition: String
    @required
    account: String
    @required
    unitPrice: String
    @required
    validFrom: String
    @required
    validUntil: String
}

structure PricingRateCreateInput {
    @required
    key: String
    @required
    definition: String
    @required
    account: String
    @required
    unitPrice: String
    @required
    validFrom: String
    @required
    validUntil: String
}

structure PricingRatePatchInput {
}

structure QuoteRecord {
    @required
    id: String
    @required
    key: String
    @required
    offer: String
    @required
    buyer: String
    @required
    terms: String
    evaluation: String
    @required
    pricedAt: String
    @required
    expiresAt: String
    @required
    head: String
    previous: String
}

structure QuoteCreateInput {
    @required
    key: String
    @required
    offer: String
    @required
    buyer: String
    @required
    terms: String
    evaluation: String
    @required
    pricedAt: String
    @required
    expiresAt: String
    @required
    head: String
    previous: String
}

structure QuotePatchInput {
}

structure QuoteAgreementRecord {
    @required
    id: String
    @required
    quote: String
    @required
    acceptance: String
    @required
    agreement: String
}

structure QuoteAgreementCreateInput {
    @required
    quote: String
    @required
    acceptance: String
    @required
    agreement: String
}

structure QuoteAgreementPatchInput {
}

structure QuoteEndRecord {
    @required
    id: String
    @required
    createdAt: String
    @required
    updatedAt: String
    @required
    quote: String
    @required
    outcome: String
    successor: String
    intent: String
    acceptanceDigest: String
    @required
    reason: String
}

structure QuoteEndCreateInput {
    @required
    quote: String
    @required
    outcome: String
    successor: String
    intent: String
    acceptanceDigest: String
    @required
    reason: String
}

structure QuoteEndPatchInput {
}

structure QuoteLineRecord {
    @required
    id: String
    @required
    rate: String
    @required
    quantity: String
    adjustment: String
    next: String
}

structure QuoteLineCreateInput {
    @required
    rate: String
    @required
    quantity: String
    adjustment: String
    next: String
}

structure QuoteLinePatchInput {
}

structure RealizationRecord {
    @required
    id: String
    @required
    pin: String
    @required
    buildHash: String
    @required
    manifestDigest: String
}

structure RealizationCreateInput {
    @required
    pin: String
    @required
    buildHash: String
    @required
    manifestDigest: String
}

structure RealizationPatchInput {
}

@http(method: "POST", uri: "/v1/specification/realizations")
operation RealizationCreate {
    input: RealizationCreateInput
    output: RealizationRecord
    errors: [Problem]
}

@http(method: "GET", uri: "/v1/specification/realizations/{id}")
operation RealizationGet {
    input: Unit
    output: RealizationRecord
    errors: [Problem]
}

@http(method: "GET", uri: "/v1/specification/realizations")
operation RealizationList {
    input: Unit
    output: RealizationRecord
    errors: [Problem]
}

@http(method: "GET", uri: "/v1/specification/realizations/queries/by-pin")
operation RealizationList {
    input: Unit
    output: RealizationRecord
    errors: [Problem]
}

structure RepositoryRecord {
    @required
    id: String
    @required
    version: Long
    @required
    key: String
    @required
    provider: String
    @required
    locator: String
}

structure RepositoryCreateInput {
    @required
    key: String
    @required
    provider: String
    @required
    locator: String
}

structure RepositoryPatchInput {
    provider: String
    locator: String
}

@http(method: "POST", uri: "/v1/specification/repositories")
operation RepositoryCreate {
    input: RepositoryCreateInput
    output: RepositoryRecord
    errors: [Problem]
}

@http(method: "GET", uri: "/v1/specification/repositories/{id}")
operation RepositoryGet {
    input: Unit
    output: RepositoryRecord
    errors: [Problem]
}

@http(method: "PATCH", uri: "/v1/specification/repositories/{id}")
operation RepositoryUpdate {
    input: RepositoryPatchInput
    output: RepositoryRecord
    errors: [Problem]
}

@http(method: "DELETE", uri: "/v1/specification/repositories/{id}")
operation RepositoryDelete {
    input: Unit
    output: RepositoryRecord
    errors: [Problem]
}

@http(method: "GET", uri: "/v1/specification/repositories/queries/by-key")
operation RepositoryFind {
    input: Unit
    output: RepositoryRecord
    errors: [Problem]
}

@http(method: "GET", uri: "/v1/specification/repositories")
operation RepositoryList {
    input: Unit
    output: RepositoryRecord
    errors: [Problem]
}

structure SpecificationPinRecord {
    @required
    id: String
    @required
    repository: String
    @required
    anchor: String
    @required
    revision: String
}

structure SpecificationPinCreateInput {
    @required
    repository: String
    @required
    anchor: String
    @required
    revision: String
}

structure SpecificationPinPatchInput {
}

@http(method: "POST", uri: "/v1/specification/pins")
operation SpecificationPinCreate {
    input: SpecificationPinCreateInput
    output: SpecificationPinRecord
    errors: [Problem]
}

@http(method: "GET", uri: "/v1/specification/pins/{id}")
operation SpecificationPinGet {
    input: Unit
    output: SpecificationPinRecord
    errors: [Problem]
}

@http(method: "GET", uri: "/v1/specification/pins/queries/by-repository-anchor-revision")
operation SpecificationPinFind {
    input: Unit
    output: SpecificationPinRecord
    errors: [Problem]
}

@http(method: "GET", uri: "/v1/specification/pins")
operation SpecificationPinList {
    input: Unit
    output: SpecificationPinRecord
    errors: [Problem]
}

@http(method: "GET", uri: "/v1/specification/pins/queries/by-repository-anchor")
operation SpecificationPinList {
    input: Unit
    output: SpecificationPinRecord
    errors: [Problem]
}

structure OrderRecord {
    @required
    id: String
    @required
    acceptance: String
    @required
    agreement: String
}

structure OrderCreateInput {
    @required
    acceptance: String
    @required
    agreement: String
}

structure OrderPatchInput {
    acceptance: String
    agreement: String
}

structure ProcurementQuoteRecord {
    @required
    id: String
    @required
    quote: String
}

structure ProcurementQuoteCreateInput {
    @required
    quote: String
}

structure ProcurementQuotePatchInput {
    quote: String
}

structure SaaSQuoteRecord {
    @required
    id: String
    @required
    quote: String
}

structure SaaSQuoteCreateInput {
    @required
    quote: String
}

structure SaaSQuotePatchInput {
    quote: String
}

structure ServiceQuoteRecord {
    @required
    id: String
    @required
    quote: String
}

structure ServiceQuoteCreateInput {
    @required
    quote: String
}

structure ServiceQuotePatchInput {
    quote: String
}

