$version: "2.0"

namespace forgegraph.foundation.lineage

@error("client")
structure Problem {
    @required
    code: String
    @required
    title: String
    detail: String
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

