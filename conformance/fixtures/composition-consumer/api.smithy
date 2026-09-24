$version: "2.0"

namespace fixture.composition.consumer

@error("client")
structure Problem {
    @required
    code: String
    @required
    title: String
    detail: String
}

structure AssemblyRecord {
    @required
    id: String
    @required
    instance: String
    @required
    partNumber: String
}

structure AssemblyCreateInput {
    @required
    instance: String
    @required
    partNumber: String
}

structure AssemblyPatchInput {
}

structure CurriculumRecord {
    @required
    id: String
    @required
    instance: String
    @required
    program: String
}

structure CurriculumCreateInput {
    @required
    instance: String
    @required
    program: String
}

structure CurriculumPatchInput {
}

structure ServiceBundleRecord {
    @required
    id: String
    @required
    instance: String
    @required
    offering: String
}

structure ServiceBundleCreateInput {
    @required
    instance: String
    @required
    offering: String
}

structure ServiceBundlePatchInput {
}

structure SoftwarePackageRecord {
    @required
    id: String
    @required
    instance: String
    @required
    packageName: String
}

structure SoftwarePackageCreateInput {
    @required
    instance: String
    @required
    packageName: String
}

structure SoftwarePackagePatchInput {
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

structure CompositionAlternativeRecord {
    @required
    id: String
    @required
    slot: String
    @required
    ordinal: Long
    @required
    component: String
    @required
    authority: String
}

structure CompositionAlternativeCreateInput {
    @required
    slot: String
    @required
    ordinal: Long
    @required
    component: String
    @required
    authority: String
}

structure CompositionAlternativePatchInput {
}

structure CompositionInstanceRecord {
    @required
    id: String
    @required
    key: String
    @required
    specification: String
    resource: String
}

structure CompositionInstanceCreateInput {
    @required
    key: String
    @required
    specification: String
    resource: String
}

structure CompositionInstancePatchInput {
}

structure CompositionMemberRecord {
    @required
    id: String
    @required
    set: String
    @required
    ordinal: Long
    @required
    slot: String
    @required
    child: String
    @required
    quantity: String
    @required
    unit: String
}

structure CompositionMemberCreateInput {
    @required
    set: String
    @required
    ordinal: Long
    @required
    slot: String
    @required
    child: String
    @required
    quantity: String
    @required
    unit: String
}

structure CompositionMemberPatchInput {
}

structure CompositionRevisionRecord {
    @required
    id: String
    @required
    instance: String
    @required
    ordinal: Long
    previous: String
    @required
    set: String
    @required
    from: String
    until: String
    @required
    reason: String
}

structure CompositionRevisionCreateInput {
    @required
    instance: String
    @required
    ordinal: Long
    previous: String
    @required
    set: String
    @required
    from: String
    until: String
    @required
    reason: String
}

structure CompositionRevisionPatchInput {
}

structure CompositionSetRecord {
    @required
    id: String
    @required
    instance: String
    @required
    componentCount: Long
}

structure CompositionSetCreateInput {
    @required
    instance: String
    @required
    componentCount: Long
}

structure CompositionSetPatchInput {
}

structure CompositionSlotRecord {
    @required
    id: String
    @required
    specification: String
    @required
    ordinal: Long
    @required
    key: String
    @required
    component: String
    @required
    unit: String
    @required
    minimumCount: Long
    @required
    maximumCount: Long
    @required
    minimumQuantity: String
    @required
    maximumQuantity: String
    @required
    alternativeCount: Long
    @required
    from: String
    until: String
}

structure CompositionSlotCreateInput {
    @required
    specification: String
    @required
    ordinal: Long
    @required
    key: String
    @required
    component: String
    @required
    unit: String
    @required
    minimumCount: Long
    @required
    maximumCount: Long
    @required
    minimumQuantity: String
    @required
    maximumQuantity: String
    @required
    alternativeCount: Long
    @required
    from: String
    until: String
}

structure CompositionSlotPatchInput {
}

structure CompositionSpecificationRecord {
    @required
    id: String
    @required
    definition: String
    @required
    key: String
    @required
    slotCount: Long
    @required
    ordered: Boolean
    @required
    allowCycles: Boolean
}

structure CompositionSpecificationCreateInput {
    @required
    definition: String
    @required
    key: String
    @required
    slotCount: Long
    @required
    ordered: Boolean
    @required
    allowCycles: Boolean
}

structure CompositionSpecificationPatchInput {
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

structure PartyResourceRelationRecord {
    @required
    id: String
    @required
    createdAt: String
    @required
    updatedAt: String
    @required
    key: String
    @required
    subject: String
    @required
    party: String
    @required
    kind: String
    @required
    scope: String
    quantity: String
    unit: String
    @required
    validFrom: String
    validUntil: String
    previous: String
    @required
    depth: Long
}

structure PartyResourceRelationCreateInput {
    @required
    key: String
    @required
    subject: String
    @required
    party: String
    @required
    kind: String
    @required
    scope: String
    quantity: String
    unit: String
    @required
    validFrom: String
    validUntil: String
    previous: String
    @required
    depth: Long
}

structure PartyResourceRelationPatchInput {
}

structure RelationCommitRecord {
    @required
    id: String
    @required
    createdAt: String
    @required
    updatedAt: String
    @required
    key: String
    prior: String
    priorCommit: String
    current: String
    @required
    effectiveAt: String
    @required
    source: String
    @required
    recordedBy: String
    @required
    reason: String
}

structure RelationCommitCreateInput {
    @required
    key: String
    prior: String
    priorCommit: String
    current: String
    @required
    effectiveAt: String
    @required
    source: String
    @required
    recordedBy: String
    @required
    reason: String
}

structure RelationCommitPatchInput {
}

structure RelationKindRecord {
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
    @required
    definition: String
}

structure RelationKindCreateInput {
    @required
    namespace: String
    @required
    name: String
    @required
    definition: String
}

structure RelationKindPatchInput {
}

structure RelationScopeRecord {
    @required
    id: String
    @required
    createdAt: String
    @required
    updatedAt: String
    @required
    subject: String
    @required
    key: String
    @required
    label: String
}

structure RelationScopeCreateInput {
    @required
    subject: String
    @required
    key: String
    @required
    label: String
}

structure RelationScopePatchInput {
}

structure RelationSourceRecord {
    @required
    id: String
    @required
    createdAt: String
    @required
    updatedAt: String
    @required
    key: String
    @required
    source: String
    @required
    sourceRecord: String
    @required
    occurredAt: String
    @required
    evidence: String
    @required
    description: String
}

structure RelationSourceCreateInput {
    @required
    key: String
    @required
    source: String
    @required
    sourceRecord: String
    @required
    occurredAt: String
    @required
    evidence: String
    @required
    description: String
}

structure RelationSourcePatchInput {
}

structure ResourceSubjectRecord {
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
}

structure ResourceSubjectCreateInput {
    @required
    key: String
    @required
    label: String
}

structure ResourceSubjectPatchInput {
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

