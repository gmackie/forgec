$version: "2.0"

namespace foundation.probe.reachability.consumers

@error("client")
structure Problem {
    @required
    code: String
    @required
    title: String
    detail: String
}

structure ContactPointRecord {
    @required
    id: String
    @required
    locatorSet: String
    @required
    kind: String
    @required
    purpose: String
    @required
    value: String
    @required
    preference: Long
    @required
    validFrom: String
    validUntil: String
}

structure ContactPointCreateInput {
    @required
    locatorSet: String
    @required
    kind: String
    @required
    purpose: String
    @required
    value: String
    @required
    preference: Long
    @required
    validFrom: String
    validUntil: String
}

structure ContactPointPatchInput {
}

structure ContactPointDispositionRecord {
    @required
    id: String
    @required
    contactPoint: String
    replacement: String
    @required
    effectiveAt: String
    @required
    reason: String
}

structure ContactPointDispositionCreateInput {
    @required
    contactPoint: String
    replacement: String
    @required
    effectiveAt: String
    @required
    reason: String
}

structure ContactPointDispositionPatchInput {
}

structure ContactPointVerificationRecord {
    @required
    id: String
    @required
    contactPoint: String
    @required
    verifiedAt: String
    @required
    method: String
    @required
    evidence: String
}

structure ContactPointVerificationCreateInput {
    @required
    contactPoint: String
    @required
    verifiedAt: String
    @required
    method: String
    @required
    evidence: String
}

structure ContactPointVerificationPatchInput {
}

structure EndpointRecord {
    @required
    id: String
    @required
    locatorSet: String
    @required
    kind: String
    @required
    purpose: String
    @required
    value: String
    @required
    preference: Long
    @required
    validFrom: String
    validUntil: String
}

structure EndpointCreateInput {
    @required
    locatorSet: String
    @required
    kind: String
    @required
    purpose: String
    @required
    value: String
    @required
    preference: Long
    @required
    validFrom: String
    validUntil: String
}

structure EndpointPatchInput {
}

structure EndpointDispositionRecord {
    @required
    id: String
    @required
    endpoint: String
    replacement: String
    @required
    effectiveAt: String
    @required
    reason: String
}

structure EndpointDispositionCreateInput {
    @required
    endpoint: String
    replacement: String
    @required
    effectiveAt: String
    @required
    reason: String
}

structure EndpointDispositionPatchInput {
}

structure EndpointVerificationRecord {
    @required
    id: String
    @required
    endpoint: String
    @required
    verifiedAt: String
    @required
    method: String
    @required
    evidence: String
}

structure EndpointVerificationCreateInput {
    @required
    endpoint: String
    @required
    verifiedAt: String
    @required
    method: String
    @required
    evidence: String
}

structure EndpointVerificationPatchInput {
}

structure LocatorKindRecord {
    @required
    id: String
    @required
    key: String
    @required
    label: String
    @required
    personal: Boolean
}

structure LocatorKindCreateInput {
    @required
    key: String
    @required
    label: String
    @required
    personal: Boolean
}

structure LocatorKindPatchInput {
}

structure LocatorPurposeRecord {
    @required
    id: String
    @required
    key: String
    @required
    label: String
}

structure LocatorPurposeCreateInput {
    @required
    key: String
    @required
    label: String
}

structure LocatorPurposePatchInput {
}

structure LocatorSetRecord {
    @required
    id: String
    @required
    label: String
}

structure LocatorSetCreateInput {
    @required
    label: String
}

structure LocatorSetPatchInput {
}

structure CustomerAccountRecord {
    @required
    id: String
    @required
    version: Long
    @required
    name: String
    @required
    locators: String
}

structure CustomerAccountCreateInput {
    @required
    name: String
    @required
    locators: String
}

structure CustomerAccountPatchInput {
    name: String
}

structure FieldDeviceRecord {
    @required
    id: String
    @required
    version: Long
    @required
    serial: String
    @required
    locators: String
}

structure FieldDeviceCreateInput {
    @required
    serial: String
    @required
    locators: String
}

structure FieldDevicePatchInput {
    serial: String
}

structure OutboundRouteRecord {
    @required
    id: String
    @required
    service: String
    @required
    destination: String
}

structure OutboundRouteCreateInput {
    @required
    service: String
    @required
    destination: String
}

structure OutboundRoutePatchInput {
}

structure SupportServiceRecord {
    @required
    id: String
    @required
    version: Long
    @required
    name: String
    @required
    locators: String
}

structure SupportServiceCreateInput {
    @required
    name: String
    @required
    locators: String
}

structure SupportServicePatchInput {
    name: String
}

