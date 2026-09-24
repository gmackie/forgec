$version: "2.0"

namespace fixture.returns.consumer

@error("client")
structure Problem {
    @required
    code: String
    @required
    title: String
    detail: String
}

structure CommerceReturnRecord {
    @required
    id: String
    @required
    request: String
    @required
    orderNumber: String
}

structure CommerceReturnCreateInput {
    @required
    request: String
    @required
    orderNumber: String
}

structure CommerceReturnPatchInput {
}

structure LoanReturnRecord {
    @required
    id: String
    @required
    request: String
    @required
    loan: String
}

structure LoanReturnCreateInput {
    @required
    request: String
    @required
    loan: String
}

structure LoanReturnPatchInput {
}

structure MaterialReturnRecord {
    @required
    id: String
    @required
    request: String
    @required
    lot: String
}

structure MaterialReturnCreateInput {
    @required
    request: String
    @required
    lot: String
}

structure MaterialReturnPatchInput {
}

structure WarrantyReturnRecord {
    @required
    id: String
    @required
    request: String
    @required
    warranty: String
}

structure WarrantyReturnCreateInput {
    @required
    request: String
    @required
    warranty: String
}

structure WarrantyReturnPatchInput {
}

structure AgreementRecord {
    @required
    id: String
    @required
    createdAt: String
    @required
    updatedAt: String
    acceptance: String
    @required
    acceptanceKey: String
    @required
    offer: String
    @required
    supplier: String
    @required
    customer: String
    @required
    supplierParticipation: String
    @required
    customerParticipation: String
    supplierEnd: String
    customerEnd: String
    @required
    qualification: String
    @required
    approvalOption: String
    @required
    approval: String
    @required
    terms: String
    document: String
    @required
    validFrom: String
    @required
    validUntil: String
    predecessor: String
    @required
    change: String
    @required
    recordedBy: String
}

structure AgreementCreateInput {
    acceptance: String
    @required
    acceptanceKey: String
    @required
    offer: String
    @required
    supplier: String
    @required
    customer: String
    @required
    supplierParticipation: String
    @required
    customerParticipation: String
    supplierEnd: String
    customerEnd: String
    @required
    qualification: String
    @required
    approvalOption: String
    @required
    approval: String
    @required
    terms: String
    document: String
    @required
    validFrom: String
    @required
    validUntil: String
    predecessor: String
    @required
    change: String
    @required
    recordedBy: String
}

structure AgreementPatchInput {
}

structure AgreementAcceptanceRecord {
    @required
    id: String
    @required
    createdAt: String
    @required
    updatedAt: String
    @required
    acceptanceKey: String
    @required
    offer: String
    @required
    supplier: String
    @required
    customer: String
    @required
    supplierParticipation: String
    @required
    customerParticipation: String
    supplierEnd: String
    customerEnd: String
    @required
    qualification: String
    @required
    approvalOption: String
    @required
    approval: String
    @required
    terms: String
    document: String
    @required
    offerValidFrom: String
    @required
    offerValidUntil: String
    @required
    validFrom: String
    @required
    validUntil: String
    predecessor: String
    @required
    change: String
    @required
    recordedBy: String
}

structure AgreementAcceptanceCreateInput {
    @required
    acceptanceKey: String
    @required
    offer: String
    @required
    supplier: String
    @required
    customer: String
    @required
    supplierParticipation: String
    @required
    customerParticipation: String
    supplierEnd: String
    customerEnd: String
    @required
    qualification: String
    @required
    approvalOption: String
    @required
    approval: String
    @required
    terms: String
    document: String
    @required
    offerValidFrom: String
    @required
    offerValidUntil: String
    @required
    validFrom: String
    @required
    validUntil: String
    predecessor: String
    @required
    change: String
    @required
    recordedBy: String
}

structure AgreementAcceptancePatchInput {
}

structure AgreementAcceptanceCommitRecord {
    @required
    id: String
    @required
    createdAt: String
    @required
    updatedAt: String
    @required
    acceptance: String
    @required
    acceptanceKey: String
    @required
    offer: String
    @required
    supplier: String
    @required
    customer: String
    @required
    supplierParticipation: String
    @required
    customerParticipation: String
    supplierEnd: String
    customerEnd: String
    @required
    qualification: String
    @required
    approvalOption: String
    @required
    approval: String
    @required
    terms: String
    document: String
    @required
    offerValidFrom: String
    @required
    offerValidUntil: String
    @required
    validFrom: String
    @required
    validUntil: String
    predecessor: String
    @required
    change: String
    @required
    recordedBy: String
}

structure AgreementAcceptanceCommitCreateInput {
    @required
    acceptance: String
    @required
    acceptanceKey: String
    @required
    offer: String
    @required
    supplier: String
    @required
    customer: String
    @required
    supplierParticipation: String
    @required
    customerParticipation: String
    supplierEnd: String
    customerEnd: String
    @required
    qualification: String
    @required
    approvalOption: String
    @required
    approval: String
    @required
    terms: String
    document: String
    @required
    offerValidFrom: String
    @required
    offerValidUntil: String
    @required
    validFrom: String
    @required
    validUntil: String
    predecessor: String
    @required
    change: String
    @required
    recordedBy: String
}

structure AgreementAcceptanceCommitPatchInput {
}

structure AgreementEntitlementLinkRecord {
    @required
    id: String
    @required
    agreement: String
    @required
    offer: String
    @required
    entitlement: String
}

structure AgreementEntitlementLinkCreateInput {
    @required
    agreement: String
    @required
    offer: String
    @required
    entitlement: String
}

structure AgreementEntitlementLinkPatchInput {
}

structure AgreementEventRecord {
    @required
    id: String
    @required
    createdAt: String
    @required
    updatedAt: String
    @required
    agreement: String
    @required
    ordinal: Long
    previous: String
    @required
    kind: String
    @required
    reason: String
    @required
    recordedBy: String
}

structure AgreementEventCreateInput {
    @required
    agreement: String
    @required
    ordinal: Long
    previous: String
    @required
    kind: String
    @required
    reason: String
    @required
    recordedBy: String
}

structure AgreementEventPatchInput {
}

structure AgreementIssuedRecord {
    @required
    id: String
    @required
    createdAt: String
    @required
    updatedAt: String
    @required
    agreement: String
    @required
    offer: String
    @required
    terms: String
    @required
    supplier: String
    @required
    customer: String
    right: String
    duty: String
}

structure AgreementIssuedCreateInput {
    @required
    agreement: String
    @required
    offer: String
    @required
    terms: String
    @required
    supplier: String
    @required
    customer: String
    right: String
    duty: String
}

structure AgreementIssuedPatchInput {
}

structure AgreementObligationLinkRecord {
    @required
    id: String
    @required
    agreement: String
    @required
    offer: String
    @required
    obligation: String
}

structure AgreementObligationLinkCreateInput {
    @required
    agreement: String
    @required
    offer: String
    @required
    obligation: String
}

structure AgreementObligationLinkPatchInput {
}

structure AgreementParticipantRecord {
    @required
    id: String
    @required
    agreement: String
    @required
    side: String
    @required
    participant: String
}

structure AgreementParticipantCreateInput {
    @required
    agreement: String
    @required
    side: String
    @required
    participant: String
}

structure AgreementParticipantPatchInput {
}

structure AgreementTermLinkRecord {
    @required
    id: String
    @required
    agreement: String
    @required
    specification: String
    artifact: String
}

