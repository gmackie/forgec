$version: "2.0"

namespace forgegraph.foundation.onboarding

@error("client")
structure Problem {
    @required
    code: String
    @required
    title: String
    detail: String
}

structure AccessGrantRecord {
    @required
    id: String
    @required
    createdAt: String
    @required
    updatedAt: String
    @required
    request: String
    @required
    approval: String
}

structure AccessGrantCreateInput {
    @required
    request: String
    @required
    approval: String
}

structure AccessGrantPatchInput {
}

structure AccessGrantEndRecord {
    @required
    id: String
    @required
    createdAt: String
    @required
    updatedAt: String
    @required
    grant: String
    replacement: String
    @required
    effectiveAt: String
    @required
    reason: String
}

structure AccessGrantEndCreateInput {
    @required
    grant: String
    replacement: String
    @required
    effectiveAt: String
    @required
    reason: String
}

structure AccessGrantEndPatchInput {
}

structure AccessIdentityRecord {
    @required
    id: String
    @required
    subject: String
    @required
    qualificationSubject: String
    @required
    attestationSubject: String
}

structure AccessIdentityCreateInput {
    @required
    subject: String
    @required
    qualificationSubject: String
    @required
    attestationSubject: String
}

structure AccessIdentityPatchInput {
}

structure AccessRequestRecord {
    @required
    id: String
    @required
    createdAt: String
    @required
    updatedAt: String
    @required
    identity: String
    @required
    subject: String
    @required
    root: String
    holder: String
    delegation: String
    membership: String
    qualification: String
    @required
    policy: String
    @required
    decisionCase: String
    @required
    approvedOption: String
    @required
    validFrom: String
    @required
    validUntil: String
    @required
    reviewDue: String
    @required
    source: String
    @required
    support: String
}

structure AccessRequestCreateInput {
    @required
    identity: String
    @required
    subject: String
    @required
    root: String
    holder: String
    delegation: String
    membership: String
    qualification: String
    @required
    policy: String
    @required
    decisionCase: String
    @required
    approvedOption: String
    @required
    validFrom: String
    @required
    validUntil: String
    @required
    reviewDue: String
    @required
    source: String
    @required
    support: String
}

structure AccessRequestPatchInput {
}

structure AccessReviewRecord {
    @required
    id: String
    @required
    createdAt: String
    @required
    updatedAt: String
    @required
    grant: String
    @required
    kind: String
    @required
    reviewer: String
    @required
    certifier: String
    @required
    decisionCase: String
    @required
    continueOption: String
    @required
    modifyOption: String
    @required
    revokeOption: String
    @required
    findingCount: Long
    @required
    reason: String
}

structure AccessReviewCreateInput {
    @required
    grant: String
    @required
    kind: String
    @required
    reviewer: String
    @required
    certifier: String
    @required
    decisionCase: String
    @required
    continueOption: String
    @required
    modifyOption: String
    @required
    revokeOption: String
    @required
    findingCount: Long
    @required
    reason: String
}

structure AccessReviewPatchInput {
}

structure AccessReviewCompletionRecord {
    @required
    id: String
    @required
    createdAt: String
    @required
    updatedAt: String
    @required
    grant: String
    @required
    ordinal: Long
    previous: String
    @required
    review: String
    @required
    outcome: String
    @required
    approval: String
    @required
    certification: String
    @required
    nextReviewAt: String
    @required
    acceptsConflicts: Boolean
    replacement: String
    @required
    reason: String
}

structure AccessReviewCompletionCreateInput {
    @required
    grant: String
    @required
    ordinal: Long
    previous: String
    @required
    review: String
    @required
    outcome: String
    @required
    approval: String
    @required
    certification: String
    @required
    nextReviewAt: String
    @required
    acceptsConflicts: Boolean
    replacement: String
    @required
    reason: String
}

structure AccessReviewCompletionPatchInput {
}

structure AccessReviewFindingRecord {
    @required
    id: String
    @required
    review: String
    @required
    ordinal: Long
    @required
    conflictingGrant: String
    @required
    support: String
    @required
    reason: String
}

structure AccessReviewFindingCreateInput {
    @required
    review: String
    @required
    ordinal: Long
    @required
    conflictingGrant: String
    @required
    support: String
    @required
    reason: String
}

