$version: "2.0"

namespace forgegraph.foundation.challenge

@error("client")
structure Problem {
    @required
    code: String
    @required
    title: String
    detail: String
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

