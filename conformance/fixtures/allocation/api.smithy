$version: "2.0"

namespace forgegraph.foundation.allocation

@error("client")
structure Problem {
    @required
    code: String
    @required
    title: String
    detail: String
}

structure AllocationJournalRecord {
    @required
    id: String
    @required
    pool: String
    @required
    ordinal: Long
    @required
    commandKey: String
    previous: String
    @required
    reservation: String
    @required
    action: String
    @required
    at: String
}

structure AllocationJournalCreateInput {
    @required
    pool: String
    @required
    ordinal: Long
    @required
    commandKey: String
    previous: String
    @required
    reservation: String
    @required
    action: String
    @required
    at: String
}

structure AllocationJournalPatchInput {
}

structure AllocationPoolRecord {
    @required
    id: String
    @required
    key: String
    @required
    mode: String
    @required
    capacity: String
    @required
    unit: String
}

structure AllocationPoolCreateInput {
    @required
    key: String
    @required
    mode: String
    @required
    capacity: String
    @required
    unit: String
}

structure AllocationPoolPatchInput {
}

structure AllocationReservationRecord {
    @required
    id: String
    @required
    pool: String
    @required
    key: String
    @required
    quantity: String
    @required
    unit: String
    @required
    from: String
    @required
    until: String
    @required
    holdUntil: String
}

structure AllocationReservationCreateInput {
    @required
    pool: String
    @required
    key: String
    @required
    quantity: String
    @required
    unit: String
    @required
    from: String
    @required
    until: String
    @required
    holdUntil: String
}

structure AllocationReservationPatchInput {
}

