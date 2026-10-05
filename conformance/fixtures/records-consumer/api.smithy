$version: "2.0"

namespace fixture.records.consumer

@error("client")
structure Problem {
    @required
    code: String
    @required
    title: String
    detail: String
}

structure ApplicantDataRecord {
    @required
    id: String
    @required
    record: String
    @required
    applicantCode: String
}

structure ApplicantDataCreateInput {
    @required
    record: String
    @required
    applicantCode: String
}

structure ApplicantDataPatchInput {
}

structure ComplianceInvoiceRecord {
    @required
    id: String
    @required
    record: String
    @required
    invoiceNumber: String
}

structure ComplianceInvoiceCreateInput {
    @required
    record: String
    @required
    invoiceNumber: String
}

structure ComplianceInvoicePatchInput {
}

structure LitigationFileRecord {
    @required
    id: String
    @required
    record: String
    @required
    caseNumber: String
}

structure LitigationFileCreateInput {
    @required
    record: String
    @required
    caseNumber: String
}

structure LitigationFilePatchInput {
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

