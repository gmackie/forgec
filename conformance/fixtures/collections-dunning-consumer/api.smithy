$version: "2.0"

namespace fixture.collections.dunning.consumer

@error("client")
structure Problem {
    @required
    code: String
    @required
    title: String
    detail: String
}

structure B2BCollectionsRecord {
    @required
    id: String
    @required
    collection: String
    @required
    account: String
}

structure B2BCollectionsCreateInput {
    @required
    collection: String
    @required
    account: String
}

structure B2BCollectionsPatchInput {
}

structure ConsumerCollectionsRecord {
    @required
    id: String
    @required
    collection: String
    @required
    account: String
}

structure ConsumerCollectionsCreateInput {
    @required
    collection: String
    @required
    account: String
}

structure ConsumerCollectionsPatchInput {
}

structure EconomicOccurrenceRecord {
    @required
    id: String
    @required
    createdAt: String
    @required
    updatedAt: String
    @required
    fulfillmentEnd: String
    @required
    kind: String
    @required
    creditor: String
    @required
    debtor: String
    @required
    scope: String
    @required
    unit: String
    @required
    quantity: String
    @required
    occurredAt: String
}

structure EconomicOccurrenceCreateInput {
    @required
    fulfillmentEnd: String
    @required
    kind: String
    @required
    creditor: String
    @required
    debtor: String
    @required
    scope: String
    @required
    unit: String
    @required
    quantity: String
    @required
    occurredAt: String
}

structure EconomicOccurrencePatchInput {
}

structure SaaSCollectionsRecord {
    @required
    id: String
    @required
    collection: String
    @required
    account: String
}

structure SaaSCollectionsCreateInput {
    @required
    collection: String
    @required
    account: String
}

