$version: "2.0"

namespace fixture.self.reference

@error("client")
structure Problem {
    @required
    code: String
    @required
    title: String
    detail: String
}

structure NoteRecord {
    @required
    id: String
    @required
    version: Long
    @required
    thread: String
}

structure NoteCreateInput {
    @required
    thread: String
}

structure NotePatchInput {
    thread: String
}

structure ThreadRecord {
    @required
    id: String
    @required
    version: Long
    @required
    title: String
    @required
    root: String
}

structure ThreadCreateInput {
    @required
    title: String
    @required
    root: String
}

structure ThreadPatchInput {
    title: String
}

