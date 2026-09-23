$version: "2.0"

namespace foundation.probe.place.consumers

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

structure PlaceRecord {
    @required
    id: String
    @required
    version: Long
    parent: String
    @required
    identifiers: String
    @required
    name: String
}

structure PlaceCreateInput {
    @required
    identifiers: String
    @required
    name: String
}

structure PlacePatchInput {
    name: String
}

structure PlaceAddressRevisionRecord {
    @required
    id: String
    @required
    place: String
    @required
    revision: Long
    previous: String
    @required
    line1: String
    line2: String
    @required
    locality: String
    region: String
    postalCode: String
    @required
    countryCode: String
}

structure PlaceAddressRevisionCreateInput {
    @required
    place: String
    @required
    revision: Long
    previous: String
    @required
    line1: String
    line2: String
    @required
    locality: String
    region: String
    postalCode: String
    @required
    countryCode: String
}

structure PlaceAddressRevisionPatchInput {
}

structure PlaceTimezoneRevisionRecord {
    @required
    id: String
    @required
    place: String
    @required
    revision: Long
    previous: String
    @required
    zone: String
}

structure PlaceTimezoneRevisionCreateInput {
    @required
    place: String
    @required
    revision: Long
    previous: String
    @required
    zone: String
}

structure PlaceTimezoneRevisionPatchInput {
}

structure CustomerSiteRecord {
    @required
    id: String
    @required
    location: String
    @required
    address: String
}

structure CustomerSiteCreateInput {
    @required
    location: String
    @required
    address: String
}

structure CustomerSitePatchInput {
}

structure FacilityRecord {
    @required
    id: String
    @required
    location: String
}

structure FacilityCreateInput {
    @required
    location: String
}

structure FacilityPatchInput {
}

structure RoomRecord {
    @required
    id: String
    @required
    facility: String
    @required
    location: String
}

structure RoomCreateInput {
    @required
    facility: String
    @required
    location: String
}

structure RoomPatchInput {
}

structure WarehouseLocationRecord {
    @required
    id: String
    @required
    location: String
    @required
    aisle: String
}

structure WarehouseLocationCreateInput {
    @required
    location: String
    @required
    aisle: String
}

structure WarehouseLocationPatchInput {
}

