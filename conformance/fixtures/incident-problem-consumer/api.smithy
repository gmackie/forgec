$version: "2.0"

namespace fixture.incident.problem.consumer

@error("client")
structure Problem {
    @required
    code: String
    @required
    title: String
    detail: String
}

structure CustomerProblemRecord {
    @required
    id: String
    @required
    problem: String
    @required
    product: String
}

structure CustomerProblemCreateInput {
    @required
    problem: String
    @required
    product: String
}

structure CustomerProblemPatchInput {
}

structure QualityIncidentRecord {
    @required
    id: String
    @required
    incident: String
    @required
    line: String
}

structure QualityIncidentCreateInput {
    @required
    incident: String
    @required
    line: String
}

structure QualityIncidentPatchInput {
}

structure SecurityIncidentRecord {
    @required
    id: String
    @required
    incident: String
    @required
    category: String
}

structure SecurityIncidentCreateInput {
    @required
    incident: String
    @required
    category: String
}

structure SecurityIncidentPatchInput {
}

structure ServiceIncidentRecord {
    @required
    id: String
    @required
    incident: String
    @required
    service: String
}

structure ServiceIncidentCreateInput {
    @required
    incident: String
    @required
    service: String
}

structure ServiceIncidentPatchInput {
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

structure AvailabilityCalendarRecord {
    @required
    id: String
    @required
    label: String
}

structure AvailabilityCalendarCreateInput {
    @required
    label: String
}

structure AvailabilityCalendarPatchInput {
}

structure AvailabilityCalendarRevisionRecord {
    @required
    id: String
    @required
    calendar: String
    @required
    ruleSet: String
    @required
    ruleCount: Long
    @required
    rulesDigest: String
    @required
    timezone: String
    @required
    timezoneDataVersion: String
    origin: String
}

structure AvailabilityCalendarRevisionCreateInput {
    @required
    calendar: String
    @required
    ruleSet: String
    @required
    ruleCount: Long
    @required
    rulesDigest: String
    @required
    timezone: String
    @required
    timezoneDataVersion: String
    origin: String
}

structure AvailabilityCalendarRevisionPatchInput {
}

structure AvailabilityRuleRecord {
    @required
    id: String
    @required
    ruleSet: String
    @required
    ordinal: Long
    @required
    kind: String
    weekday: String
    localDate: String
    startMinute: String
    endMinute: String
    @required
    available: Boolean
    from: String
    until: String
    priority: String
}

structure AvailabilityRuleCreateInput {
    @required
    ruleSet: String
    @required
    ordinal: Long
    @required
    kind: String
    weekday: String
    localDate: String
    startMinute: String
    endMinute: String
    @required
    available: Boolean
    from: String
    until: String
    priority: String
}

structure AvailabilityRulePatchInput {
}

structure AvailabilityRuleSetRecord {
    @required
    id: String
    @required
    calendar: String
}

structure AvailabilityRuleSetCreateInput {
    @required
    calendar: String
}

structure AvailabilityRuleSetPatchInput {
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

structure IncidentRecord {
    @required
    id: String
    @required
    key: String
    @required
    case: String
    @required
    occurredAt: String
    @required
    description: String
    @required
    source: String
    serviceLevel: String
    risk: String
    finding: String
}

structure IncidentCreateInput {
    @required
    key: String
    @required
    case: String
    @required
    occurredAt: String
    @required
    description: String
    @required
    source: String
    serviceLevel: String
    risk: String
    finding: String
}

structure IncidentPatchInput {
}

structure IncidentCorrelationRecord {
    @required
    id: String
    @required
    incident: String
    @required
    problem: String
    @required
    rationale: String
    @required
    support: String
}

structure IncidentCorrelationCreateInput {
    @required
    incident: String
    @required
    problem: String
    @required
    rationale: String
    @required
    support: String
}

structure IncidentCorrelationPatchInput {
}

structure IncidentResolutionRecord {
    @required
    id: String
    @required
    incident: String
    @required
    correlation: String
    @required
    verification: String
    @required
    remediation: String
    @required
    closure: String
}

structure IncidentResolutionCreateInput {
    @required
    incident: String
    @required
    correlation: String
    @required
    verification: String
    @required
    remediation: String
    @required
    closure: String
}

structure IncidentResolutionPatchInput {
}

structure KnownProblemRecord {
    @required
    id: String
    @required
    problem: String
    @required
    diagnosis: String
    @required
    workaround: String
    @required
    support: String
    @required
    at: String
}

structure KnownProblemCreateInput {
    @required
    problem: String
    @required
    diagnosis: String
    @required
    workaround: String
    @required
    support: String
    @required
    at: String
}

structure KnownProblemPatchInput {
}

structure ProblemRecord {
    @required
    id: String
    @required
    key: String
    @required
    case: String
    @required
    hypothesis: String
    @required
    support: String
    @required
    diagnosis: String
    @required
    approval: String
    @required
    accepted: String
}

structure ProblemCreateInput {
    @required
    key: String
    @required
    case: String
    @required
    hypothesis: String
    @required
    support: String
    @required
    diagnosis: String
    @required
    approval: String
    @required
    accepted: String
}

structure ProblemPatchInput {
}

structure ProblemRemediationRecord {
    @required
    id: String
    @required
    problem: String
    @required
    fulfillment: String
    change: String
    @required
    verification: String
    @required
    approval: String
    @required
    accepted: String
}

structure ProblemRemediationCreateInput {
    @required
    problem: String
    @required
    fulfillment: String
    change: String
    @required
    verification: String
    @required
    approval: String
    @required
    accepted: String
}

structure ProblemRemediationPatchInput {
}

structure ProblemVerificationRecord {
    @required
    id: String
    @required
    remediation: String
    @required
    evaluation: String
    @required
    support: String
    @required
    at: String
}

structure ProblemVerificationCreateInput {
    @required
    remediation: String
    @required
    evaluation: String
    @required
    support: String
    @required
    at: String
}

structure ProblemVerificationPatchInput {
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

structure ServiceLevelBreachRecord {
    @required
    id: String
    @required
    instance: String
    @required
    assessment: String
}

structure ServiceLevelBreachCreateInput {
    @required
    instance: String
    @required
    assessment: String
}

structure ServiceLevelBreachPatchInput {
}

structure ServiceLevelEventRecord {
    @required
    id: String
    @required
    createdAt: String
    @required
    updatedAt: String
    @required
    instance: String
    @required
    ordinal: Long
    previous: String
    @required
    kind: String
    @required
    at: String
    @required
    elapsedMinutes: Long
    @required
    verdict: String
    evaluation: String
    finished: String
    @required
    reason: String
    @required
    recordedBy: String
}

structure ServiceLevelEventCreateInput {
    @required
    instance: String
    @required
    ordinal: Long
    previous: String
    @required
    kind: String
    @required
    at: String
    @required
    elapsedMinutes: Long
    @required
    verdict: String
    evaluation: String
    finished: String
    @required
    reason: String
    @required
    recordedBy: String
}

structure ServiceLevelEventPatchInput {
}

structure ServiceLevelInstanceRecord {
    @required
    id: String
    @required
    createdAt: String
    @required
    updatedAt: String
    @required
    key: String
    @required
    objective: String
    @required
    agreement: String
    @required
    right: String
    @required
    entitlement: String
    entitlementEnd: String
    @required
    fulfillment: String
    @required
    startedAt: String
    @required
    horizon: String
}

structure ServiceLevelInstanceCreateInput {
    @required
    key: String
    @required
    objective: String
    @required
    agreement: String
    @required
    right: String
    @required
    entitlement: String
    entitlementEnd: String
    @required
    fulfillment: String
    @required
    startedAt: String
    @required
    horizon: String
}

structure ServiceLevelInstancePatchInput {
}

structure ServiceLevelObjectiveRecord {
    @required
    id: String
    @required
    policy: String
    @required
    name: String
    @required
    targetMinutes: Long
    @required
    warningMinutes: Long
}

structure ServiceLevelObjectiveCreateInput {
    @required
    policy: String
    @required
    name: String
    @required
    targetMinutes: Long
    @required
    warningMinutes: Long
}

structure ServiceLevelObjectivePatchInput {
}

structure ServiceLevelPolicyRecord {
    @required
    id: String
    @required
    key: String
    @required
    specification: String
    @required
    clock: String
    calendar: String
}

structure ServiceLevelPolicyCreateInput {
    @required
    key: String
    @required
    specification: String
    @required
    clock: String
    calendar: String
}

structure ServiceLevelPolicyPatchInput {
}

structure ServiceLevelRemedyRecord {
    @required
    id: String
    @required
    breach: String
    obligation: String
    fulfillment: String
}

structure ServiceLevelRemedyCreateInput {
    @required
    breach: String
    obligation: String
    fulfillment: String
}

structure ServiceLevelRemedyPatchInput {
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