structure SaaSCollectionsPatchInput {
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

structure DispositionRecord {
    @required
    id: String
    @required
    createdAt: String
    @required
    updatedAt: String
    @required
    finding: String
    @required
    kind: String
    @required
    reason: String
    @required
    recordedBy: String
}

structure DispositionCreateInput {
    @required
    finding: String
    @required
    kind: String
    @required
    reason: String
    @required
    recordedBy: String
}

structure DispositionPatchInput {
}

structure FindingRecord {
    @required
    id: String
    @required
    createdAt: String
    @required
    updatedAt: String
    @required
    finish: String
    @required
    run: String
    @required
    specification: String
    @required
    summary: String
    predecessor: String
}

structure FindingCreateInput {
    @required
    finish: String
    @required
    run: String
    @required
    specification: String
    @required
    summary: String
    predecessor: String
}

structure FindingPatchInput {
}

structure FindingAttestationRecord {
    @required
    id: String
    @required
    finding: String
    @required
    attestation: String
    @required
    finish: String
    @required
    run: String
}

structure FindingAttestationCreateInput {
    @required
    finding: String
    @required
    attestation: String
    @required
    finish: String
    @required
    run: String
}

structure FindingAttestationPatchInput {
}

structure FindingClosureRecord {
    @required
    id: String
    @required
    createdAt: String
    @required
    updatedAt: String
    @required
    finding: String
    @required
    disposition: String
    remediationFinish: String
    @required
    reason: String
}

structure FindingClosureCreateInput {
    @required
    finding: String
    @required
    disposition: String
    remediationFinish: String
    @required
    reason: String
}

structure FindingClosurePatchInput {
}

structure ReevaluationRecord {
    @required
    id: String
    @required
    remediation: String
    @required
    finding: String
    @required
    finish: String
    @required
    run: String
}

structure ReevaluationCreateInput {
    @required
    remediation: String
    @required
    finding: String
    @required
    finish: String
    @required
    run: String
}

structure ReevaluationPatchInput {
}

structure RemediationRecord {
    @required
    id: String
    @required
    createdAt: String
    @required
    updatedAt: String
    @required
    disposition: String
    @required
    finding: String
    @required
    intendedAction: String
}

structure RemediationCreateInput {
    @required
    disposition: String
    @required
    finding: String
    @required
    intendedAction: String
}

structure RemediationPatchInput {
}

structure RemediationFinishRecord {
    @required
    id: String
    @required
    createdAt: String
    @required
    updatedAt: String
    @required
    remediation: String
    @required
    disposition: String
    @required
    outcome: String
    reevaluation: String
    @required
    reason: String
}

structure RemediationFinishCreateInput {
    @required
    remediation: String
    @required
    disposition: String
    @required
    outcome: String
    reevaluation: String
    @required
    reason: String
}

structure RemediationFinishPatchInput {
}

structure AttestationRecord {
    @required
    id: String
    @required
    createdAt: String
    @required
    updatedAt: String
    @required
    issuer: String
    @required
    subject: String
    @required
    issuerRecord: String
    @required
    specification: String
    @required
    issuedAt: String
    @required
    validFrom: String
    validUntil: String
    @required
    conclusion: String
    @required
    source: String
    support: String
    proof: String
}

structure AttestationCreateInput {
    @required
    issuer: String
    @required
    subject: String
    @required
    issuerRecord: String
    @required
    specification: String
    @required
    issuedAt: String
    @required
    validFrom: String
    validUntil: String
    @required
    conclusion: String
    @required
    source: String
    support: String
    proof: String
}

structure AttestationPatchInput {
}

structure AttestationArtifactSubjectRecord {
    @required
    id: String
    @required
    subject: String
    @required
    revision: String
}

structure AttestationArtifactSubjectCreateInput {
    @required
    subject: String
    @required
    revision: String
}

structure AttestationArtifactSubjectPatchInput {
}

structure AttestationEndRecord {
    @required
    id: String
    @required
    createdAt: String
    @required
    updatedAt: String
    @required
    attestation: String
    replacement: String
    @required
    effectiveAt: String
    @required
    reason: String
    @required
    recordedBy: String
}

structure AttestationEndCreateInput {
    @required
    attestation: String
    replacement: String
    @required
    effectiveAt: String
    @required
    reason: String
    @required
    recordedBy: String
}

structure AttestationEndPatchInput {
}

structure AttestationPartySubjectRecord {
    @required
    id: String
    @required
    subject: String
    @required
    party: String
}

structure AttestationPartySubjectCreateInput {
    @required
    subject: String
    @required
    party: String
}

structure AttestationPartySubjectPatchInput {
}

structure AttestationQualificationSubjectRecord {
    @required
    id: String
    @required
    subject: String
    @required
    qualificationSubject: String
}

structure AttestationQualificationSubjectCreateInput {
    @required
    subject: String
    @required
    qualificationSubject: String
}

structure AttestationQualificationSubjectPatchInput {
}

structure AttestationSubjectRecord {
    @required
    id: String
    @required
    label: String
}

structure AttestationSubjectCreateInput {
    @required
    label: String
}

structure AttestationSubjectPatchInput {
}

structure QualificationAttestationRecord {
    @required
    id: String
    @required
    qualification: String
    @required
    definition: String
    @required
    subject: String
    @required
    issuer: String
    @required
    attestation: String
}

structure QualificationAttestationCreateInput {
    @required
    qualification: String
    @required
    definition: String
    @required
    subject: String
    @required
    issuer: String
    @required
    attestation: String
}

structure QualificationAttestationPatchInput {
}

structure BillRecord {
    @required
    id: String
    @required
    key: String
    @required
    period: String
    @required
    head: String
    corrects: String
    @required
    reason: String
}

structure BillCreateInput {
    @required
    key: String
    @required
    period: String
    @required
    head: String
    corrects: String
    @required
    reason: String
}

structure BillPatchInput {
}

structure BillIssuedRecord {
    @required
    id: String
    @required
    createdAt: String
    @required
    updatedAt: String
    @required
    bill: String
    @required
    digest: String
    @required
    issuedBy: String
}

structure BillIssuedCreateInput {
    @required
    bill: String
    @required
    digest: String
    @required
    issuedBy: String
}

structure BillIssuedPatchInput {
}

structure BillPositionRecord {
    @required
    id: String
    @required
    bill: String
    @required
    issue: String
    @required
    period: String
    @required
    agreement: String
    @required
    position: String
}

structure BillPositionCreateInput {
    @required
    bill: String
    @required
    issue: String
    @required
    period: String
    @required
    agreement: String
    @required
    position: String
}

structure BillPositionPatchInput {
}

structure BilledChargeRecord {
    @required
    id: String
    @required
    bill: String
    @required
    charge: String
}

structure BilledChargeCreateInput {
    @required
    bill: String
    @required
    charge: String
}

structure BilledChargePatchInput {
}

structure BillingChargeRecord {
    @required
    id: String
    @required
    period: String
    @required
    sourceKey: String
    @required
    kind: String
    rate: String
    meter: String
    usageEvent: String
    adjustment: String
    adjustmentFor: String
    @required
    definition: String
    @required
    account: String
    @required
    quantity: String
    @required
    amount: String
    @required
    ratedAt: String
    @required
    source: String
}

structure BillingChargeCreateInput {
    @required
    period: String
    @required
    sourceKey: String
    @required
    kind: String
    rate: String
    meter: String
    usageEvent: String
    adjustment: String
    adjustmentFor: String
    @required
    definition: String
    @required
    account: String
    @required
    quantity: String
    @required
    amount: String
    @required
    ratedAt: String
    @required
    source: String
}

structure BillingChargePatchInput {
}

structure BillingLineRecord {
    @required
    id: String
    @required
    charge: String
    next: String
}

structure BillingLineCreateInput {
    @required
    charge: String
    next: String
}

structure BillingLinePatchInput {
}

structure BillingMeterRateRecord {
    @required
    id: String
    @required
    rate: String
    @required
    dimension: String
}

structure BillingMeterRateCreateInput {
    @required
    rate: String
    @required
    dimension: String
}

structure BillingMeterRatePatchInput {
}

structure BillingPeriodRecord {
    @required
    id: String
    @required
    agreement: String
    @required
    terms: String
    @required
    from: String
    @required
    until: String
}

structure BillingPeriodCreateInput {
    @required
    agreement: String
    @required
    terms: String
    @required
    from: String
    @required
    until: String
}

structure BillingPeriodPatchInput {
}

structure BillingRecurringClaimRecord {
    @required
    id: String
    @required
    period: String
    @required
    rate: String
    @required
    sourceKey: String
}

structure BillingRecurringClaimCreateInput {
    @required
    period: String
    @required
    rate: String
    @required
    sourceKey: String
}

structure BillingRecurringClaimPatchInput {
}

structure CaseRecord {
    @required
    id: String
    @required
    key: String
    @required
    subject: String
    @required
    context: String
    @required
    reason: String
    @required
    owner: String
    @required
    participants: String
    @required
    openedAt: String
}

structure CaseCreateInput {
    @required
    key: String
    @required
    subject: String
    @required
    context: String
    @required
    reason: String
    @required
    owner: String
    @required
    participants: String
    @required
    openedAt: String
}

structure CasePatchInput {
}

structure CaseEventRecord {
    @required
    id: String
    @required
    case: String
    @required
    ordinal: Long
    previous: String
    @required
    kind: String
    @required
    at: String
    @required
    reason: String
    @required
    recordedBy: String
    @required
    closed: Boolean
    @required
    owner: String
    file: String
    interaction: String
    decision: String
    work: String
    milestone: String
    related: String
}

structure CaseEventCreateInput {
    @required
    case: String
    @required
    ordinal: Long
    previous: String
    @required
    kind: String
    @required
    at: String
    @required
    reason: String
    @required
    recordedBy: String
    @required
    closed: Boolean
    @required
    owner: String
    file: String
    interaction: String
    decision: String
    work: String
    milestone: String
    related: String
}

structure CaseEventPatchInput {
}

structure CaseFileRecord {
    @required
    id: String
    @required
    case: String
    evidence: String
    document: String
}

structure CaseFileCreateInput {
    @required
    case: String
    evidence: String
    document: String
}

structure CaseFilePatchInput {
}

structure CaseInteractionRecord {
    @required
    id: String
    @required
    case: String
    @required
    discussion: String
    @required
    purpose: String
    @required
    from: String
    until: String
}

structure CaseInteractionCreateInput {
    @required
    case: String
    @required
    discussion: String
    @required
    purpose: String
    @required
    from: String
    until: String
}

structure CaseInteractionPatchInput {
}

structure CaseMilestoneRecord {
    @required
    id: String
    @required
    case: String
    @required
    key: String
    @required
    criteria: String
    @required
    run: String
    @required
    evaluation: String
    @required
    support: String
    @required
    approval: String
    @required
    accepted: String
}

structure CaseMilestoneCreateInput {
    @required
    case: String
    @required
    key: String
    @required
    criteria: String
    @required
    run: String
    @required
    evaluation: String
    @required
    support: String
    @required
    approval: String
    @required
    accepted: String
}

structure CaseMilestonePatchInput {
}

structure CaseSubjectRecord {
    @required
    id: String
    @required
    key: String
}

structure CaseSubjectCreateInput {
    @required
    key: String
}

structure CaseSubjectPatchInput {
}

structure ChallengeRecord {
    @required
    id: String
    @required
    createdAt: String
    @required
    updatedAt: String
    @required
    decision: String
    @required
    interaction: String
    @required
    requirement: String
    @required
    mechanism: String
    @required
    maxAttempts: Long
    @required
    expiresAt: String
}

structure ChallengeCreateInput {
    @required
    decision: String
    @required
    interaction: String
    @required
    requirement: String
    @required
    mechanism: String
    @required
    maxAttempts: Long
    @required
    expiresAt: String
}

structure ChallengePatchInput {
}

structure ChallengeApprovalRecord {
    @required
    id: String
    @required
    createdAt: String
    @required
    updatedAt: String
    @required
    challenge: String
    @required
    decisionCase: String
    @required
    approvedOption: String
}

structure ChallengeApprovalCreateInput {
    @required
    challenge: String
    @required
    decisionCase: String
    @required
    approvedOption: String
}

structure ChallengeApprovalPatchInput {
}

structure ChallengeAttemptRecord {
    @required
    id: String
    @required
    createdAt: String
    @required
    updatedAt: String
    @required
    challenge: String
    @required
    evaluation: String
    @required
    run: String
    @required
    support: String
    @required
    successful: Boolean
    approval: String
    outcome: String
}

structure ChallengeAttemptCreateInput {
    @required
    challenge: String
    @required
    evaluation: String
    @required
    run: String
    @required
    support: String
    @required
    successful: Boolean
    approval: String
    outcome: String
}

structure ChallengeAttemptPatchInput {
}

structure ChallengeDecisionRecord {
    @required
    id: String
    @required
    createdAt: String
    @required
    updatedAt: String
    @required
    interaction: String
    @required
    policy: String
    @required
    evaluation: String
    @required
    run: String
    @required
    disposition: String
    risk: String
    trust: String
    @required
    support: String
    @required
    reason: String
}

structure ChallengeDecisionCreateInput {
    @required
    interaction: String
    @required
    policy: String
    @required
    evaluation: String
    @required
    run: String
    @required
    disposition: String
    risk: String
    trust: String
    @required
    support: String
    @required
    reason: String
}

structure ChallengeDecisionPatchInput {
}

structure ChallengeEventRecord {
    @required
    id: String
    @required
    createdAt: String
    @required
    updatedAt: String
    @required
    challenge: String
    @required
    ordinal: Long
    previous: String
    @required
    kind: String
    attempt: String
    @required
    reason: String
}

structure ChallengeEventCreateInput {
    @required
    challenge: String
    @required
    ordinal: Long
    previous: String
    @required
    kind: String
    attempt: String
    @required
    reason: String
}

structure ChallengeEventPatchInput {
}

structure ChallengeInteractionRecord {
    @required
    id: String
    @required
    createdAt: String
    @required
    updatedAt: String
    @required
    subject: String
    @required
    action: String
    @required
    startedAt: String
    @required
    until: String
}

structure ChallengeInteractionCreateInput {
    @required
    subject: String
    @required
    action: String
    @required
    startedAt: String
    @required
    until: String
}

structure ChallengeInteractionPatchInput {
}

structure ChallengeParticipantRecord {
    @required
    id: String
    @required
    interaction: String
    @required
    subject: String
}

structure ChallengeParticipantCreateInput {
    @required
    interaction: String
    @required
    subject: String
}

structure ChallengeParticipantPatchInput {
}

structure ChangeRecord {
    @required
    id: String
    @required
    stream: String
    @required
    sequence: Long
    @required
    fromPin: String
    @required
    toPin: String
    @required
    approvalRequired: Boolean
    @required
    verificationRequired: Boolean
    approvalCase: String
    approvedOption: String
}

structure ChangeCreateInput {
    @required
    stream: String
    @required
    sequence: Long
    @required
    fromPin: String
    @required
    toPin: String
    @required
    approvalRequired: Boolean
    @required
    verificationRequired: Boolean
    approvalCase: String
    approvedOption: String
}

structure ChangePatchInput {
}

structure ChangeDecisionLinkRecord {
    @required
    id: String
    @required
    change: String
    @required
    outcome: String
    @required
    terminal: String
    @required
    selected: String
}

structure ChangeDecisionLinkCreateInput {
    @required
    change: String
    @required
    outcome: String
    @required
    terminal: String
    @required
    selected: String
}

structure ChangeDecisionLinkPatchInput {
}

structure ChangeEndRecord {
    @required
    id: String
    @required
    change: String
    @required
    outcome: String
    implementation: String
    fulfillment: String
    fulfillmentEnd: String
    verification: String
    decision: String
    @required
    reason: String
}

structure ChangeEndCreateInput {
    @required
    change: String
    @required
    outcome: String
    implementation: String
    fulfillment: String
    fulfillmentEnd: String
    verification: String
    decision: String
    @required
    reason: String
}

structure ChangeEndPatchInput {
}

structure ChangeImpactLinkRecord {
    @required
    id: String
    @required
    change: String
    @required
    run: String
    @required
    finish: String
}

structure ChangeImpactLinkCreateInput {
    @required
    change: String
    @required
    run: String
    @required
    finish: String
}

structure ChangeImpactLinkPatchInput {
}

structure ChangeImplementationLinkRecord {
    @required
    id: String
    @required
    change: String
    decision: String
    @required
    fulfillment: String
    @required
    scheduledAt: String
}

structure ChangeImplementationLinkCreateInput {
    @required
    change: String
    decision: String
    @required
    fulfillment: String
    @required
    scheduledAt: String
}

structure ChangeImplementationLinkPatchInput {
}

structure ChangeRollbackRecord {
    @required
    id: String
    @required
    change: String
    @required
    ended: String
    @required
    rollback: String
}

structure ChangeRollbackCreateInput {
    @required
    change: String
    @required
    ended: String
    @required
    rollback: String
}

structure ChangeRollbackPatchInput {
}

structure ChangeStreamRecord {
    @required
    id: String
    @required
    key: String
}

structure ChangeStreamCreateInput {
    @required
    key: String
}

structure ChangeStreamPatchInput {
}

structure ChangeSupersessionRecord {
    @required
    id: String
    @required
    prior: String
    @required
    replacement: String
    @required
    reason: String
}

structure ChangeSupersessionCreateInput {
    @required
    prior: String
    @required
    replacement: String
    @required
    reason: String
}

structure ChangeSupersessionPatchInput {
}

structure ChangeVerificationLinkRecord {
    @required
    id: String
    @required
    change: String
    @required
    implementation: String
    @required
    run: String
    @required
    finish: String
    @required
    support: String
}

structure ChangeVerificationLinkCreateInput {
    @required
    change: String
    @required
    implementation: String
    @required
    run: String
    @required
    finish: String
    @required
    support: String
}

structure ChangeVerificationLinkPatchInput {
}

structure AttachmentLinkRecord {
    @required
    id: String
    @required
    thread: String
    @required
    entry: String
    @required
    revision: String
}

structure AttachmentLinkCreateInput {
    @required
    thread: String
    @required
    entry: String
    @required
    revision: String
}

structure AttachmentLinkPatchInput {
}

structure MentionRecord {
    @required
    id: String
    @required
    thread: String
    @required
    entry: String
    @required
    participant: String
}

structure MentionCreateInput {
    @required
    thread: String
    @required
    entry: String
    @required
    participant: String
}

structure MentionPatchInput {
}

structure ReactionRecord {
    @required
    id: String
    @required
    thread: String
    @required
    entry: String
    @required
    author: String
    @required
    code: String
}

structure ReactionCreateInput {
    @required
    thread: String
    @required
    entry: String
    @required
    author: String
    @required
    code: String
}

structure ReactionPatchInput {
}

structure ThreadRecord {
    @required
    id: String
    @required
    participants: String
    @required
    title: String
}

structure ThreadCreateInput {
    @required
    participants: String
    @required
    title: String
}

structure ThreadPatchInput {
}

structure ThreadEntryRecord {
    @required
    id: String
    @required
    thread: String
    @required
    author: String
    @required
    body: String
    corrects: String
    @required
    recordedAt: String
}

structure ThreadEntryCreateInput {
    @required
    thread: String
    @required
    author: String
    @required
    body: String
    corrects: String
    @required
    recordedAt: String
}

structure ThreadEntryPatchInput {
}

structure ThreadEventRecord {
    @required
    id: String
    @required
    thread: String
    @required
    sequence: Long
    previous: String
    @required
    kind: String
    @required
    actor: String
    @required
    at: String
    @required
    closed: Boolean
    entry: String
    reaction: String
    mention: String
    attachment: String
}

structure ThreadEventCreateInput {
    @required
    thread: String
    @required
    sequence: Long
    previous: String
    @required
    kind: String
    @required
    actor: String
    @required
    at: String
    @required
    closed: Boolean
    entry: String
    reaction: String
    mention: String
    attachment: String
}

structure ThreadEventPatchInput {
}

structure ThreadParticipantRecord {
    @required
    id: String
    @required
    thread: String
    @required
    membership: String
}

structure ThreadParticipantCreateInput {
    @required
    thread: String
    @required
    membership: String
}

structure ThreadParticipantPatchInput {
}

structure CollectionRecord {
    @required
    id: String
    @required
    createdAt: String
    @required
    updatedAt: String
    @required
    key: String
    @required
    case: String
    @required
    position: String
    @required
    policy: String
    @required
    openedAt: String
}

structure CollectionCreateInput {
    @required
    key: String
    @required
    case: String
    @required
    position: String
    @required
    policy: String
    @required
    openedAt: String
}

structure CollectionPatchInput {
}

structure CollectionClosureRecord {
    @required
    id: String
    @required
    createdAt: String
    @required
    updatedAt: String
    @required
    collection: String
    @required
    closure: String
    @required
    kind: String
    disposition: String
}

structure CollectionClosureCreateInput {
    @required
    collection: String
    @required
    closure: String
    @required
    kind: String
    disposition: String
}

structure CollectionClosurePatchInput {
}

structure CollectionDispositionRecord {
    @required
    id: String
    @required
    collection: String
    @required
    kind: String
    @required
    policy: String
    @required
    evaluation: String
    @required
    run: String
    @required
    approval: String
    @required
    accepted: String
    posting: String
    recovery: String
    @required
    at: String
    @required
    support: String
}

structure CollectionDispositionCreateInput {
    @required
    collection: String
    @required
    kind: String
    @required
    policy: String
    @required
    evaluation: String
    @required
    run: String
    @required
    approval: String
    @required
    accepted: String
    posting: String
    recovery: String
    @required
    at: String
    @required
    support: String
}

structure CollectionDispositionPatchInput {
}

structure CollectionDisputeRecord {
    @required
    id: String
    @required
    collection: String
    @required
    dispute: String
    @required
    billPosition: String
}

structure CollectionDisputeCreateInput {
    @required
    collection: String
    @required
    dispute: String
    @required
    billPosition: String
}

structure CollectionDisputePatchInput {
}

structure CollectionNoticeRecord {
    @required
    id: String
    @required
    collection: String
    @required
    notification: String
    interaction: String
}

structure CollectionNoticeCreateInput {
    @required
    collection: String
    @required
    notification: String
    interaction: String
}

structure CollectionNoticePatchInput {
}

structure CollectionPolicyRecord {
    @required
    id: String
    @required
    key: String
    @required
    definition: String
    @required
    warningDays: Long
    @required
    escalationDays: Long
}

structure CollectionPolicyCreateInput {
    @required
    key: String
    @required
    definition: String
    @required
    warningDays: Long
    @required
    escalationDays: Long
}

structure CollectionPolicyPatchInput {
}

structure PaymentPromiseRecord {
    @required
    id: String
    @required
    createdAt: String
    @required
    updatedAt: String
    @required
    collection: String
    @required
    arrangement: String
    @required
    approval: String
    @required
    accepted: String
    @required
    amount: String
    @required
    unit: String
    @required
    at: String
    @required
    dueAt: String
    challenge: String
    subject: String
    partySubject: String
    @required
    support: String
}

structure PaymentPromiseCreateInput {
    @required
    collection: String
    @required
    arrangement: String
    @required
    approval: String
    @required
    accepted: String
    @required
    amount: String
    @required
    unit: String
    @required
    at: String
    @required
    dueAt: String
    challenge: String
    subject: String
    partySubject: String
    @required
    support: String
}

structure PaymentPromisePatchInput {
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

structure DeliveryAttemptRecord {
    @required
    id: String
    @required
    createdAt: String
    @required
    updatedAt: String
    @required
    step: String
    @required
    startedAt: String
    @required
    provider: String
    @required
    providerKey: String
}

structure DeliveryAttemptCreateInput {
    @required
    step: String
    @required
    startedAt: String
    @required
    provider: String
    @required
    providerKey: String
}

structure DeliveryAttemptPatchInput {
}

structure DeliveryDestinationRecord {
    @required
    id: String
    @required
    key: String
    @required
    label: String
}

structure DeliveryDestinationCreateInput {
    @required
    key: String
    @required
    label: String
}

structure DeliveryDestinationPatchInput {
}

structure DeliveryIntentRecord {
    @required
    id: String
    @required
    createdAt: String
    @required
    updatedAt: String
    @required
    key: String
    @required
    destination: String
    payload: String
    @required
    maxAttempts: Long
}

structure DeliveryIntentCreateInput {
    @required
    key: String
    @required
    destination: String
    payload: String
    @required
    maxAttempts: Long
}

structure DeliveryIntentPatchInput {
}

structure DeliveryReceiptRecord {
    @required
    id: String
    @required
    createdAt: String
    @required
    updatedAt: String
    @required
    step: String
    @required
    attempt: String
    @required
    outcome: String
    @required
    completedAt: String
    @required
    providerReference: String
    @required
    callbackKey: String
    @required
    detail: String
    support: String
}

structure DeliveryReceiptCreateInput {
    @required
    step: String
    @required
    attempt: String
    @required
    outcome: String
    @required
    completedAt: String
    @required
    providerReference: String
    @required
    callbackKey: String
    @required
    detail: String
    support: String
}

structure DeliveryReceiptPatchInput {
}

structure DeliveryResolutionRecord {
    @required
    id: String
    @required
    createdAt: String
    @required
    updatedAt: String
    @required
    receipt: String
    @required
    outcome: String
    @required
    resolvedAt: String
    @required
    detail: String
    support: String
}

structure DeliveryResolutionCreateInput {
    @required
    receipt: String
    @required
    outcome: String
    @required
    resolvedAt: String
    @required
    detail: String
    support: String
}

structure DeliveryResolutionPatchInput {
}

structure DeliveryStepRecord {
    @required
    id: String
    @required
    createdAt: String
    @required
    updatedAt: String
    @required
    intent: String
    @required
    number: Long
    @required
    choice: String
    previous: String
    receipt: String
    resolution: String
    @required
    reason: String
}

structure DeliveryStepCreateInput {
    @required
    intent: String
    @required
    number: Long
    @required
    choice: String
    previous: String
    receipt: String
    resolution: String
    @required
    reason: String
}

structure DeliveryStepPatchInput {
}

structure ContestedFactRecord {
    @required
    id: String
    decision: String
    charge: String
    finding: String
    outcome: String
}

structure ContestedFactCreateInput {
    decision: String
    charge: String
    finding: String
    outcome: String
}

structure ContestedFactPatchInput {
}

structure DisputeRecord {
    @required
    id: String
    @required
    key: String
    @required
    case: String
    @required
    contested: String
    @required
    appellant: String
    @required
    grounds: String
    @required
    requestedRemedy: String
    @required
    support: String
    @required
    jurisdiction: String
    @required
    policy: String
    @required
    authority: String
    @required
    reviewer: String
    @required
    mandate: String
    @required
    filedAt: String
    @required
    filingDeadline: String
    @required
    reviewDeadline: String
    @required
    evaluation: String
    @required
    decision: String
    @required
    uphold: String
    @required
    modify: String
    @required
    reverse: String
    @required
    remand: String
    previous: String
    priorResult: String
    @required
    level: Long
}

structure DisputeCreateInput {
    @required
    key: String
    @required
    case: String
    @required
    contested: String
    @required
    appellant: String
    @required
    grounds: String
    @required
    requestedRemedy: String
    @required
    support: String
    @required
    jurisdiction: String
    @required
    policy: String
    @required
    authority: String
    @required
    reviewer: String
    @required
    mandate: String
    @required
    filedAt: String
    @required
    filingDeadline: String
    @required
    reviewDeadline: String
    @required
    evaluation: String
    @required
    decision: String
    @required
    uphold: String
    @required
    modify: String
    @required
    reverse: String
    @required
    remand: String
    previous: String
    priorResult: String
    @required
    level: Long
}

structure DisputePatchInput {
}

structure DisputeRemedyRecord {
    @required
    id: String
    @required
    result: String
    @required
    implementation: String
    fulfillment: String
    adjustment: String
    change: String
    @required
    support: String
    @required
    at: String
}

structure DisputeRemedyCreateInput {
    @required
    result: String
    @required
    implementation: String
    fulfillment: String
    adjustment: String
    change: String
    @required
    support: String
    @required
    at: String
}

structure DisputeRemedyPatchInput {
}

structure DisputeResultRecord {
    @required
    id: String
    @required
    dispute: String
    @required
    review: String
    @required
    decision: String
    @required
    verdict: String
    @required
    rationale: String
    @required
    support: String
    @required
    at: String
}

structure DisputeResultCreateInput {
    @required
    dispute: String
    @required
    review: String
    @required
    decision: String
    @required
    verdict: String
    @required
    rationale: String
    @required
    support: String
    @required
    at: String
}

structure DisputeResultPatchInput {
}

structure ReviewMandateRecord {
    @required
    id: String
    @required
    authority: String
    @required
    reviewer: String
    @required
    jurisdiction: String
    @required
    policy: String
    @required
    support: String
    @required
    from: String
    @required
    until: String
}

structure ReviewMandateCreateInput {
    @required
    authority: String
    @required
    reviewer: String
    @required
    jurisdiction: String
    @required
    policy: String
    @required
    support: String
    @required
    from: String
    @required
    until: String
}

structure ReviewMandatePatchInput {
}

structure ReviewMandateEndRecord {
    @required
    id: String
    @required
    mandate: String
    @required
    at: String
    @required
    reason: String
}

structure ReviewMandateEndCreateInput {
    @required
    mandate: String
    @required
    at: String
    @required
    reason: String
}

structure ReviewMandateEndPatchInput {
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

structure EvaluationQuarantineRecord {
    @required
    id: String
    @required
    createdAt: String
    @required
    updatedAt: String
    @required
    run: String
    @required
    sourceDigest: String
    @required
    reason: String
    @required
    recordedBy: String
}

structure EvaluationQuarantineCreateInput {
    @required
    run: String
    @required
    sourceDigest: String
    @required
    reason: String
    @required
    recordedBy: String
}

structure EvaluationQuarantinePatchInput {
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

structure FulfillmentRecord {
    @required
    id: String
    @required
    fulfillmentSet: String
    @required
    ordinal: Long
    specificationPin: String
    @required
    executor: String
    @required
    requestedAt: String
    evidence: String
}

structure FulfillmentCreateInput {
    @required
    fulfillmentSet: String
    @required
    ordinal: Long
    specificationPin: String
    @required
    executor: String
    @required
    requestedAt: String
    evidence: String
}

structure FulfillmentPatchInput {
}

structure FulfillmentEndRecord {
    @required
    id: String
    @required
    fulfillment: String
    start: String
    @required
    outcome: String
    @required
    coverage: String
    @required
    endedAt: String
    evidence: String
    @required
    reason: String
    @required
    recordedBy: String
}

structure FulfillmentEndCreateInput {
    @required
    fulfillment: String
    start: String
    @required
    outcome: String
    @required
    coverage: String
    @required
    endedAt: String
    evidence: String
    @required
    reason: String
    @required
    recordedBy: String
}

structure FulfillmentEndPatchInput {
}

structure FulfillmentExecutorRecord {
    @required
    id: String
    @required
    key: String
}

structure FulfillmentExecutorCreateInput {
    @required
    key: String
}

structure FulfillmentExecutorPatchInput {
}

structure FulfillmentReplacementRecord {
    @required
    id: String
    @required
    prior: String
    @required
    priorEnd: String
    @required
    replacement: String
    @required
    reason: String
}

structure FulfillmentReplacementCreateInput {
    @required
    prior: String
    @required
    priorEnd: String
    @required
    replacement: String
    @required
    reason: String
}

structure FulfillmentReplacementPatchInput {
}

structure FulfillmentSetRecord {
    @required
    id: String
    @required
    label: String
}

structure FulfillmentSetCreateInput {
    @required
    label: String
}

structure FulfillmentSetPatchInput {
}

structure FulfillmentStartRecord {
    @required
    id: String
    @required
    fulfillment: String
    @required
    beganAt: String
    @required
    recordedBy: String
}

structure FulfillmentStartCreateInput {
    @required
    fulfillment: String
    @required
    beganAt: String
    @required
    recordedBy: String
}

structure FulfillmentStartPatchInput {
}

structure FulfillmentTaskLinkRecord {
    @required
    id: String
    @required
    fulfillment: String
    @required
    queue: String
    @required
    task: String
}

structure FulfillmentTaskLinkCreateInput {
    @required
    fulfillment: String
    @required
    queue: String
    @required
    task: String
}

structure FulfillmentTaskLinkPatchInput {
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

structure NotificationRecord {
    @required
    id: String
    @required
    key: String
    @required
    subscription: String
    @required
    preference: String
    content: String
    template: String
    @required
    at: String
}

structure NotificationCreateInput {
    @required
    key: String
    @required
    subscription: String
    @required
    preference: String
    content: String
    template: String
    @required
    at: String
}

structure NotificationPatchInput {
}

structure NotificationDeliveryLinkRecord {
    @required
    id: String
    @required
    notification: String
    @required
    preference: String
    @required
    endpoint: String
    @required
    subscription: String
    @required
    intent: String
}

structure NotificationDeliveryLinkCreateInput {
    @required
    notification: String
    @required
    preference: String
    @required
    endpoint: String
    @required
    subscription: String
    @required
    intent: String
}

structure NotificationDeliveryLinkPatchInput {
}

structure NotificationEndpointLinkRecord {
    @required
    id: String
    @required
    recipient: String
    @required
    destination: String
}

structure NotificationEndpointLinkCreateInput {
    @required
    recipient: String
    @required
    destination: String
}

structure NotificationEndpointLinkPatchInput {
}

structure NotificationPreferenceRecord {
    @required
    id: String
    @required
    subscription: String
    @required
    revision: Long
    previous: String
    @required
    enabled: Boolean
    @required
    reason: String
}

structure NotificationPreferenceCreateInput {
    @required
    subscription: String
    @required
    revision: Long
    previous: String
    @required
    enabled: Boolean
    @required
    reason: String
}

structure NotificationPreferencePatchInput {
}

structure NotificationSubscriptionRecord {
    @required
    id: String
    @required
    topic: String
    @required
    recipient: String
    @required
    endpoint: String
}

structure NotificationSubscriptionCreateInput {
    @required
    topic: String
    @required
    recipient: String
    @required
    endpoint: String
}

structure NotificationSubscriptionPatchInput {
}

structure NotificationSuppressionRecord {
    @required
    id: String
    @required
    notification: String
    @required
    preference: String
    @required
    reason: String
}

structure NotificationSuppressionCreateInput {
    @required
    notification: String
    @required
    preference: String
    @required
    reason: String
}

structure NotificationSuppressionPatchInput {
}

structure NotificationTopicRecord {
    @required
    id: String
    @required
    key: String
    @required
    label: String
}

structure NotificationTopicCreateInput {
    @required
    key: String
    @required
    label: String
}

structure NotificationTopicPatchInput {
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

structure PartySubjectRecord {
    @required
    id: String
    @required
    subject: String
    @required
    party: String
}

structure PartySubjectCreateInput {
    @required
    subject: String
    @required
    party: String
}

structure PartySubjectPatchInput {
}

structure QualificationRecord {
    @required
    id: String
    @required
    createdAt: String
    @required
    updatedAt: String
    @required
    subject: String
    @required
    definition: String
    level: String
    @required
    issuer: String
    @required
    issuerRecord: String
    @required
    issuedAt: String
    expiresAt: String
    support: String
    @required
    recordedBy: String
}

structure QualificationCreateInput {
    @required
    subject: String
    @required
    definition: String
    level: String
    @required
    issuer: String
    @required
    issuerRecord: String
    @required
    issuedAt: String
    expiresAt: String
    support: String
    @required
    recordedBy: String
}

structure QualificationPatchInput {
}

structure QualificationDefinitionRecord {
    @required
    id: String
    @required
    createdAt: String
    @required
    updatedAt: String
    @required
    key: String
    @required
    pin: String
    @required
    label: String
}

structure QualificationDefinitionCreateInput {
    @required
    key: String
    @required
    pin: String
    @required
    label: String
}

structure QualificationDefinitionPatchInput {
}

structure QualificationLevelRecord {
    @required
    id: String
    @required
    definition: String
    @required
    code: String
    @required
    rank: Long
}

structure QualificationLevelCreateInput {
    @required
    definition: String
    @required
    code: String
    @required
    rank: Long
}

structure QualificationLevelPatchInput {
}

structure QualificationRequirementRecord {
    @required
    id: String
    @required
    definition: String
    minimumLevel: String
}

structure QualificationRequirementCreateInput {
    @required
    definition: String
    minimumLevel: String
}

structure QualificationRequirementPatchInput {
}

structure QualificationRevocationRecord {
    @required
    id: String
    @required
    createdAt: String
    @required
    updatedAt: String
    @required
    qualification: String
    @required
    effectiveAt: String
    @required
    reason: String
    @required
    recordedBy: String
}

structure QualificationRevocationCreateInput {
    @required
    qualification: String
    @required
    effectiveAt: String
    @required
    reason: String
    @required
    recordedBy: String
}

structure QualificationRevocationPatchInput {
}

structure QualificationSubjectRecord {
    @required
    id: String
    @required
    createdAt: String
    @required
    updatedAt: String
    @required
    label: String
}

structure QualificationSubjectCreateInput {
    @required
    label: String
}

structure QualificationSubjectPatchInput {
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

structure ResidualRiskRecord {
    @required
    id: String
    @required
    treatment: String
    @required
    baseline: String
    @required
    residual: String
}

structure ResidualRiskCreateInput {
    @required
    treatment: String
    @required
    baseline: String
    @required
    residual: String
}

structure ResidualRiskPatchInput {
}

structure RiskRecord {
    @required
    id: String
    @required
    scenario: String
}

structure RiskCreateInput {
    @required
    scenario: String
}

structure RiskPatchInput {
}

structure RiskAcceptanceRecord {
    @required
    id: String
    @required
    assessment: String
    @required
    decisionCase: String
    @required
    outcome: String
    @required
    reason: String
}

structure RiskAcceptanceCreateInput {
    @required
    assessment: String
    @required
    decisionCase: String
    @required
    outcome: String
    @required
    reason: String
}

structure RiskAcceptancePatchInput {
}

structure RiskAssessmentRecord {
    @required
    id: String
    @required
    risk: String
    @required
    revision: Long
    predecessor: String
    @required
    likelihood: String
    @required
    impact: String
    @required
    confidence: String
    @required
    evaluation: String
    @required
    support: String
    @required
    assessedAt: String
}

structure RiskAssessmentCreateInput {
    @required
    risk: String
    @required
    revision: Long
    predecessor: String
    @required
    likelihood: String
    @required
    impact: String
    @required
    confidence: String
    @required
    evaluation: String
    @required
    support: String
    @required
    assessedAt: String
}

structure RiskAssessmentPatchInput {
}

structure RiskLevelRecord {
    @required
    id: String
    @required
    scale: String
    @required
    code: String
    @required
    rank: Long
}

structure RiskLevelCreateInput {
    @required
    scale: String
    @required
    code: String
    @required
    rank: Long
}

structure RiskLevelPatchInput {
}

structure RiskScaleRecord {
    @required
    id: String
    @required
    key: String
    @required
    label: String
}

structure RiskScaleCreateInput {
    @required
    key: String
    @required
    label: String
}

structure RiskScalePatchInput {
}

structure RiskTreatmentRecord {
    @required
    id: String
    @required
    assessment: String
    @required
    fulfillmentSet: String
    @required
    action: String
}

structure RiskTreatmentCreateInput {
    @required
    assessment: String
    @required
    fulfillmentSet: String
    @required
    action: String
}

structure RiskTreatmentPatchInput {
}

structure SettlementBookRecord {
    @required
    id: String
    @required
    key: String
}

structure SettlementBookCreateInput {
    @required
    key: String
}

structure SettlementBookPatchInput {
}

structure SettlementCommitRecord {
    @required
    id: String
    @required
    createdAt: String
    @required
    updatedAt: String
    @required
    book: String
    @required
    ordinal: Long
    previous: String
    @required
    event: String
    source: String
    @required
    key: String
}

structure SettlementCommitCreateInput {
    @required
    book: String
    @required
    ordinal: Long
    previous: String
    @required
    event: String
    source: String
    @required
    key: String
}

structure SettlementCommitPatchInput {
}

structure SettlementEventRecord {
    @required
    id: String
    @required
    book: String
    @required
    key: String
    @required
    kind: String
    @required
    head: String
    source: String
    @required
    occurredAt: String
    @required
    effectiveAt: String
    reversalOf: String
    @required
    reason: String
}

structure SettlementEventCreateInput {
    @required
    book: String
    @required
    key: String
    @required
    kind: String
    @required
    head: String
    source: String
    @required
    occurredAt: String
    @required
    effectiveAt: String
    reversalOf: String
    @required
    reason: String
}

structure SettlementEventPatchInput {
}

structure SettlementLedgerLinkRecord {
    @required
    id: String
    @required
    createdAt: String
    @required
    updatedAt: String
    @required
    publication: String
    @required
    posting: String
    @required
    reason: String
}

structure SettlementLedgerLinkCreateInput {
    @required
    publication: String
    @required
    posting: String
    @required
    reason: String
}

structure SettlementLedgerLinkPatchInput {
}

structure SettlementLineRecord {
    @required
    id: String
    @required
    book: String
    @required
    position: String
    @required
    quantity: String
    next: String
}

structure SettlementLineCreateInput {
    @required
    book: String
    @required
    position: String
    @required
    quantity: String
    next: String
}

structure SettlementLinePatchInput {
}

structure SettlementPositionRecord {
    @required
    id: String
    @required
    createdAt: String
    @required
    updatedAt: String
    @required
    book: String
    @required
    obligation: String
    @required
    creditor: String
    @required
    debtor: String
    agreement: String
    @required
    unit: String
    @required
    ceiling: String
    dueAt: String
    @required
    reason: String
}

structure SettlementPositionCreateInput {
    @required
    book: String
    @required
    obligation: String
    @required
    creditor: String
    @required
    debtor: String
    agreement: String
    @required
    unit: String
    @required
    ceiling: String
    dueAt: String
    @required
    reason: String
}

structure SettlementPositionPatchInput {
}

structure SettlementSourceRecord {
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
    kind: String
    @required
    unit: String
    @required
    quantity: String
    @required
    occurredAt: String
    @required
    fulfillmentEnd: String
    @required
    reason: String
}

structure SettlementSourceCreateInput {
    @required
    book: String
    @required
    key: String
    @required
    kind: String
    @required
    unit: String
    @required
    quantity: String
    @required
    occurredAt: String
    @required
    fulfillmentEnd: String
    @required
    reason: String
}

structure SettlementSourcePatchInput {
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

structure DisputeResolutionRecord {
    @required
    id: String
    @required
    createdAt: String
    @required
    updatedAt: String
    @required
    dispute: String
    @required
    upheld: Boolean
    @required
    effectiveAt: String
    @required
    reason: String
    @required
    support: String
}

structure DisputeResolutionCreateInput {
    @required
    dispute: String
    @required
    upheld: Boolean
    @required
    effectiveAt: String
    @required
    reason: String
    @required
    support: String
}

structure DisputeResolutionPatchInput {
}

structure RiskTrustInputRecord {
    @required
    id: String
    @required
    createdAt: String
    @required
    updatedAt: String
    @required
    assessment: String
    @required
    trust: String
    @required
    rationale: String
}

structure RiskTrustInputCreateInput {
    @required
    assessment: String
    @required
    trust: String
    @required
    rationale: String
}

structure RiskTrustInputPatchInput {
}

structure SignalCorrectionRecord {
    @required
    id: String
    @required
    createdAt: String
    @required
    updatedAt: String
    @required
    signal: String
    replacement: String
    @required
    effectiveAt: String
    @required
    reason: String
    @required
    support: String
}

structure SignalCorrectionCreateInput {
    @required
    signal: String
    replacement: String
    @required
    effectiveAt: String
    @required
    reason: String
    @required
    support: String
}

structure SignalCorrectionPatchInput {
}

structure SignalDisputeRecord {
    @required
    id: String
    @required
    createdAt: String
    @required
    updatedAt: String
    @required
    signal: String
    @required
    raisedBy: String
    @required
    effectiveAt: String
    @required
    reason: String
    @required
    support: String
}

structure SignalDisputeCreateInput {
    @required
    signal: String
    @required
    raisedBy: String
    @required
    effectiveAt: String
    @required
    reason: String
    @required
    support: String
}

structure SignalDisputePatchInput {
}

structure SignalKindRecord {
    @required
    id: String
    @required
    dimension: String
    @required
    key: String
    @required
    definition: String
}

structure SignalKindCreateInput {
    @required
    dimension: String
    @required
    key: String
    @required
    definition: String
}

structure SignalKindPatchInput {
}

structure SignalMemberRecord {
    @required
    id: String
    @required
    signal: String
    @required
    rationale: String
    next: String
    @required
    depth: Long
}

structure SignalMemberCreateInput {
    @required
    signal: String
    @required
    rationale: String
    next: String
    @required
    depth: Long
}

structure SignalMemberPatchInput {
}

structure TrustAssessmentRecord {
    @required
    id: String
    @required
    createdAt: String
    @required
    updatedAt: String
    @required
    review: String
    @required
    dimension: String
    @required
    run: String
    @required
    finish: String
    @required
    score: String
    @required
    confidence: String
    @required
    explanation: String
}

structure TrustAssessmentCreateInput {
    @required
    review: String
    @required
    dimension: String
    @required
    run: String
    @required
    finish: String
    @required
    score: String
    @required
    confidence: String
    @required
    explanation: String
}

structure TrustAssessmentPatchInput {
}

structure TrustDimensionRecord {
    @required
    id: String
    @required
    key: String
    @required
    context: String
    @required
    method: String
    @required
    minimum: String
    @required
    maximum: String
}

structure TrustDimensionCreateInput {
    @required
    key: String
    @required
    context: String
    @required
    method: String
    @required
    minimum: String
    @required
    maximum: String
}

structure TrustDimensionPatchInput {
}

structure TrustPartySubjectRecord {
    @required
    id: String
    @required
    subject: String
    @required
    party: String
}

structure TrustPartySubjectCreateInput {
    @required
    subject: String
    @required
    party: String
}

structure TrustPartySubjectPatchInput {
}

structure TrustReviewRecord {
    @required
    id: String
    @required
    createdAt: String
    @required
    updatedAt: String
    @required
    subject: String
    @required
    dimension: String
    @required
    windowFrom: String
    @required
    windowUntil: String
    @required
    evaluations: String
    @required
    head: String
}

structure TrustReviewCreateInput {
    @required
    subject: String
    @required
    dimension: String
    @required
    windowFrom: String
    @required
    windowUntil: String
    @required
    evaluations: String
    @required
    head: String
}

structure TrustReviewPatchInput {
}

structure TrustSignalRecord {
    @required
    id: String
    @required
    createdAt: String
    @required
    updatedAt: String
    @required
    subject: String
    @required
    dimension: String
    @required
    kind: String
    @required
    issuer: String
    @required
    sourceRecord: String
    @required
    observedAt: String
    @required
    support: String
    @required
    explanation: String
}

structure TrustSignalCreateInput {
    @required
    subject: String
    @required
    dimension: String
    @required
    kind: String
    @required
    issuer: String
    @required
    sourceRecord: String
    @required
    observedAt: String
    @required
    support: String
    @required
    explanation: String
}

structure TrustSignalPatchInput {
}

structure TrustSubjectRecord {
    @required
    id: String
    @required
    label: String
}

structure TrustSubjectCreateInput {
    @required
    label: String
}

structure TrustSubjectPatchInput {
}

structure UsageCorrectionRecord {
    @required
    id: String
    @required
    event: String
    replacement: String
    @required
    reason: String
}

structure UsageCorrectionCreateInput {
    @required
    event: String
    replacement: String
    @required
    reason: String
}

structure UsageCorrectionPatchInput {
}

structure UsageDimensionRecord {
    @required
    id: String
    @required
    key: String
    @required
    unit: String
}

structure UsageDimensionCreateInput {
    @required
    key: String
    @required
    unit: String
}

structure UsageDimensionPatchInput {
}

structure UsageEventRecord {
    @required
    id: String
    @required
    stream: String
    @required
    dimension: String
    @required
    unit: String
    @required
    quantity: String
    @required
    ordinal: Long
    @required
    source: String
    @required
    eventKey: String
    occurredAt: String
    intervalStart: String
    intervalEnd: String
    replacementFor: String
}

structure UsageEventCreateInput {
    @required
    stream: String
    @required
    dimension: String
    @required
    unit: String
    @required
    quantity: String
    @required
    ordinal: Long
    @required
    source: String
    @required
    eventKey: String
    occurredAt: String
    intervalStart: String
    intervalEnd: String
    replacementFor: String
}

structure UsageEventPatchInput {
}

structure UsageSourceRecord {
    @required
    id: String
    @required
    key: String
}

structure UsageSourceCreateInput {
    @required
    key: String
}

structure UsageSourcePatchInput {
}

structure UsageStreamRecord {
    @required
    id: String
    @required
    label: String
    @required
    dimension: String
}

structure UsageStreamCreateInput {
    @required
    label: String
    @required
    dimension: String
}

structure UsageStreamPatchInput {
}

