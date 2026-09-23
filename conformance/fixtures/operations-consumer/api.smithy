$version: "2.0"

namespace fixture.operations.consumer

@error("client")
structure Problem {
    @required
    code: String
    @required
    title: String
    detail: String
}

structure BobDevelopmentRunRecord {
    @required
    id: String
    @required
    operation: String
    @required
    label: String
}

structure BobDevelopmentRunCreateInput {
    @required
    operation: String
    @required
    label: String
}

structure BobDevelopmentRunPatchInput {
}

structure LabRunRecord {
    @required
    id: String
    @required
    operation: String
    @required
    label: String
}

structure LabRunCreateInput {
    @required
    operation: String
    @required
    label: String
}

structure LabRunPatchInput {
}

structure ManufacturingRunRecord {
    @required
    id: String
    @required
    operation: String
    @required
    label: String
}

structure ManufacturingRunCreateInput {
    @required
    operation: String
    @required
    label: String
}

structure ManufacturingRunPatchInput {
}

structure MediaProductionRecord {
    @required
    id: String
    @required
    operation: String
    @required
    label: String
}

structure MediaProductionCreateInput {
    @required
    operation: String
    @required
    label: String
}

structure MediaProductionPatchInput {
}

structure AllocationJournalRecord {
    @required
    id: String
    @required
    pool: String
    @required
    ordinal: Long
    @required
    commandKey: String
    previous: String
    @required
    reservation: String
    replacement: String
    @required
    action: String
    @required
    at: String
}

structure AllocationJournalCreateInput {
    @required
    pool: String
    @required
    ordinal: Long
    @required
    commandKey: String
    previous: String
    @required
    reservation: String
    replacement: String
    @required
    action: String
    @required
    at: String
}

structure AllocationJournalPatchInput {
}

structure AllocationPoolRecord {
    @required
    id: String
    @required
    key: String
    @required
    mode: String
    @required
    capacity: String
    @required
    unit: String
}

structure AllocationPoolCreateInput {
    @required
    key: String
    @required
    mode: String
    @required
    capacity: String
    @required
    unit: String
}

structure AllocationPoolPatchInput {
}

structure AllocationReservationRecord {
    @required
    id: String
    @required
    pool: String
    @required
    key: String
    @required
    quantity: String
    @required
    unit: String
    @required
    from: String
    @required
    until: String
    @required
    holdUntil: String
}

structure AllocationReservationCreateInput {
    @required
    pool: String
    @required
    key: String
    @required
    quantity: String
    @required
    unit: String
    @required
    from: String
    @required
    until: String
    @required
    holdUntil: String
}

structure AllocationReservationPatchInput {
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

structure ActualAllocationLinkRecord {
    @required
    id: String
    @required
    run: String
    @required
    operation: String
    @required
    planned: String
    @required
    reservation: String
    @required
    grant: String
    previous: String
    @required
    depth: Long
}

structure ActualAllocationLinkCreateInput {
    @required
    run: String
    @required
    operation: String
    @required
    planned: String
    @required
    reservation: String
    @required
    grant: String
    previous: String
    @required
    depth: Long
}

structure ActualAllocationLinkPatchInput {
}

structure OperationRecord {
    @required
    id: String
    @required
    key: String
    @required
    definition: String
}

structure OperationCreateInput {
    @required
    key: String
    @required
    definition: String
}

structure OperationPatchInput {
}

structure OperationCleanupRecord {
    @required
    id: String
    @required
    ended: String
    @required
    reason: String
}

structure OperationCleanupCreateInput {
    @required
    ended: String
    @required
    reason: String
}

structure OperationCleanupPatchInput {
}

structure OperationEndRecord {
    @required
    id: String
    @required
    run: String
    @required
    start: String
    @required
    outcome: String
    evaluation: String
    @required
    reason: String
}

structure OperationEndCreateInput {
    @required
    run: String
    @required
    start: String
    @required
    outcome: String
    evaluation: String
    @required
    reason: String
}

structure OperationEndPatchInput {
}

structure OperationEvaluationLinkRecord {
    @required
    id: String
    @required
    run: String
    @required
    operation: String
    @required
    evaluation: String
    @required
    finish: String
    @required
    support: String
}

structure OperationEvaluationLinkCreateInput {
    @required
    run: String
    @required
    operation: String
    @required
    evaluation: String
    @required
    finish: String
    @required
    support: String
}

structure OperationEvaluationLinkPatchInput {
}

structure OperationFulfillmentLinkRecord {
    @required
    id: String
    @required
    run: String
    @required
    operation: String
    @required
    fulfillment: String
}

structure OperationFulfillmentLinkCreateInput {
    @required
    run: String
    @required
    operation: String
    @required
    fulfillment: String
}

structure OperationFulfillmentLinkPatchInput {
}

structure OperationLineageLinkRecord {
    @required
    id: String
    @required
    run: String
    @required
    operation: String
    @required
    transformation: String
    @required
    seal: String
}

structure OperationLineageLinkCreateInput {
    @required
    run: String
    @required
    operation: String
    @required
    transformation: String
    @required
    seal: String
}

structure OperationLineageLinkPatchInput {
}

structure OperationReservationClaimRecord {
    @required
    id: String
    @required
    run: String
    @required
    operation: String
    @required
    planned: String
}

structure OperationReservationClaimCreateInput {
    @required
    run: String
    @required
    operation: String
    @required
    planned: String
}

structure OperationReservationClaimPatchInput {
}

structure OperationRunRecord {
    @required
    id: String
    @required
    operation: String
    @required
    ordinal: Long
    plans: String
    @required
    usageStream: String
    @required
    usageSource: String
}

structure OperationRunCreateInput {
    @required
    operation: String
    @required
    ordinal: Long
    plans: String
    @required
    usageStream: String
    @required
    usageSource: String
}

structure OperationRunPatchInput {
}

structure OperationStartRecord {
    @required
    id: String
    @required
    run: String
    actual: String
}

structure OperationStartCreateInput {
    @required
    run: String
    actual: String
}

structure OperationStartPatchInput {
}

structure OperationUsageLinkRecord {
    @required
    id: String
    @required
    run: String
    @required
    event: String
}

structure OperationUsageLinkCreateInput {
    @required
    run: String
    @required
    event: String
}

structure OperationUsageLinkPatchInput {
}

structure PlannedAllocationLinkRecord {
    @required
    id: String
    @required
    operation: String
    @required
    reservation: String
    previous: String
    @required
    depth: Long
}

structure PlannedAllocationLinkCreateInput {
    @required
    operation: String
    @required
    reservation: String
    previous: String
    @required
    depth: Long
}

structure PlannedAllocationLinkPatchInput {
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