structure AccessReviewFindingPatchInput {
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

structure ClassificationAssignmentRecord {
    @required
    id: String
    @required
    classifications: String
    @required
    meaning: String
    @required
    recordedAt: String
}

structure ClassificationAssignmentCreateInput {
    @required
    classifications: String
    @required
    meaning: String
    @required
    recordedAt: String
}

structure ClassificationAssignmentPatchInput {
}

structure ClassificationRetractionRecord {
    @required
    id: String
    @required
    assignment: String
    @required
    effectiveAt: String
    @required
    reason: String
}

structure ClassificationRetractionCreateInput {
    @required
    assignment: String
    @required
    effectiveAt: String
    @required
    reason: String
}

structure ClassificationRetractionPatchInput {
}

structure ClassificationSetRecord {
    @required
    id: String
    @required
    label: String
}

structure ClassificationSetCreateInput {
    @required
    label: String
}

structure ClassificationSetPatchInput {
}

structure ConceptRecord {
    @required
    id: String
    @required
    version: Long
    parent: String
    @required
    taxonomy: String
    @required
    ordinal: Long
    @required
    identifiers: String
}

structure ConceptCreateInput {
    @required
    taxonomy: String
    @required
    ordinal: Long
    @required
    identifiers: String
}

structure ConceptPatchInput {
}

structure ConceptAliasRecord {
    @required
    id: String
    @required
    taxonomy: String
    @required
    alias: String
    @required
    meaning: String
}

structure ConceptAliasCreateInput {
    @required
    taxonomy: String
    @required
    alias: String
    @required
    meaning: String
}

structure ConceptAliasPatchInput {
}

structure ConceptDispositionRecord {
    @required
    id: String
    @required
    concept: String
    replacement: String
    @required
    effectiveAt: String
    @required
    reason: String
}

structure ConceptDispositionCreateInput {
    @required
    concept: String
    replacement: String
    @required
    effectiveAt: String
    @required
    reason: String
}

structure ConceptDispositionPatchInput {
}

structure ConceptRevisionRecord {
    @required
    id: String
    @required
    concept: String
    @required
    taxonomy: String
    @required
    ordinal: Long
    @required
    revision: Long
    previous: String
    parentMeaning: String
    @required
    label: String
    @required
    definition: String
}

structure ConceptRevisionCreateInput {
    @required
    concept: String
    @required
    taxonomy: String
    @required
    ordinal: Long
    @required
    revision: Long
    previous: String
    parentMeaning: String
    @required
    label: String
    @required
    definition: String
}

structure ConceptRevisionPatchInput {
}

structure TaxonomyRecord {
    @required
    id: String
    @required
    key: String
    @required
    identifiers: String
}

structure TaxonomyCreateInput {
    @required
    key: String
    @required
    identifiers: String
}

structure TaxonomyPatchInput {
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

structure DelegationRecord {
    @required
    id: String
    @required
    createdAt: String
    @required
    updatedAt: String
    @required
    delegator: String
    @required
    delegate: String
    @required
    root: String
    @required
    rootHolder: String
    parent: String
    @required
    depth: Long
    @required
    scope: String
    @required
    right: String
    @required
    constraints: String
    @required
    purpose: String
    @required
    validFrom: String
    @required
    validUntil: String
    @required
    redelegable: Boolean
    @required
    source: String
    @required
    support: String
}

structure DelegationCreateInput {
    @required
    delegator: String
    @required
    delegate: String
    @required
    root: String
    @required
    rootHolder: String
    parent: String
    @required
    depth: Long
    @required
    scope: String
    @required
    right: String
    @required
    constraints: String
    @required
    purpose: String
    @required
    validFrom: String
    @required
    validUntil: String
    @required
    redelegable: Boolean
    @required
    source: String
    @required
    support: String
}

structure DelegationPatchInput {
}

structure DelegationPartySubjectRecord {
    @required
    id: String
    @required
    subject: String
    @required
    party: String
}

structure DelegationPartySubjectCreateInput {
    @required
    subject: String
    @required
    party: String
}

structure DelegationPartySubjectPatchInput {
}

structure DelegationRevocationRecord {
    @required
    id: String
    @required
    createdAt: String
    @required
    updatedAt: String
    @required
    delegation: String
    @required
    effectiveAt: String
    @required
    reason: String
    @required
    recordedBy: String
}

structure DelegationRevocationCreateInput {
    @required
    delegation: String
    @required
    effectiveAt: String
    @required
    reason: String
    @required
    recordedBy: String
}

structure DelegationRevocationPatchInput {
}

structure DelegationSubjectRecord {
    @required
    id: String
    @required
    label: String
}

structure DelegationSubjectCreateInput {
    @required
    label: String
}

structure DelegationSubjectPatchInput {
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

structure IntakeFormRecord {
    @required
    id: String
    @required
    definition: String
    @required
    label: String
    @required
    anonymousAllowed: Boolean
}

structure IntakeFormCreateInput {
    @required
    definition: String
    @required
    label: String
    @required
    anonymousAllowed: Boolean
}

structure IntakeFormPatchInput {
}

structure SubmissionRecord {
    @required
    id: String
    @required
    createdAt: String
    @required
    updatedAt: String
    @required
    form: String
    @required
    definition: String
    submitter: String
    @required
    sourceKey: String
    @required
    submittedAt: String
    raw: String
}

structure SubmissionCreateInput {
    @required
    form: String
    @required
    definition: String
    submitter: String
    @required
    sourceKey: String
    @required
    submittedAt: String
    raw: String
}

structure SubmissionPatchInput {
}

structure SubmissionValidationRecord {
    @required
    id: String
    @required
    submission: String
    @required
    run: String
    @required
    finish: String
    @required
    verdict: String
    @required
    reason: String
}

structure SubmissionValidationCreateInput {
    @required
    submission: String
    @required
    run: String
    @required
    finish: String
    @required
    verdict: String
    @required
    reason: String
}

structure SubmissionValidationPatchInput {
}

structure OffboardingRecord {
    @required
    id: String
    @required
    activation: String
    @required
    case: String
    @required
    policy: String
    @required
    cleanup: String
    @required
    transfer: String
    @required
    obligationReview: String
    @required
    approval: String
    @required
    accepted: String
    @required
    retention: String
}

structure OffboardingCreateInput {
    @required
    activation: String
    @required
    case: String
    @required
    policy: String
    @required
    cleanup: String
    @required
    transfer: String
    @required
    obligationReview: String
    @required
    approval: String
    @required
    accepted: String
    @required
    retention: String
}

structure OffboardingPatchInput {
}

structure OffboardingCompletionRecord {
    @required
    id: String
    @required
    offboarding: String
    @required
    obligations: String
    @required
    support: String
    @required
    at: String
}

structure OffboardingCompletionCreateInput {
    @required
    offboarding: String
    @required
    obligations: String
    @required
    support: String
    @required
    at: String
}

structure OffboardingCompletionPatchInput {
}

structure OnboardingRecord {
    @required
    id: String
    @required
    key: String
    @required
    case: String
    @required
    subject: String
    party: String
    principal: String
    @required
    criteria: String
    @required
    submission: String
    @required
    validation: String
    @required
    requirement: String
    @required
    decision: String
    @required
    accepted: String
    @required
    gateCount: Long
}

structure OnboardingCreateInput {
    @required
    key: String
    @required
    case: String
    @required
    subject: String
    party: String
    principal: String
    @required
    criteria: String
    @required
    submission: String
    @required
    validation: String
    @required
    requirement: String
    @required
    decision: String
    @required
    accepted: String
    @required
    gateCount: Long
}

structure OnboardingPatchInput {
}

structure OnboardingActivationRecord {
    @required
    id: String
    @required
    onboarding: String
    @required
    head: String
    @required
    at: String
    @required
    support: String
}

structure OnboardingActivationCreateInput {
    @required
    onboarding: String
    @required
    head: String
    @required
    at: String
    @required
    support: String
}

structure OnboardingActivationPatchInput {
}

structure OnboardingConfigurationRecord {
    @required
    id: String
    @required
    onboarding: String
    @required
    definition: String
    @required
    run: String
    @required
    finish: String
    @required
    support: String
}

structure OnboardingConfigurationCreateInput {
    @required
    onboarding: String
    @required
    definition: String
    @required
    run: String
    @required
    finish: String
    @required
    support: String
}

structure OnboardingConfigurationPatchInput {
}

structure OnboardingGateRecord {
    @required
    id: String
    @required
    onboarding: String
    @required
    ordinal: Long
    previous: String
    @required
    at: String
    relationship: String
    access: String
    delegation: String
    configuration: String
    provision: String
}

structure OnboardingGateCreateInput {
    @required
    onboarding: String
    @required
    ordinal: Long
    previous: String
    @required
    at: String
    relationship: String
    access: String
    delegation: String
    configuration: String
    provision: String
}

structure OnboardingGatePatchInput {
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

structure PartyRelationshipRecord {
    @required
    id: String
    @required
    createdAt: String
    @required
    updatedAt: String
    @required
    definition: String
    @required
    fromParty: String
    @required
    toParty: String
    scope: String
    @required
    validFrom: String
    validUntil: String
    @required
    source: String
    support: String
}

structure PartyRelationshipCreateInput {
    @required
    definition: String
    @required
    fromParty: String
    @required
    toParty: String
    scope: String
    @required
    validFrom: String
    validUntil: String
    @required
    source: String
    support: String
}

structure PartyRelationshipPatchInput {
}

structure PartyRelationshipDefinitionRecord {
    @required
    id: String
    @required
    key: String
    @required
    pin: String
    @required
    forwardLabel: String
    @required
    inverseLabel: String
}

structure PartyRelationshipDefinitionCreateInput {
    @required
    key: String
    @required
    pin: String
    @required
    forwardLabel: String
    @required
    inverseLabel: String
}

structure PartyRelationshipDefinitionPatchInput {
}

structure PartyRelationshipEndRecord {
    @required
    id: String
    @required
    createdAt: String
    @required
    updatedAt: String
    @required
    relationship: String
    replacement: String
    @required
    effectiveAt: String
    @required
    reason: String
    @required
    recordedBy: String
}

structure PartyRelationshipEndCreateInput {
    @required
    relationship: String
    replacement: String
    @required
    effectiveAt: String
    @required
    reason: String
    @required
    recordedBy: String
}

structure PartyRelationshipEndPatchInput {
}

structure PartyRelationshipScopeRecord {
    @required
    id: String
    @required
    label: String
}

structure PartyRelationshipScopeCreateInput {
    @required
    label: String
}

structure PartyRelationshipScopePatchInput {
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

structure ArtifactRecordRecord {
    @required
    id: String
    @required
    record: String
    @required
    revision: String
}

structure ArtifactRecordCreateInput {
    @required
    record: String
    @required
    revision: String
}

structure ArtifactRecordPatchInput {
}

structure RecordRecord {
    @required
    id: String
    @required
    rule: String
    @required
    trigger: String
    @required
    triggeredAt: String
    @required
    retainUntil: String
    support: String
}

structure RecordCreateInput {
    @required
    rule: String
    @required
    trigger: String
    @required
    triggeredAt: String
    @required
    retainUntil: String
    support: String
}

structure RecordPatchInput {
}

structure RecordCategoryRecord {
    @required
    id: String
    @required
    label: String
    meaning: String
}

structure RecordCategoryCreateInput {
    @required
    label: String
    meaning: String
}

structure RecordCategoryPatchInput {
}

structure RecordEventRecord {
    @required
    id: String
    @required
    record: String
    @required
    ordinal: Long
    previous: String
    @required
    kind: String
    hold: String
    @required
    activeHolds: Long
    @required
    effectiveAt: String
    @required
    reason: String
    @required
    authority: String
    support: String
    @required
    recordedBy: String
}

structure RecordEventCreateInput {
    @required
    record: String
    @required
    ordinal: Long
    previous: String
    @required
    kind: String
    hold: String
    @required
    activeHolds: Long
    @required
    effectiveAt: String
    @required
    reason: String
    @required
    authority: String
    support: String
    @required
    recordedBy: String
}

structure RecordEventPatchInput {
}

structure RetentionRuleRecord {
    @required
    id: String
    @required
    category: String
    @required
    trigger: String
    @required
    periodDays: Long
    @required
    disposition: String
    @required
    authority: String
    @required
    source: String
    support: String
}

structure RetentionRuleCreateInput {
    @required
    category: String
    @required
    trigger: String
    @required
    periodDays: Long
    @required
    disposition: String
    @required
    authority: String
    @required
    source: String
    support: String
}

structure RetentionRulePatchInput {
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

