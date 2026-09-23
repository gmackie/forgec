$version: "2.0"

namespace fixture.master.data.consumer

@error("client")
structure Problem {
    @required
    code: String
    @required
    title: String
    detail: String
}

structure AssetRecord {
    @required
    id: String
    @required
    canonical: String
    @required
    serial: String
}

structure AssetCreateInput {
    @required
    canonical: String
    @required
    serial: String
}

structure AssetPatchInput {
}

structure AssetSourceRecord {
    @required
    id: String
    @required
    source: String
    @required
    asset: String
}

structure AssetSourceCreateInput {
    @required
    source: String
    @required
    asset: String
}

structure AssetSourcePatchInput {
}

structure CustomerRecord {
    @required
    id: String
    @required
    canonical: String
    @required
    name: String
}

structure CustomerCreateInput {
    @required
    canonical: String
    @required
    name: String
}

structure CustomerPatchInput {
}

structure CustomerSourceRecord {
    @required
    id: String
    @required
    source: String
    @required
    customer: String
}

structure CustomerSourceCreateInput {
    @required
    source: String
    @required
    customer: String
}

structure CustomerSourcePatchInput {
}

structure SupplierRecord {
    @required
    id: String
    @required
    canonical: String
    @required
    name: String
}

structure SupplierCreateInput {
    @required
    canonical: String
    @required
    name: String
}

structure SupplierPatchInput {
}

structure SupplierSourceRecord {
    @required
    id: String
    @required
    source: String
    @required
    supplier: String
}

structure SupplierSourceCreateInput {
    @required
    source: String
    @required
    supplier: String
}