structure AgreementTermLinkCreateInput {
    @required
    agreement: String
    @required
    specification: String
    artifact: String
}

structure AgreementTermLinkPatchInput {
}

structure CatalogRecord {
    @required
    id: String
    @required
    key: String
    @required
    label: String
}

structure CatalogCreateInput {
    @required
    key: String
    @required
    label: String
}

structure CatalogPatchInput {
}

structure CatalogEntryRecord {
    @required
    id: String
    @required
    catalog: String
    @required
    key: String
    @required
    specification: String
}

structure CatalogEntryCreateInput {
    @required
    catalog: String
    @required
    key: String
    @required
    specification: String
}

structure CatalogEntryPatchInput {
}

structure OfferRecord {
    @required
    id: String
    @required
    createdAt: String
    @required
    updatedAt: String
    @required
    entry: String
    @required
    revision: Long
    previous: String
    @required
    supplier: String
    @required
    terms: String
    document: String
    support: String
    evaluation: String
    right: String
    requirement: String
    @required
    scope: String
    @required
    validFrom: String
    @required
    validUntil: String
}

structure OfferCreateInput {
    @required
    entry: String
    @required
    revision: Long
    previous: String
    @required
    supplier: String
    @required
    terms: String
    document: String
    support: String
    evaluation: String
    right: String
    requirement: String
    @required
    scope: String
    @required
    validFrom: String
    @required
    validUntil: String
}

structure OfferPatchInput {
}

structure OfferQualificationRecord {
    @required
    id: String
    @required
    createdAt: String
    @required
    updatedAt: String
    @required
    offer: String
    @required
    decisionCase: String
    @required
    approvedOption: String
}

structure OfferQualificationCreateInput {
    @required
    offer: String
    @required
    decisionCase: String
    @required
    approvedOption: String
}

