$version: "2.0"

namespace foundation.probe.identifier.consumers

@error("client")
structure Problem {
    @required
    code: String
    @required
    title: String
    detail: String
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

structure GitHubRepositoryRecord {
    @required
    id: String
    @required
    version: Long
    @required
    name: String
    @required
    identifiers: String
}

structure GitHubRepositoryCreateInput {
    @required
    name: String
    @required
    identifiers: String
}

structure GitHubRepositoryPatchInput {
    name: String
}

structure HospitalIssuerRecord {
    @required
    id: String
    @required
    issuer: String
    @required
    name: String
}

structure HospitalIssuerCreateInput {
    @required
    issuer: String
    @required
    name: String
}

structure HospitalIssuerPatchInput {
}

structure PatientRecordRecord {
    @required
    id: String
    @required
    version: Long
    @required
    medicalRecordNumbers: String
}

structure PatientRecordCreateInput {
    @required
    medicalRecordNumbers: String
}

structure PatientRecordPatchInput {
}

structure SerializedDeviceRecord {
    @required
    id: String
    @required
    version: Long
    @required
    serials: String
}

structure SerializedDeviceCreateInput {
    @required
    serials: String
}

structure SerializedDevicePatchInput {
}