structure SupplierSourcePatchInput {
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

structure LineageGraphRecord {
    @required
    id: String
    @required
    label: String
}

structure LineageGraphCreateInput {
    @required
    label: String
}

structure LineageGraphPatchInput {
}

structure LineageNodeRecord {
    @required
    id: String
    @required
    graph: String
    @required
    rank: Long
    @required
    label: String
}

structure LineageNodeCreateInput {
    @required
    graph: String
    @required
    rank: Long
    @required
    label: String
}

structure LineageNodePatchInput {
}

structure LineageRelationRecord {
    @required
    id: String
    @required
    graph: String
    @required
    source: String
    @required
    target: String
    @required
    kind: String
    definition: String
    supersedes: String
    @required
    revision: Long
}

structure LineageRelationCreateInput {
    @required
    graph: String
    @required
    source: String
    @required
    target: String
    @required
    kind: String
    definition: String
    supersedes: String
    @required
    revision: Long
}

structure LineageRelationPatchInput {
}

structure TransformationRecord {
    @required
    id: String
    @required
    graph: String
    @required
    rank: Long
    definition: String
    @required
    label: String
}

structure TransformationCreateInput {
    @required
    graph: String
    @required
    rank: Long
    definition: String
    @required
    label: String
}

structure TransformationPatchInput {
}

structure TransformationInputRecord {
    @required
    id: String
    @required
    transformation: String
    @required
    node: String
    next: String
    @required
    depth: Long
}

structure TransformationInputCreateInput {
    @required
    transformation: String
    @required
    node: String
    next: String
    @required
    depth: Long
}

structure TransformationInputPatchInput {
}

structure TransformationOutputRecord {
    @required
    id: String
    @required
    transformation: String
    @required
    node: String
    next: String
    @required
    depth: Long
}

structure TransformationOutputCreateInput {
    @required
    transformation: String
    @required
    node: String
    next: String
    @required
    depth: Long
}

structure TransformationOutputPatchInput {
}

structure TransformationSealRecord {
    @required
    id: String
    @required
    createdAt: String
    @required
    updatedAt: String
    @required
    transformation: String
    @required
    inputs: String
    @required
    outputs: String
    @required
    recordedBy: String
}

structure TransformationSealCreateInput {
    @required
    transformation: String
    @required
    inputs: String
    @required
    outputs: String
    @required
    recordedBy: String
}

structure TransformationSealPatchInput {
}

structure CanonicalLinkRecord {
    @required
    id: String
    @required
    createdAt: String
    @required
    updatedAt: String
    @required
    source: String
    @required
    ordinal: Long
    previous: String
    @required
    canonical: String
    from: String
    @required
    kind: String
    survivorship: String
}

structure CanonicalLinkCreateInput {
    @required
    source: String
    @required
    ordinal: Long
    previous: String
    @required
    canonical: String
    from: String
    @required
    kind: String
    survivorship: String
}

structure CanonicalLinkPatchInput {
}

structure CanonicalRecordRecord {
    @required
    id: String
    @required
    domain: String
    @required
    node: String
    @required
    key: String
}

structure CanonicalRecordCreateInput {
    @required
    domain: String
    @required
    node: String
    @required
    key: String
}

structure CanonicalRecordPatchInput {
}

structure ResolutionCaseRecord {
    @required
    id: String
    @required
    source: String
    @required
    candidate: String
    @required
    evaluation: String
    @required
    finish: String
    @required
    decision: String
    @required
    desired: String
    @required
    desiredEvent: String
}

structure ResolutionCaseCreateInput {
    @required
    source: String
    @required
    candidate: String
    @required
    evaluation: String
    @required
    finish: String
    @required
    decision: String
    @required
    desired: String
    @required
    desiredEvent: String
}

structure ResolutionCasePatchInput {
}

structure ResolutionChoiceRecord {
    @required
    id: String
    @required
    resolution: String
    @required
    canonical: String
    @required
    decision: String
    @required
    option: String
}

structure ResolutionChoiceCreateInput {
    @required
    resolution: String
    @required
    canonical: String
    @required
    decision: String
    @required
    option: String
}

structure ResolutionChoicePatchInput {
}

structure ResolutionDomainRecord {
    @required
    id: String
    @required
    key: String
}

structure ResolutionDomainCreateInput {
    @required
    key: String
}

structure ResolutionDomainPatchInput {
}

structure SourceRecordRecord {
    @required
    id: String
    @required
    domain: String
    @required
    identifier: String
    @required
    node: String
    @required
    reconciliation: String
}

structure SourceRecordCreateInput {
    @required
    domain: String
    @required
    identifier: String
    @required
    node: String
    @required
    reconciliation: String
}

structure SourceRecordPatchInput {
}

structure SurvivorshipDecisionRecord {
    @required
    id: String
    @required
    resolution: String
    @required
    choice: String
    @required
    canonical: String
    @required
    decision: String
    @required
    outcome: String
    @required
    terminal: String
    @required
    option: String
    @required
    lineage: String
    @required
    sourceNode: String
    @required
    targetNode: String
    @required
    source: String
}

structure SurvivorshipDecisionCreateInput {
    @required
    resolution: String
    @required
    choice: String
    @required
    canonical: String
    @required
    decision: String
    @required
    outcome: String
    @required
    terminal: String
    @required
    option: String
    @required
    lineage: String
    @required
    sourceNode: String
    @required
    targetNode: String
    @required
    source: String
}

structure SurvivorshipDecisionPatchInput {
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

structure DesiredRevisionRecord {
    @required
    id: String
    @required
    createdAt: String
    @required
    updatedAt: String
    @required
    scope: String
    @required
    sequence: Long
    @required
    pin: String
}

structure DesiredRevisionCreateInput {
    @required
    scope: String
    @required
    sequence: Long
    @required
    pin: String
}

structure DesiredRevisionPatchInput {
}

structure DriftRecord {
    @required
    id: String
    @required
    observation: String
    @required
    desired: String
    @required
    pin: String
    @required
    anchor: String
    @required
    field: String
    @required
    explanation: String
}

structure DriftCreateInput {
    @required
    observation: String
    @required
    desired: String
    @required
    pin: String
    @required
    anchor: String
    @required
    field: String
    @required
    explanation: String
}

structure DriftPatchInput {
}

structure ObservationRecord {
    @required
    id: String
    @required
    createdAt: String
    @required
    updatedAt: String
    @required
    desired: String
    @required
    run: String
    @required
    finish: String
    @required
    support: String
    @required
    observedAt: String
}

structure ObservationCreateInput {
    @required
    desired: String
    @required
    run: String
    @required
    finish: String
    @required
    support: String
    @required
    observedAt: String
}

structure ObservationPatchInput {
}

structure ReconciliationAttemptRecord {
    @required
    id: String
    @required
    createdAt: String
    @required
    updatedAt: String
    @required
    desired: String
    @required
    observation: String
    @required
    fulfillment: String
    @required
    key: String
}

structure ReconciliationAttemptCreateInput {
    @required
    desired: String
    @required
    observation: String
    @required
    fulfillment: String
    @required
    key: String
}

structure ReconciliationAttemptPatchInput {
}

structure ReconciliationEventRecord {
    @required
    id: String
    @required
    createdAt: String
    @required
    updatedAt: String
    @required
    scope: String
    @required
    ordinal: Long
    previous: String
    @required
    desired: String
    @required
    desiredSequence: Long
    @required
    kind: String
    attempt: String
    result: String
}

structure ReconciliationEventCreateInput {
    @required
    scope: String
    @required
    ordinal: Long
    previous: String
    @required
    desired: String
    @required
    desiredSequence: Long
    @required
    kind: String
    attempt: String
    result: String
}

structure ReconciliationEventPatchInput {
}

structure ReconciliationResultRecord {
    @required
    id: String
    @required
    createdAt: String
    @required
    updatedAt: String
    @required
    attempt: String
    @required
    desired: String
    @required
    outcome: String
    @required
    support: String
    @required
    detail: String
}

structure ReconciliationResultCreateInput {
    @required
    attempt: String
    @required
    desired: String
    @required
    outcome: String
    @required
    support: String
    @required
    detail: String
}

structure ReconciliationResultPatchInput {
}

structure ReconciliationScopeRecord {
    @required
    id: String
    @required
    key: String
}

structure ReconciliationScopeCreateInput {
    @required
    key: String
}

structure ReconciliationScopePatchInput {
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

