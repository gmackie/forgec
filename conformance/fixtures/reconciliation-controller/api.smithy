$version: "2.0"

namespace fixture.reconciliation.controller

@error("client")
structure Problem {
    @required
    code: String
    @required
    title: String
    detail: String
}

