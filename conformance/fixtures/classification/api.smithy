$version: "2.0"

namespace forgegraph.foundation.classification

@error("client")
structure Problem {
    @required
    code: String
    @required
    title: String
    detail: String
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

