$version: "2.0"

namespace foundation.probe.ledger.consumers

@error("client")
structure Problem {
    @required
    code: String
    @required
    title: String
    detail: String
}

structure AccountRecord {
    @required
    id: String
    @required
    book: String
    @required
    key: String
    @required
    unit: String
}

structure AccountCreateInput {
    @required
    book: String
    @required
    key: String
    @required
    unit: String
}

structure AccountPatchInput {
}

structure EntryRecord {
    @required
    id: String
    @required
    book: String
    @required
    account: String
    @required
    quantity: String
    next: String
}

structure EntryCreateInput {
    @required
    book: String
    @required
    account: String
    @required
    quantity: String
    next: String
}

structure EntryPatchInput {
}

structure LedgerBookRecord {
    @required
    id: String
    @required
    key: String
}

structure LedgerBookCreateInput {
    @required
    key: String
}

structure LedgerBookPatchInput {
}

structure PostingGroupRecord {
    @required
    id: String
    @required
    createdAt: String
    @required
    updatedAt: String
    @required
    book: String
    @required
    key: String
    @required
    claim: String
    @required
    head: String
    @required
    policy: String
    reversalOf: String
    @required
    reason: String
}

structure PostingGroupCreateInput {
    @required
    book: String
    @required
    key: String
    @required
    claim: String
    @required
    head: String
    @required
    policy: String
    reversalOf: String
    @required
    reason: String
}

structure PostingGroupPatchInput {
}

structure ComputeCreditsRecord {
    @required
    id: String
    @required
    account: String
}

structure ComputeCreditsCreateInput {
    @required
    account: String
}

structure ComputeCreditsPatchInput {
    account: String
}

structure InventoryRecord {
    @required
    id: String
    @required
    account: String
}

structure InventoryCreateInput {
    @required
    account: String
}

structure InventoryPatchInput {
    account: String
}

structure MoneyRecord {
    @required
    id: String
    @required
    account: String
}

structure MoneyCreateInput {
    @required
    account: String
}

structure MoneyPatchInput {
    account: String
}

