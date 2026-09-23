$version: "2.0"

namespace foundation.probe.usage.consumers

@error("client")
structure Problem {
    @required
    code: String
    @required
    title: String
    detail: String
}

structure UsageCorrectionRecord {
    @required
    id: String
    @required
    event: String
    replacement: String
    @required
    reason: String
}

structure UsageCorrectionCreateInput {
    @required
    event: String
    replacement: String
    @required
    reason: String
}

structure UsageCorrectionPatchInput {
}

structure UsageDimensionRecord {
    @required
    id: String
    @required
    key: String
    @required
    unit: String
}

structure UsageDimensionCreateInput {
    @required
    key: String
    @required
    unit: String
}

structure UsageDimensionPatchInput {
}

structure UsageEventRecord {
    @required
    id: String
    @required
    stream: String
    @required
    dimension: String
    @required
    unit: String
    @required
    quantity: String
    @required
    ordinal: Long
    @required
    source: String
    @required
    eventKey: String
    occurredAt: String
    intervalStart: String
    intervalEnd: String
    replacementFor: String
}

structure UsageEventCreateInput {
    @required
    stream: String
    @required
    dimension: String
    @required
    unit: String
    @required
    quantity: String
    @required
    ordinal: Long
    @required
    source: String
    @required
    eventKey: String
    occurredAt: String
    intervalStart: String
    intervalEnd: String
    replacementFor: String
}

structure UsageEventPatchInput {
}

structure UsageSourceRecord {
    @required
    id: String
    @required
    key: String
}

structure UsageSourceCreateInput {
    @required
    key: String
}

structure UsageSourcePatchInput {
}

structure UsageStreamRecord {
    @required
    id: String
    @required
    label: String
    @required
    dimension: String
}

structure UsageStreamCreateInput {
    @required
    label: String
    @required
    dimension: String
}

structure UsageStreamPatchInput {
}

structure ComputeRunRecord {
    @required
    id: String
    @required
    computeUsage: String
}

structure ComputeRunCreateInput {
    @required
    computeUsage: String
}

structure ComputeRunPatchInput {
}

structure LlmSessionRecord {
    @required
    id: String
    @required
    tokenUsage: String
}

structure LlmSessionCreateInput {
    @required
    tokenUsage: String
}

structure LlmSessionPatchInput {
}

structure MachineRunRecord {
    @required
    id: String
    @required
    machineUsage: String
}

structure MachineRunCreateInput {
    @required
    machineUsage: String
}

structure MachineRunPatchInput {
}