structure OfferQualificationPatchInput {
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
    replacement: String
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
    replacement: String
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

structure ArtifactRecord {
    @required
    id: String
    @required
    key: String
    @required
    label: String
}

structure ArtifactCreateInput {
    @required
    key: String
    @required
    label: String
}

structure ArtifactPatchInput {
}

structure ArtifactComponentRecord {
    @required
    id: String
    @required
    name: String
    @required
    revision: String
    next: String
}

structure ArtifactComponentCreateInput {
    @required
    name: String
    @required
    revision: String
    next: String
}

structure ArtifactComponentPatchInput {
}

structure ArtifactContentRecord {
    @required
    id: String
    @required
    version: Long
    @required
    createdAt: String
    @required
    updatedAt: String
    @required
    uploadState: String
    mediaType: String
    byteCount: String
    digest: String
}

structure ArtifactContentCreateInput {
}

structure ArtifactContentPatchInput {
}

structure ArtifactRevisionRecord {
    @required
    id: String
    @required
    createdAt: String
    @required
    updatedAt: String
    @required
    artifact: String
    @required
    content: String
    @required
    digest: String
    @required
    mediaType: String
    @required
    byteCount: Long
    specificationPin: String
    realization: String
    components: String
}

structure ArtifactRevisionCreateInput {
    @required
    artifact: String
    @required
    content: String
    @required
    digest: String
    @required
    mediaType: String
    @required
    byteCount: Long
    specificationPin: String
    realization: String
    components: String
}

structure ArtifactRevisionPatchInput {
}

structure AvailabilityCalendarRecord {
    @required
    id: String
    @required
    label: String
}

structure AvailabilityCalendarCreateInput {
    @required
    label: String
}

structure AvailabilityCalendarPatchInput {
}

structure AvailabilityCalendarRevisionRecord {
    @required
    id: String
    @required
    calendar: String
    @required
    ruleSet: String
    @required
    ruleCount: Long
    @required
    rulesDigest: String
    @required
    timezone: String
    @required
    timezoneDataVersion: String
    origin: String
}

structure AvailabilityCalendarRevisionCreateInput {
    @required
    calendar: String
    @required
    ruleSet: String
    @required
    ruleCount: Long
    @required
    rulesDigest: String
    @required
    timezone: String
    @required
    timezoneDataVersion: String
    origin: String
}

structure AvailabilityCalendarRevisionPatchInput {
}

structure AvailabilityRuleRecord {
    @required
    id: String
    @required
    ruleSet: String
    @required
    ordinal: Long
    @required
    kind: String
    weekday: String
    localDate: String
    startMinute: String
    endMinute: String
    @required
    available: Boolean
    from: String
    until: String
    priority: String
}

structure AvailabilityRuleCreateInput {
    @required
    ruleSet: String
    @required
    ordinal: Long
    @required
    kind: String
    weekday: String
    localDate: String
    startMinute: String
    endMinute: String
    @required
    available: Boolean
    from: String
    until: String
    priority: String
}

structure AvailabilityRulePatchInput {
}

structure AvailabilityRuleSetRecord {
    @required
    id: String
    @required
    calendar: String
}

structure AvailabilityRuleSetCreateInput {
    @required
    calendar: String
}

structure AvailabilityRuleSetPatchInput {
}

structure BillRecord {
    @required
    id: String
    @required
    key: String
    @required
    period: String
    @required
    head: String
    corrects: String
    @required
    reason: String
}

structure BillCreateInput {
    @required
    key: String
    @required
    period: String
    @required
    head: String
    corrects: String
    @required
    reason: String
}

structure BillPatchInput {
}

structure BillIssuedRecord {
    @required
    id: String
    @required
    createdAt: String
    @required
    updatedAt: String
    @required
    bill: String
    @required
    digest: String
    @required
    issuedBy: String
}

structure BillIssuedCreateInput {
    @required
    bill: String
    @required
    digest: String
    @required
    issuedBy: String
}

structure BillIssuedPatchInput {
}

structure BillPositionRecord {
    @required
    id: String
    @required
    bill: String
    @required
    issue: String
    @required
    period: String
    @required
    agreement: String
    @required
    position: String
}

structure BillPositionCreateInput {
    @required
    bill: String
    @required
    issue: String
    @required
    period: String
    @required
    agreement: String
    @required
    position: String
}

structure BillPositionPatchInput {
}

structure BilledChargeRecord {
    @required
    id: String
    @required
    bill: String
    @required
    charge: String
}

structure BilledChargeCreateInput {
    @required
    bill: String
    @required
    charge: String
}

structure BilledChargePatchInput {
}

structure BillingChargeRecord {
    @required
    id: String
    @required
    period: String
    @required
    sourceKey: String
    @required
    kind: String
    rate: String
    meter: String
    usageEvent: String
    adjustment: String
    adjustmentFor: String
    @required
    definition: String
    @required
    account: String
    @required
    quantity: String
    @required
    amount: String
    @required
    ratedAt: String
    @required
    source: String
}

structure BillingChargeCreateInput {
    @required
    period: String
    @required
    sourceKey: String
    @required
    kind: String
    rate: String
    meter: String
    usageEvent: String
    adjustment: String
    adjustmentFor: String
    @required
    definition: String
    @required
    account: String
    @required
    quantity: String
    @required
    amount: String
    @required
    ratedAt: String
    @required
    source: String
}

structure BillingChargePatchInput {
}

structure BillingLineRecord {
    @required
    id: String
    @required
    charge: String
    next: String
}

structure BillingLineCreateInput {
    @required
    charge: String
    next: String
}

structure BillingLinePatchInput {
}

structure BillingMeterRateRecord {
    @required
    id: String
    @required
    rate: String
    @required
    dimension: String
}

structure BillingMeterRateCreateInput {
    @required
    rate: String
    @required
    dimension: String
}

structure BillingMeterRatePatchInput {
}

structure BillingPeriodRecord {
    @required
    id: String
    @required
    agreement: String
    @required
    terms: String
    @required
    from: String
    @required
    until: String
}

structure BillingPeriodCreateInput {
    @required
    agreement: String
    @required
    terms: String
    @required
    from: String
    @required
    until: String
}

structure BillingPeriodPatchInput {
}

structure BillingRecurringClaimRecord {
    @required
    id: String
    @required
    period: String
    @required
    rate: String
    @required
    sourceKey: String
}

structure BillingRecurringClaimCreateInput {
    @required
    period: String
    @required
    rate: String
    @required
    sourceKey: String
}

structure BillingRecurringClaimPatchInput {
}

structure DecisionCaseRecord {
    @required
    id: String
    @required
    createdAt: String
    @required
    updatedAt: String
    @required
    participationSet: String
    @required
    eligibilityAt: String
    @required
    electors: String
    @required
    rule: String
    @required
    ruleVersion: String
    @required
    threshold: Long
    @required
    optionCount: Long
    @required
    deadline: String
    support: String
    evaluation: String
    reconsideration: String
}

structure DecisionCaseCreateInput {
    @required
    participationSet: String
    @required
    eligibilityAt: String
    @required
    electors: String
    @required
    rule: String
    @required
    ruleVersion: String
    @required
    threshold: Long
    @required
    optionCount: Long
    @required
    deadline: String
    support: String
    evaluation: String
    reconsideration: String
}

structure DecisionCasePatchInput {
}

structure DecisionElectorRecord {
    @required
    id: String
    @required
    participation: String
    ended: String
    next: String
    @required
    depth: Long
}

structure DecisionElectorCreateInput {
    @required
    participation: String
    ended: String
    next: String
    @required
    depth: Long
}

structure DecisionElectorPatchInput {
}

structure DecisionEventRecord {
    @required
    id: String
    @required
    createdAt: String
    @required
    updatedAt: String
    @required
    decisionCase: String
    @required
    ordinal: Long
    previous: String
    @required
    kind: String
    response: String
    outcome: String
    @required
    recordedBy: String
}

structure DecisionEventCreateInput {
    @required
    decisionCase: String
    @required
    ordinal: Long
    previous: String
    @required
    kind: String
    response: String
    outcome: String
    @required
    recordedBy: String
}

structure DecisionEventPatchInput {
}

structure DecisionOptionRecord {
    @required
    id: String
    @required
    decisionCase: String
    @required
    ordinal: Long
    @required
    label: String
}

structure DecisionOptionCreateInput {
    @required
    decisionCase: String
    @required
    ordinal: Long
    @required
    label: String
}

structure DecisionOptionPatchInput {
}

structure DecisionOutcomeRecord {
    @required
    id: String
    @required
    decisionCase: String
    @required
    selected: String
    @required
    responses: String
    @required
    snapshotDigest: String
}

structure DecisionOutcomeCreateInput {
    @required
    decisionCase: String
    @required
    selected: String
    @required
    responses: String
    @required
    snapshotDigest: String
}

structure DecisionOutcomePatchInput {
}

structure DecisionOutcomeMemberRecord {
    @required
    id: String
    @required
    response: String
    next: String
    @required
    depth: Long
}

structure DecisionOutcomeMemberCreateInput {
    @required
    response: String
    next: String
    @required
    depth: Long
}

structure DecisionOutcomeMemberPatchInput {
}

structure DecisionResponseRecord {
    @required
    id: String
    @required
    decisionCase: String
    @required
    voter: String
    @required
    ranking: String
    support: String
    @required
    recordedBy: String
}

structure DecisionResponseCreateInput {
    @required
    decisionCase: String
    @required
    voter: String
    @required
    ranking: String
    support: String
    @required
    recordedBy: String
}

structure DecisionResponsePatchInput {
}

structure DemandRecord {
    @required
    id: String
    @required
    createdAt: String
    @required
    updatedAt: String
    @required
    key: String
    @required
    requester: String
    @required
    specification: String
    @required
    constraints: String
    @required
    origin: String
    @required
    quantity: String
    @required
    unit: String
    place: String
    @required
    from: String
    @required
    until: String
    @required
    priority: Long
    @required
    priorityPolicy: String
    @required
    source: String
    support: String
}

structure DemandCreateInput {
    @required
    key: String
    @required
    requester: String
    @required
    specification: String
    @required
    constraints: String
    @required
    origin: String
    @required
    quantity: String
    @required
    unit: String
    place: String
    @required
    from: String
    @required
    until: String
    @required
    priority: Long
    @required
    priorityPolicy: String
    @required
    source: String
    support: String
}

structure DemandPatchInput {
}

structure DemandAllocationRecord {
    @required
    id: String
    @required
    demand: String
    @required
    reservation: String
}

structure DemandAllocationCreateInput {
    @required
    demand: String
    @required
    reservation: String
}

structure DemandAllocationPatchInput {
}

structure DemandGroupRecord {
    @required
    id: String
    @required
    memberCount: Long
    @required
    key: String
    @required
    specification: String
    @required
    constraints: String
    @required
    unit: String
    place: String
    @required
    from: String
    @required
    until: String
}

structure DemandGroupCreateInput {
    @required
    memberCount: Long
    @required
    key: String
    @required
    specification: String
    @required
    constraints: String
    @required
    unit: String
    place: String
    @required
    from: String
    @required
    until: String
}

structure DemandGroupPatchInput {
}

structure DemandGroupMemberRecord {
    @required
    id: String
    @required
    group: String
    @required
    ordinal: Long
    @required
    demand: String
}

structure DemandGroupMemberCreateInput {
    @required
    group: String
    @required
    ordinal: Long
    @required
    demand: String
}

structure DemandGroupMemberPatchInput {
}

structure DemandResolutionRecord {
    @required
    id: String
    @required
    createdAt: String
    @required
    updatedAt: String
    @required
    demand: String
    @required
    outcome: String
    replacement: String
    fulfillment: String
    @required
    at: String
    @required
    reason: String
    @required
    recordedBy: String
}

structure DemandResolutionCreateInput {
    @required
    demand: String
    @required
    outcome: String
    replacement: String
    fulfillment: String
    @required
    at: String
    @required
    reason: String
    @required
    recordedBy: String
}

structure DemandResolutionPatchInput {
}

structure DemandRouteRecord {
    @required
    id: String
    @required
    demand: String
    @required
    resolution: String
    @required
    fulfillment: String
    @required
    request: String
}

structure DemandRouteCreateInput {
    @required
    demand: String
    @required
    resolution: String
    @required
    fulfillment: String
    @required
    request: String
}

structure DemandRoutePatchInput {
}

structure DemandScheduleRecord {
    @required
    id: String
    @required
    demand: String
    @required
    resolution: String
    @required
    fulfillment: String
    @required
    appointment: String
    @required
    slot: String
    @required
    requirement: String
}

structure DemandScheduleCreateInput {
    @required
    demand: String
    @required
    resolution: String
    @required
    fulfillment: String
    @required
    appointment: String
    @required
    slot: String
    @required
    requirement: String
}

structure DemandSchedulePatchInput {
}

structure DemandSubmissionRecord {
    @required
    id: String
    @required
    demand: String
    @required
    submission: String
    @required
    validation: String
}

structure DemandSubmissionCreateInput {
    @required
    demand: String
    @required
    submission: String
    @required
    validation: String
}

structure DemandSubmissionPatchInput {
}

structure EntitlementRecord {
    @required
    id: String
    @required
    createdAt: String
    @required
    updatedAt: String
    @required
    holder: String
    @required
    right: String
    @required
    scope: String
    quantity: String
    unit: String
    @required
    validFrom: String
    validUntil: String
    predecessor: String
    @required
    recordedBy: String
    @required
    reason: String
}

structure EntitlementCreateInput {
    @required
    holder: String
    @required
    right: String
    @required
    scope: String
    quantity: String
    unit: String
    @required
    validFrom: String
    validUntil: String
    predecessor: String
    @required
    recordedBy: String
    @required
    reason: String
}

structure EntitlementPatchInput {
}

structure EntitlementEndRecord {
    @required
    id: String
    @required
    createdAt: String
    @required
    updatedAt: String
    @required
    entitlement: String
    @required
    kind: String
    @required
    effectiveAt: String
    @required
    recordedBy: String
    @required
    reason: String
}

structure EntitlementEndCreateInput {
    @required
    entitlement: String
    @required
    kind: String
    @required
    effectiveAt: String
    @required
    recordedBy: String
    @required
    reason: String
}

structure EntitlementEndPatchInput {
}

structure EntitlementScopeRecord {
    @required
    id: String
    @required
    label: String
}

structure EntitlementScopeCreateInput {
    @required
    label: String
}

structure EntitlementScopePatchInput {
}

structure ObligationRecord {
    @required
    id: String
    @required
    createdAt: String
    @required
    updatedAt: String
    @required
    obligatedParty: String
    @required
    requirement: String
    @required
    scope: String
    quantity: String
    unit: String
    @required
    incurredAt: String
    dueAt: String
    @required
    recordedBy: String
    @required
    reason: String
}

structure ObligationCreateInput {
    @required
    obligatedParty: String
    @required
    requirement: String
    @required
    scope: String
    quantity: String
    unit: String
    @required
    incurredAt: String
    dueAt: String
    @required
    recordedBy: String
    @required
    reason: String
}

structure ObligationPatchInput {
}

structure ObligationEndRecord {
    @required
    id: String
    @required
    createdAt: String
    @required
    updatedAt: String
    @required
    obligation: String
    @required
    kind: String
    @required
    effectiveAt: String
    @required
    recordedBy: String
    @required
    reason: String
}

structure ObligationEndCreateInput {
    @required
    obligation: String
    @required
    kind: String
    @required
    effectiveAt: String
    @required
    recordedBy: String
    @required
    reason: String
}

structure ObligationEndPatchInput {
}

structure RequirementDefinitionRecord {
    @required
    id: String
    @required
    namespace: String
    @required
    name: String
}

structure RequirementDefinitionCreateInput {
    @required
    namespace: String
    @required
    name: String
}

structure RequirementDefinitionPatchInput {
}

structure RightDefinitionRecord {
    @required
    id: String
    @required
    namespace: String
    @required
    name: String
}

structure RightDefinitionCreateInput {
    @required
    namespace: String
    @required
    name: String
}

structure RightDefinitionPatchInput {
}

structure EvaluationExecutorRecord {
    @required
    id: String
    @required
    key: String
    @required
    label: String
}

structure EvaluationExecutorCreateInput {
    @required
    key: String
    @required
    label: String
}

structure EvaluationExecutorPatchInput {
}

structure EvaluationFinishRecord {
    @required
    id: String
    @required
    run: String
    start: String
    @required
    outcome: String
    @required
    finishedAt: String
    support: String
    @required
    reason: String
    @required
    recordedBy: String
}

structure EvaluationFinishCreateInput {
    @required
    run: String
    start: String
    @required
    outcome: String
    @required
    finishedAt: String
    support: String
    @required
    reason: String
    @required
    recordedBy: String
}

structure EvaluationFinishPatchInput {
}

structure EvaluationQuarantineRecord {
    @required
    id: String
    @required
    createdAt: String
    @required
    updatedAt: String
    @required
    run: String
    @required
    sourceDigest: String
    @required
    reason: String
    @required
    recordedBy: String
}

structure EvaluationQuarantineCreateInput {
    @required
    run: String
    @required
    sourceDigest: String
    @required
    reason: String
    @required
    recordedBy: String
}

structure EvaluationQuarantinePatchInput {
}

structure EvaluationRunRecord {
    @required
    id: String
    @required
    createdAt: String
    @required
    updatedAt: String
    @required
    evaluationSet: String
    @required
    definition: String
    @required
    executor: String
    parent: String
    @required
    depth: Long
}

structure EvaluationRunCreateInput {
    @required
    evaluationSet: String
    @required
    definition: String
    @required
    executor: String
    parent: String
    @required
    depth: Long
}

structure EvaluationRunPatchInput {
}

structure EvaluationSetRecord {
    @required
    id: String
    @required
    label: String
}

structure EvaluationSetCreateInput {
    @required
    label: String
}

structure EvaluationSetPatchInput {
}

structure EvaluationStartRecord {
    @required
    id: String
    @required
    createdAt: String
    @required
    updatedAt: String
    @required
    run: String
    @required
    startedAt: String
    @required
    recordedBy: String
}

structure EvaluationStartCreateInput {
    @required
    run: String
    @required
    startedAt: String
    @required
    recordedBy: String
}

structure EvaluationStartPatchInput {
}

structure EvidenceBundleRecord {
    @required
    id: String
    @required
    createdAt: String
    @required
    updatedAt: String
    @required
    key: String
    @required
    label: String
    predecessor: String
}

structure EvidenceBundleCreateInput {
    @required
    key: String
    @required
    label: String
    predecessor: String
}

structure EvidenceBundlePatchInput {
}

structure EvidenceItemRecord {
    @required
    id: String
    @required
    createdAt: String
    @required
    updatedAt: String
    @required
    bundle: String
    @required
    source: String
    @required
    sourceRecord: String
    @required
    kind: String
    @required
    observedAt: String
    revision: String
    digest: String
    @required
    provenance: String
}

structure EvidenceItemCreateInput {
    @required
    bundle: String
    @required
    source: String
    @required
    sourceRecord: String
    @required
    kind: String
    @required
    observedAt: String
    revision: String
    digest: String
    @required
    provenance: String
}

structure EvidenceItemPatchInput {
}

structure EvidenceMemberRecord {
    @required
    id: String
    @required
    bundle: String
    @required
    item: String
    next: String
    @required
    depth: Long
}

structure EvidenceMemberCreateInput {
    @required
    bundle: String
    @required
    item: String
    next: String
    @required
    depth: Long
}

structure EvidenceMemberPatchInput {
}

structure EvidenceSealRecord {
    @required
    id: String
    @required
    createdAt: String
    @required
    updatedAt: String
    @required
    bundle: String
    head: String
    @required
    recordedBy: String
}

structure EvidenceSealCreateInput {
    @required
    bundle: String
    head: String
    @required
    recordedBy: String
}

structure EvidenceSealPatchInput {
}

structure EvidenceSourceRecord {
    @required
    id: String
    @required
    key: String
    @required
    label: String
}

structure EvidenceSourceCreateInput {
    @required
    key: String
    @required
    label: String
}

structure EvidenceSourcePatchInput {
}

structure FulfillmentRecord {
    @required
    id: String
    @required
    fulfillmentSet: String
    @required
    ordinal: Long
    specificationPin: String
    @required
    executor: String
    @required
    requestedAt: String
    evidence: String
}

structure FulfillmentCreateInput {
    @required
    fulfillmentSet: String
    @required
    ordinal: Long
    specificationPin: String
    @required
    executor: String
    @required
    requestedAt: String
    evidence: String
}

structure FulfillmentPatchInput {
}

structure FulfillmentEndRecord {
    @required
    id: String
    @required
    fulfillment: String
    start: String
    @required
    outcome: String
    @required
    coverage: String
    @required
    endedAt: String
    evidence: String
    @required
    reason: String
    @required
    recordedBy: String
}

structure FulfillmentEndCreateInput {
    @required
    fulfillment: String
    start: String
    @required
    outcome: String
    @required
    coverage: String
    @required
    endedAt: String
    evidence: String
    @required
    reason: String
    @required
    recordedBy: String
}

structure FulfillmentEndPatchInput {
}

structure FulfillmentExecutorRecord {
    @required
    id: String
    @required
    key: String
}

structure FulfillmentExecutorCreateInput {
    @required
    key: String
}

structure FulfillmentExecutorPatchInput {
}

structure FulfillmentReplacementRecord {
    @required
    id: String
    @required
    prior: String
    @required
    priorEnd: String
    @required
    replacement: String
    @required
    reason: String
}

structure FulfillmentReplacementCreateInput {
    @required
    prior: String
    @required
    priorEnd: String
    @required
    replacement: String
    @required
    reason: String
}

structure FulfillmentReplacementPatchInput {
}

structure FulfillmentSetRecord {
    @required
    id: String
    @required
    label: String
}

structure FulfillmentSetCreateInput {
    @required
    label: String
}

structure FulfillmentSetPatchInput {
}

structure FulfillmentStartRecord {
    @required
    id: String
    @required
    fulfillment: String
    @required
    beganAt: String
    @required
    recordedBy: String
}

structure FulfillmentStartCreateInput {
    @required
    fulfillment: String
    @required
    beganAt: String
    @required
    recordedBy: String
}

structure FulfillmentStartPatchInput {
}

structure FulfillmentTaskLinkRecord {
    @required
    id: String
    @required
    fulfillment: String
    @required
    queue: String
    @required
    task: String
}

structure FulfillmentTaskLinkCreateInput {
    @required
    fulfillment: String
    @required
    queue: String
    @required
    task: String
}

structure FulfillmentTaskLinkPatchInput {
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

structure IntakeFormRecord {
    @required
    id: String
    @required
    definition: String
    @required
    label: String
    @required
    anonymousAllowed: Boolean
}

structure IntakeFormCreateInput {
    @required
    definition: String
    @required
    label: String
    @required
    anonymousAllowed: Boolean
}

structure IntakeFormPatchInput {
}

structure SubmissionRecord {
    @required
    id: String
    @required
    createdAt: String
    @required
    updatedAt: String
    @required
    form: String
    @required
    definition: String
    submitter: String
    @required
    sourceKey: String
    @required
    submittedAt: String
    raw: String
}

structure SubmissionCreateInput {
    @required
    form: String
    @required
    definition: String
    submitter: String
    @required
    sourceKey: String
    @required
    submittedAt: String
    raw: String
}

structure SubmissionPatchInput {
}

structure SubmissionValidationRecord {
    @required
    id: String
    @required
    submission: String
    @required
    run: String
    @required
    finish: String
    @required
    verdict: String
    @required
    reason: String
}

structure SubmissionValidationCreateInput {
    @required
    submission: String
    @required
    run: String
    @required
    finish: String
    @required
    verdict: String
    @required
    reason: String
}

structure SubmissionValidationPatchInput {
}

structure InventoryCountRecord {
    @required
    id: String
    @required
    position: String
    @required
    quantity: String
    @required
    at: String
    @required
    evidence: String
}

structure InventoryCountCreateInput {
    @required
    position: String
    @required
    quantity: String
    @required
    at: String
    @required
    evidence: String
}

structure InventoryCountPatchInput {
}

structure InventoryMovementRecord {
    @required
    id: String
    @required
    item: String
    @required
    ordinal: Long
    previous: String
    @required
    key: String
    @required
    kind: String
    @required
    at: String
    @required
    position: String
    destination: String
    @required
    quantity: String
    reservation: String
    count: String
    @required
    source: String
}

structure InventoryMovementCreateInput {
    @required
    item: String
    @required
    ordinal: Long
    previous: String
    @required
    key: String
    @required
    kind: String
    @required
    at: String
    @required
    position: String
    destination: String
    @required
    quantity: String
    reservation: String
    count: String
    @required
    source: String
}

structure InventoryMovementPatchInput {
}

structure InventoryPositionRecord {
    @required
    id: String
    @required
    item: String
    @required
    place: String
    @required
    custodian: String
    @required
    condition: String
    @required
    pool: String
    @required
    reorderPoint: String
}

structure InventoryPositionCreateInput {
    @required
    item: String
    @required
    place: String
    @required
    custodian: String
    @required
    condition: String
    @required
    pool: String
    @required
    reorderPoint: String
}

structure InventoryPositionPatchInput {
}

structure InventoryReorderRecord {
    @required
    id: String
    @required
    position: String
    @required
    demand: String
}

structure InventoryReorderCreateInput {
    @required
    position: String
    @required
    demand: String
}

structure InventoryReorderPatchInput {
}

structure InventoryReservationRecord {
    @required
    id: String
    @required
    position: String
    @required
    allocation: String
    demand: String
}

structure InventoryReservationCreateInput {
    @required
    position: String
    @required
    allocation: String
    demand: String
}

structure InventoryReservationPatchInput {
}

structure InventoryVisibilityRecord {
    @required
    id: String
    @required
    movement: String
    @required
    kind: String
    related: String
    transaction: String
    @required
    evidence: String
}

structure InventoryVisibilityCreateInput {
    @required
    movement: String
    @required
    kind: String
    related: String
    transaction: String
    @required
    evidence: String
}

structure InventoryVisibilityPatchInput {
}

structure StockItemRecord {
    @required
    id: String
    @required
    key: String
    @required
    specification: String
    @required
    identifiers: String
    @required
    kind: String
    serial: String
    lot: String
}

structure StockItemCreateInput {
    @required
    key: String
    @required
    specification: String
    @required
    identifiers: String
    @required
    kind: String
    serial: String
    lot: String
}

structure StockItemPatchInput {
}

structure StockItemSpecificationRecord {
    @required
    id: String
    @required
    key: String
    @required
    definition: String
    @required
    unit: String
}

structure StockItemSpecificationCreateInput {
    @required
    key: String
    @required
    definition: String
    @required
    unit: String
}

structure StockItemSpecificationPatchInput {
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

structure ParticipationRecord {
    @required
    id: String
    @required
    createdAt: String
    @required
    updatedAt: String
    @required
    participationSet: String
    @required
    participant: String
    @required
    role: String
    @required
    validFrom: String
    validUntil: String
    @required
    recordedBy: String
    @required
    reason: String
}

structure ParticipationCreateInput {
    @required
    participationSet: String
    @required
    participant: String
    @required
    role: String
    @required
    validFrom: String
    validUntil: String
    @required
    recordedBy: String
    @required
    reason: String
}

structure ParticipationPatchInput {
}

structure ParticipationEndRecord {
    @required
    id: String
    @required
    createdAt: String
    @required
    updatedAt: String
    @required
    participation: String
    @required
    effectiveAt: String
    @required
    revoked: Boolean
    @required
    recordedBy: String
    @required
    reason: String
}

structure ParticipationEndCreateInput {
    @required
    participation: String
    @required
    effectiveAt: String
    @required
    revoked: Boolean
    @required
    recordedBy: String
    @required
    reason: String
}

structure ParticipationEndPatchInput {
}

structure ParticipationRoleRecord {
    @required
    id: String
    @required
    createdAt: String
    @required
    updatedAt: String
    @required
    namespace: String
    @required
    name: String
}

structure ParticipationRoleCreateInput {
    @required
    namespace: String
    @required
    name: String
}

structure ParticipationRolePatchInput {
}

structure ParticipationSetRecord {
    @required
    id: String
    @required
    createdAt: String
    @required
    updatedAt: String
    @required
    label: String
}

structure ParticipationSetCreateInput {
    @required
    label: String
}

structure ParticipationSetPatchInput {
}

structure PartyRecord {
    @required
    id: String
    @required
    createdAt: String
    @required
    updatedAt: String
    @required
    label: String
    identifiers: String
}

structure PartyCreateInput {
    @required
    label: String
    identifiers: String
}

structure PartyPatchInput {
}

structure PrincipalRepresentationRecord {
    @required
    id: String
    @required
    createdAt: String
    @required
    updatedAt: String
    @required
    party: String
    @required
    principal: String
    @required
    validFrom: String
    validUntil: String
    @required
    recordedBy: String
    @required
    reason: String
}

structure PrincipalRepresentationCreateInput {
    @required
    party: String
    @required
    principal: String
    @required
    validFrom: String
    validUntil: String
    @required
    recordedBy: String
    @required
    reason: String
}

structure PrincipalRepresentationPatchInput {
}

structure RepresentationRevocationRecord {
    @required
    id: String
    @required
    createdAt: String
    @required
    updatedAt: String
    @required
    representation: String
    @required
    effectiveAt: String
    @required
    recordedBy: String
    @required
    reason: String
}

structure RepresentationRevocationCreateInput {
    @required
    representation: String
    @required
    effectiveAt: String
    @required
    recordedBy: String
    @required
    reason: String
}

structure RepresentationRevocationPatchInput {
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

structure PartySubjectRecord {
    @required
    id: String
    @required
    subject: String
    @required
    party: String
}

structure PartySubjectCreateInput {
    @required
    subject: String
    @required
    party: String
}

structure PartySubjectPatchInput {
}

structure QualificationRecord {
    @required
    id: String
    @required
    createdAt: String
    @required
    updatedAt: String
    @required
    subject: String
    @required
    definition: String
    level: String
    @required
    issuer: String
    @required
    issuerRecord: String
    @required
    issuedAt: String
    expiresAt: String
    support: String
    @required
    recordedBy: String
}

structure QualificationCreateInput {
    @required
    subject: String
    @required
    definition: String
    level: String
    @required
    issuer: String
    @required
    issuerRecord: String
    @required
    issuedAt: String
    expiresAt: String
    support: String
    @required
    recordedBy: String
}

structure QualificationPatchInput {
}

structure QualificationDefinitionRecord {
    @required
    id: String
    @required
    createdAt: String
    @required
    updatedAt: String
    @required
    key: String
    @required
    pin: String
    @required
    label: String
}

structure QualificationDefinitionCreateInput {
    @required
    key: String
    @required
    pin: String
    @required
    label: String
}

structure QualificationDefinitionPatchInput {
}

structure QualificationLevelRecord {
    @required
    id: String
    @required
    definition: String
    @required
    code: String
    @required
    rank: Long
}

structure QualificationLevelCreateInput {
    @required
    definition: String
    @required
    code: String
    @required
    rank: Long
}

structure QualificationLevelPatchInput {
}

structure QualificationRequirementRecord {
    @required
    id: String
    @required
    definition: String
    minimumLevel: String
}

structure QualificationRequirementCreateInput {
    @required
    definition: String
    minimumLevel: String
}

structure QualificationRequirementPatchInput {
}

structure QualificationRevocationRecord {
    @required
    id: String
    @required
    createdAt: String
    @required
    updatedAt: String
    @required
    qualification: String
    @required
    effectiveAt: String
    @required
    reason: String
    @required
    recordedBy: String
}

structure QualificationRevocationCreateInput {
    @required
    qualification: String
    @required
    effectiveAt: String
    @required
    reason: String
    @required
    recordedBy: String
}

structure QualificationRevocationPatchInput {
}

structure QualificationSubjectRecord {
    @required
    id: String
    @required
    createdAt: String
    @required
    updatedAt: String
    @required
    label: String
}

structure QualificationSubjectCreateInput {
    @required
    label: String
}

structure QualificationSubjectPatchInput {
}

structure PriceAdjustmentRecord {
    @required
    id: String
    @required
    key: String
    @required
    definition: String
    @required
    account: String
    @required
    amount: String
    @required
    reason: String
}

structure PriceAdjustmentCreateInput {
    @required
    key: String
    @required
    definition: String
    @required
    account: String
    @required
    amount: String
    @required
    reason: String
}

structure PriceAdjustmentPatchInput {
}

structure PricingRateRecord {
    @required
    id: String
    @required
    key: String
    @required
    definition: String
    @required
    account: String
    @required
    unitPrice: String
    @required
    validFrom: String
    @required
    validUntil: String
}

structure PricingRateCreateInput {
    @required
    key: String
    @required
    definition: String
    @required
    account: String
    @required
    unitPrice: String
    @required
    validFrom: String
    @required
    validUntil: String
}

structure PricingRatePatchInput {
}

structure QuoteRecord {
    @required
    id: String
    @required
    key: String
    @required
    offer: String
    @required
    buyer: String
    @required
    terms: String
    evaluation: String
    @required
    pricedAt: String
    @required
    expiresAt: String
    @required
    head: String
    previous: String
}

structure QuoteCreateInput {
    @required
    key: String
    @required
    offer: String
    @required
    buyer: String
    @required
    terms: String
    evaluation: String
    @required
    pricedAt: String
    @required
    expiresAt: String
    @required
    head: String
    previous: String
}

structure QuotePatchInput {
}

structure QuoteAgreementRecord {
    @required
    id: String
    @required
    quote: String
    @required
    acceptance: String
    @required
    agreement: String
}

structure QuoteAgreementCreateInput {
    @required
    quote: String
    @required
    acceptance: String
    @required
    agreement: String
}

structure QuoteAgreementPatchInput {
}

structure QuoteEndRecord {
    @required
    id: String
    @required
    createdAt: String
    @required
    updatedAt: String
    @required
    quote: String
    @required
    outcome: String
    successor: String
    intent: String
    acceptanceDigest: String
    @required
    reason: String
}

structure QuoteEndCreateInput {
    @required
    quote: String
    @required
    outcome: String
    successor: String
    intent: String
    acceptanceDigest: String
    @required
    reason: String
}

structure QuoteEndPatchInput {
}

structure QuoteLineRecord {
    @required
    id: String
    @required
    rate: String
    @required
    quantity: String
    adjustment: String
    next: String
}

structure QuoteLineCreateInput {
    @required
    rate: String
    @required
    quantity: String
    adjustment: String
    next: String
}

structure QuoteLinePatchInput {
}

structure PartyResourceRelationRecord {
    @required
    id: String
    @required
    createdAt: String
    @required
    updatedAt: String
    @required
    key: String
    @required
    subject: String
    @required
    party: String
    @required
    kind: String
    @required
    scope: String
    quantity: String
    unit: String
    @required
    validFrom: String
    validUntil: String
    previous: String
    @required
    depth: Long
}

structure PartyResourceRelationCreateInput {
    @required
    key: String
    @required
    subject: String
    @required
    party: String
    @required
    kind: String
    @required
    scope: String
    quantity: String
    unit: String
    @required
    validFrom: String
    validUntil: String
    previous: String
    @required
    depth: Long
}

structure PartyResourceRelationPatchInput {
}

structure RelationCommitRecord {
    @required
    id: String
    @required
    createdAt: String
    @required
    updatedAt: String
    @required
    key: String
    prior: String
    priorCommit: String
    current: String
    @required
    effectiveAt: String
    @required
    source: String
    @required
    recordedBy: String
    @required
    reason: String
}

structure RelationCommitCreateInput {
    @required
    key: String
    prior: String
    priorCommit: String
    current: String
    @required
    effectiveAt: String
    @required
    source: String
    @required
    recordedBy: String
    @required
    reason: String
}

structure RelationCommitPatchInput {
}

structure RelationKindRecord {
    @required
    id: String
    @required
    createdAt: String
    @required
    updatedAt: String
    @required
    namespace: String
    @required
    name: String
    @required
    definition: String
}

structure RelationKindCreateInput {
    @required
    namespace: String
    @required
    name: String
    @required
    definition: String
}

structure RelationKindPatchInput {
}

structure RelationScopeRecord {
    @required
    id: String
    @required
    createdAt: String
    @required
    updatedAt: String
    @required
    subject: String
    @required
    key: String
    @required
    label: String
}

structure RelationScopeCreateInput {
    @required
    subject: String
    @required
    key: String
    @required
    label: String
}

structure RelationScopePatchInput {
}

structure RelationSourceRecord {
    @required
    id: String
    @required
    createdAt: String
    @required
    updatedAt: String
    @required
    key: String
    @required
    source: String
    @required
    sourceRecord: String
    @required
    occurredAt: String
    @required
    evidence: String
    @required
    description: String
}

structure RelationSourceCreateInput {
    @required
    key: String
    @required
    source: String
    @required
    sourceRecord: String
    @required
    occurredAt: String
    @required
    evidence: String
    @required
    description: String
}

structure RelationSourcePatchInput {
}

structure ResourceSubjectRecord {
    @required
    id: String
    @required
    createdAt: String
    @required
    updatedAt: String
    @required
    key: String
    @required
    label: String
}

structure ResourceSubjectCreateInput {
    @required
    key: String
    @required
    label: String
}

structure ResourceSubjectPatchInput {
}

structure ReturnAuthorizationRecord {
    @required
    id: String
    @required
    origin: String
    @required
    request: String
    @required
    ordinal: Long
    previous: String
    @required
    at: String
}

structure ReturnAuthorizationCreateInput {
    @required
    origin: String
    @required
    request: String
    @required
    ordinal: Long
    previous: String
    @required
    at: String
}

structure ReturnAuthorizationPatchInput {
}

structure ReturnDispositionRecord {
    @required
    id: String
    @required
    receipt: String
    @required
    inspection: String
    @required
    support: String
    movement: String
    work: String
    @required
    at: String
}

structure ReturnDispositionCreateInput {
    @required
    receipt: String
    @required
    inspection: String
    @required
    support: String
    movement: String
    work: String
    @required
    at: String
}

structure ReturnDispositionPatchInput {
}

structure ReturnOriginRecord {
    @required
    id: String
    @required
    issue: String
    @required
    customer: String
    @required
    supplier: String
    agreement: String
    @required
    fulfillment: String
    @required
    entitlement: String
    @required
    right: String
    @required
    scope: String
}

structure ReturnOriginCreateInput {
    @required
    issue: String
    @required
    customer: String
    @required
    supplier: String
    agreement: String
    @required
    fulfillment: String
    @required
    entitlement: String
    @required
    right: String
    @required
    scope: String
}

structure ReturnOriginPatchInput {
}

structure ReturnReceiptRecord {
    @required
    id: String
    @required
    authorization: String
    @required
    movement: String
}

structure ReturnReceiptCreateInput {
    @required
    authorization: String
    @required
    movement: String
}

structure ReturnReceiptPatchInput {
}

structure ReturnRemedyRecord {
    @required
    id: String
    @required
    disposition: String
    replacement: String
    refund: String
    creditBill: String
    credit: String
    @required
    at: String
}

structure ReturnRemedyCreateInput {
    @required
    disposition: String
    replacement: String
    refund: String
    creditBill: String
    credit: String
    @required
    at: String
}

structure ReturnRemedyPatchInput {
}

structure ReturnRequestRecord {
    @required
    id: String
    @required
    key: String
    @required
    origin: String
    @required
    entitlement: String
    @required
    quantity: String
    @required
    reason: String
    @required
    requestedAt: String
    @required
    authorization: String
    @required
    authorizedOption: String
    @required
    inspection: String
    @required
    dispositionDecision: String
    @required
    dispositionOption: String
    @required
    disposition: String
    @required
    remedy: String
    @required
    amount: String
    @required
    unit: String
}

structure ReturnRequestCreateInput {
    @required
    key: String
    @required
    origin: String
    @required
    entitlement: String
    @required
    quantity: String
    @required
    reason: String
    @required
    requestedAt: String
    @required
    authorization: String
    @required
    authorizedOption: String
    @required
    inspection: String
    @required
    dispositionDecision: String
    @required
    dispositionOption: String
    @required
    disposition: String
    @required
    remedy: String
    @required
    amount: String
    @required
    unit: String
}

structure ReturnRequestPatchInput {
}

structure AssignmentRecord {
    @required
    id: String
    @required
    request: String
    @required
    offer: String
    @required
    reservation: String
    @required
    acceptedAt: String
}

structure AssignmentCreateInput {
    @required
    request: String
    @required
    offer: String
    @required
    reservation: String
    @required
    acceptedAt: String
}

structure AssignmentPatchInput {
}

structure AssignmentEndRecord {
    @required
    id: String
    @required
    assignment: String
    @required
    reason: String
    @required
    at: String
}

structure AssignmentEndCreateInput {
    @required
    assignment: String
    @required
    reason: String
    @required
    at: String
}

structure AssignmentEndPatchInput {
}

structure AssignmentExecutionRecord {
    @required
    id: String
    @required
    assignment: String
    @required
    fulfillment: String
}

structure AssignmentExecutionCreateInput {
    @required
    assignment: String
    @required
    fulfillment: String
}

structure AssignmentExecutionPatchInput {
}

structure AssignmentOfferRecord {
    @required
    id: String
    @required
    candidate: String
    @required
    offeredAt: String
    @required
    expiresAt: String
}

structure AssignmentOfferCreateInput {
    @required
    candidate: String
    @required
    offeredAt: String
    @required
    expiresAt: String
}

structure AssignmentOfferPatchInput {
}

structure AssignmentOfferEndRecord {
    @required
    id: String
    @required
    offer: String
    @required
    outcome: String
    @required
    at: String
    @required
    reason: String
}

structure AssignmentOfferEndCreateInput {
    @required
    offer: String
    @required
    outcome: String
    @required
    at: String
    @required
    reason: String
}

structure AssignmentOfferEndPatchInput {
}

structure RoutingCandidateRecord {
    @required
    id: String
    @required
    request: String
    @required
    resource: String
    @required
    qualification: String
    participant: String
    @required
    evaluatedAt: String
    @required
    rank: Long
    @required
    rationale: String
}

structure RoutingCandidateCreateInput {
    @required
    request: String
    @required
    resource: String
    @required
    qualification: String
    participant: String
    @required
    evaluatedAt: String
    @required
    rank: Long
    @required
    rationale: String
}

structure RoutingCandidatePatchInput {
}

structure RoutingRequestRecord {
    @required
    id: String
    @required
    key: String
    @required
    requirement: String
    @required
    participants: String
    @required
    fulfillment: String
    @required
    from: String
    @required
    until: String
    @required
    quantity: String
    @required
    unit: String
}

structure RoutingRequestCreateInput {
    @required
    key: String
    @required
    requirement: String
    @required
    participants: String
    @required
    fulfillment: String
    @required
    from: String
    @required
    until: String
    @required
    quantity: String
    @required
    unit: String
}

structure RoutingRequestPatchInput {
}

structure RoutingResourceRecord {
    @required
    id: String
    @required
    key: String
    @required
    subject: String
    party: String
    @required
    executor: String
    @required
    pool: String
    @required
    calendar: String
}

structure RoutingResourceCreateInput {
    @required
    key: String
    @required
    subject: String
    party: String
    @required
    executor: String
    @required
    pool: String
    @required
    calendar: String
}

structure RoutingResourcePatchInput {
}

structure AppointmentRecord {
    @required
    id: String
    @required
    key: String
    @required
    slot: String
    @required
    fulfillment: String
    predecessor: String
}

structure AppointmentCreateInput {
    @required
    key: String
    @required
    slot: String
    @required
    fulfillment: String
    predecessor: String
}

structure AppointmentPatchInput {
}

structure AppointmentCommitRecord {
    @required
    id: String
    @required
    appointment: String
    @required
    head: String
}

structure AppointmentCommitCreateInput {
    @required
    appointment: String
    @required
    head: String
}

structure AppointmentCommitPatchInput {
}

structure AppointmentEndRecord {
    @required
    id: String
    @required
    appointment: String
    replacement: String
    @required
    reason: String
}

structure AppointmentEndCreateInput {
    @required
    appointment: String
    replacement: String
    @required
    reason: String
}

structure AppointmentEndPatchInput {
}

structure AppointmentReservationRecord {
    @required
    id: String
    @required
    appointment: String
    @required
    reservation: String
    next: String
}

structure AppointmentReservationCreateInput {
    @required
    appointment: String
    @required
    reservation: String
    next: String
}

structure AppointmentReservationPatchInput {
}

structure CandidateSlotRecord {
    @required
    id: String
    @required
    requirement: String
    @required
    from: String
    @required
    until: String
}

structure CandidateSlotCreateInput {
    @required
    requirement: String
    @required
    from: String
    @required
    until: String
}

structure CandidateSlotPatchInput {
}

structure SchedulingNeedRecord {
    @required
    id: String
    @required
    pool: String
    @required
    calendar: String
    @required
    quantity: String
    participant: String
    next: String
}

structure SchedulingNeedCreateInput {
    @required
    pool: String
    @required
    calendar: String
    @required
    quantity: String
    participant: String
    next: String
}

structure SchedulingNeedPatchInput {
}

structure SchedulingRequirementRecord {
    @required
    id: String
    @required
    key: String
    @required
    durationMinutes: Long
    @required
    participants: String
    @required
    place: String
    @required
    head: String
}

structure SchedulingRequirementCreateInput {
    @required
    key: String
    @required
    durationMinutes: Long
    @required
    participants: String
    @required
    place: String
    @required
    head: String
}

structure SchedulingRequirementPatchInput {
}

structure SettlementBookRecord {
    @required
    id: String
    @required
    key: String
}

structure SettlementBookCreateInput {
    @required
    key: String
}

structure SettlementBookPatchInput {
}

structure SettlementCommitRecord {
    @required
    id: String
    @required
    createdAt: String
    @required
    updatedAt: String
    @required
    book: String
    @required
    ordinal: Long
    previous: String
    @required
    event: String
    source: String
    @required
    key: String
}

structure SettlementCommitCreateInput {
    @required
    book: String
    @required
    ordinal: Long
    previous: String
    @required
    event: String
    source: String
    @required
    key: String
}

structure SettlementCommitPatchInput {
}

structure SettlementEventRecord {
    @required
    id: String
    @required
    book: String
    @required
    key: String
    @required
    kind: String
    @required
    head: String
    source: String
    @required
    occurredAt: String
    @required
    effectiveAt: String
    reversalOf: String
    @required
    reason: String
}

structure SettlementEventCreateInput {
    @required
    book: String
    @required
    key: String
    @required
    kind: String
    @required
    head: String
    source: String
    @required
    occurredAt: String
    @required
    effectiveAt: String
    reversalOf: String
    @required
    reason: String
}

structure SettlementEventPatchInput {
}

structure SettlementLedgerLinkRecord {
    @required
    id: String
    @required
    createdAt: String
    @required
    updatedAt: String
    @required
    publication: String
    @required
    posting: String
    @required
    reason: String
}

structure SettlementLedgerLinkCreateInput {
    @required
    publication: String
    @required
    posting: String
    @required
    reason: String
}

structure SettlementLedgerLinkPatchInput {
}

structure SettlementLineRecord {
    @required
    id: String
    @required
    book: String
    @required
    position: String
    @required
    quantity: String
    next: String
}

structure SettlementLineCreateInput {
    @required
    book: String
    @required
    position: String
    @required
    quantity: String
    next: String
}

structure SettlementLinePatchInput {
}

structure SettlementPositionRecord {
    @required
    id: String
    @required
    createdAt: String
    @required
    updatedAt: String
    @required
    book: String
    @required
    obligation: String
    @required
    creditor: String
    @required
    debtor: String
    agreement: String
    @required
    unit: String
    @required
    ceiling: String
    dueAt: String
    @required
    reason: String
}

structure SettlementPositionCreateInput {
    @required
    book: String
    @required
    obligation: String
    @required
    creditor: String
    @required
    debtor: String
    agreement: String
    @required
    unit: String
    @required
    ceiling: String
    dueAt: String
    @required
    reason: String
}

structure SettlementPositionPatchInput {
}

structure SettlementSourceRecord {
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
    kind: String
    @required
    unit: String
    @required
    quantity: String
    @required
    occurredAt: String
    @required
    fulfillmentEnd: String
    @required
    reason: String
}

structure SettlementSourceCreateInput {
    @required
    book: String
    @required
    key: String
    @required
    kind: String
    @required
    unit: String
    @required
    quantity: String
    @required
    occurredAt: String
    @required
    fulfillmentEnd: String
    @required
    reason: String
}

structure SettlementSourcePatchInput {
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

