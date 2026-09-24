$version: "2.0"

namespace fixture.sql.identifiers

@error("client")
structure Problem {
    @required
    code: String
    @required
    title: String
    detail: String
}

structure StageTransitionRecord {
    @required
    id: String
    @required
    from: String
    @required
    to: String
}

structure StageTransitionCreateInput {
    @required
    from: String
    @required
    to: String
}

structure StageTransitionPatchInput {
}

structure ToRecord {
    @required
    id: String
    @required
    key: String
}

structure ToCreateInput {
    @required
    key: String
}

structure ToPatchInput {
}

