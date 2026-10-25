$version: "2.0"

namespace fixture.error.status

@error("client")
structure Problem {
    @required
    code: String
    @required
    title: String
    detail: String
}

structure ValidateManifestInput {
    @required
    manifest: String
}

@http(method: "POST", uri: "/v1/manifests/validate")
operation ValidateManifest {
    input: ValidateManifestInput
    errors: [Problem]
}

