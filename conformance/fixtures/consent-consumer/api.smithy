$version: "2.0"

namespace foundation.probe.consent.consumers

@error("client")
structure Problem {
    @required
    code: String
    @required
    title: String
    detail: String
}

structure ConsentBasisRecord {
    @required
    id: String
    @required
    key: String
    @required
    label: String
}

structure ConsentBasisCreateInput {
    @required
    key: String
    @required
    label: String
}

structure ConsentBasisPatchInput {
}

structure ConsentCounterpartyRecord {
    @required
    id: String
    @required
    key: String
    @required
    label: String
}

structure ConsentCounterpartyCreateInput {
    @required
    key: String
    @required
    label: String
}

structure ConsentCounterpartyPatchInput {
}

structure ConsentDispositionRecord {
    @required
    id: String
    @required
    grant: String
    replacement: String
    @required
    withdrawn: Boolean
    @required
    effectiveAt: String
    @required
    recordedAt: String
    @required
    reason: String
}

structure ConsentDispositionCreateInput {
    @required
    grant: String
    replacement: String
    @required
    withdrawn: Boolean
    @required
    effectiveAt: String
    @required
    recordedAt: String
    @required
    reason: String
}

structure ConsentDispositionPatchInput {
}

structure ConsentEvidenceRecord {
    @required
    id: String
    @required
    grant: String
    @required
    capturedAt: String
    @required
    method: String
    @required
    provenance: String
}

structure ConsentEvidenceCreateInput {
    @required
    grant: String
    @required
    capturedAt: String
    @required
    method: String
    @required
    provenance: String
}

structure ConsentEvidencePatchInput {
}

structure ConsentGrantRecord {
    @required
    id: String
    @required
    subject: String
    grantedTo: String
    @required
    purpose: String
    @required
    activity: String
    @required
    scope: String
    basis: String
    conditions: String
    @required
    validFrom: String
    validUntil: String
    @required
    recordedAt: String
}

structure ConsentGrantCreateInput {
    @required
    subject: String
    grantedTo: String
    @required
    purpose: String
    @required
    activity: String
    @required
    scope: String
    basis: String
    conditions: String
    @required
    validFrom: String
    validUntil: String
    @required
    recordedAt: String
}

structure ConsentGrantPatchInput {
}

structure ConsentPurposeRecord {
    @required
    id: String
    @required
    key: String
    @required
    label: String
}

structure ConsentPurposeCreateInput {
    @required
    key: String
    @required
    label: String
}

structure ConsentPurposePatchInput {
}

structure ConsentScopeRecord {
    @required
    id: String
    @required
    key: String
    @required
    label: String
}

structure ConsentScopeCreateInput {
    @required
    key: String
    @required
    label: String
}

structure ConsentScopePatchInput {
}

structure ConsentSubjectRecord {
    @required
    id: String
    @required
    label: String
}

structure ConsentSubjectCreateInput {
    @required
    label: String
}

structure ConsentSubjectPatchInput {
}

structure ProcessingActivityRecord {
    @required
    id: String
    @required
    key: String
    @required
    label: String
}

structure ProcessingActivityCreateInput {
    @required
    key: String
    @required
    label: String
}

structure ProcessingActivityPatchInput {
}

structure AccessDecisionRecord {
    @required
    id: String
    @required
    person: String
    relied: String
    @required
    permitted: Boolean
    @required
    decidedAt: String
    @required
    reason: String
}

structure AccessDecisionCreateInput {
    @required
    person: String
    relied: String
    @required
    permitted: Boolean
    @required
    decidedAt: String
    @required
    reason: String
}

structure AccessDecisionPatchInput {
}

structure MarketingPreferenceRecord {
    @required
    id: String
    @required
    version: Long
    @required
    person: String
    @required
    channel: String
    @required
    enabled: Boolean
}

structure MarketingPreferenceCreateInput {
    @required
    person: String
    @required
    channel: String
    @required
    enabled: Boolean
}

structure MarketingPreferencePatchInput {
    person: String
    channel: String
    enabled: Boolean
}

structure PersonRecordRecord {
    @required
    id: String
    @required
    version: Long
    @required
    name: String
    @required
    consents: String
}

structure PersonRecordCreateInput {
    @required
    name: String
    @required
    consents: String
}

structure PersonRecordPatchInput {
    name: String
}

structure ResearchIntakeSubmissionRecord {
    @required
    id: String
    @required
    person: String
    @required
    formVersion: String
    @required
    submittedAt: String
    @required
    produced: String
}

structure ResearchIntakeSubmissionCreateInput {
    @required
    person: String
    @required
    formVersion: String
    @required
    submittedAt: String
    @required
    produced: String
}

structure ResearchIntakeSubmissionPatchInput {
}

