$version: "2.0"

namespace fixture.campaign.consumer

@error("client")
structure Problem {
    @required
    code: String
    @required
    title: String
    detail: String
}

structure MarketingCampaignRecord {
    @required
    id: String
    @required
    campaign: String
    @required
    purpose: String
}

structure MarketingCampaignCreateInput {
    @required
    campaign: String
    @required
    purpose: String
}

structure MarketingCampaignPatchInput {
}

structure PublicHealthCampaignRecord {
    @required
    id: String
    @required
    campaign: String
    @required
    purpose: String
}

structure PublicHealthCampaignCreateInput {
    @required
    campaign: String
    @required
    purpose: String
}

structure PublicHealthCampaignPatchInput {
}

structure RecruitingCampaignRecord {
    @required
    id: String
    @required
    campaign: String
    @required
    purpose: String
}

structure RecruitingCampaignCreateInput {
    @required
    campaign: String
    @required
    purpose: String
}

structure RecruitingCampaignPatchInput {
}

structure SecurityAwarenessCampaignRecord {
    @required
    id: String
    @required
    campaign: String
    @required
    purpose: String
}

structure SecurityAwarenessCampaignCreateInput {
    @required
    campaign: String
    @required
    purpose: String
}

structure SecurityAwarenessCampaignPatchInput {
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

structure CampaignRecord {
    @required
    id: String
    @required
    key: String
    @required
    audience: String
    @required
    objective: String
    @required
    plan: String
    budget: String
    content: String
    offer: String
    @required
    channel: String
    @required
    metricSubject: String
    @required
    from: String
    @required
    until: String
}

structure CampaignCreateInput {
    @required
    key: String
    @required
    audience: String
    @required
    objective: String
    @required
    plan: String
    budget: String
    content: String
    offer: String
    @required
    channel: String
    @required
    metricSubject: String
    @required
    from: String
    @required
    until: String
}

structure CampaignPatchInput {
}

structure CampaignAudienceRecord {
    @required
    id: String
    @required
    key: String
    @required
    selector: String
    @required
    topic: String
}

structure CampaignAudienceCreateInput {
    @required
    key: String
    @required
    selector: String
    @required
    topic: String
}

structure CampaignAudiencePatchInput {
}

structure CampaignEventRecord {
    @required
    id: String
    @required
    campaign: String
    @required
    ordinal: Long
    previous: String
    @required
    kind: String
    @required
    phase: String
    wave: String
    @required
    at: String
}

structure CampaignEventCreateInput {
    @required
    campaign: String
    @required
    ordinal: Long
    previous: String
    @required
    kind: String
    @required
    phase: String
    wave: String
    @required
    at: String
}

structure CampaignEventPatchInput {
}

structure CampaignMemberRecord {
    @required
    id: String
    @required
    wave: String
    @required
    ordinal: Long
    @required
    notification: String
    @required
    route: String
}

structure CampaignMemberCreateInput {
    @required
    wave: String
    @required
    ordinal: Long
    @required
    notification: String
    @required
    route: String
}

structure CampaignMemberPatchInput {
}

structure CampaignPerformanceRecord {
    @required
    id: String
    @required
    campaign: String
    @required
    assessment: String
    @required
    objective: String
}

structure CampaignPerformanceCreateInput {
    @required
    campaign: String
    @required
    assessment: String
    @required
    objective: String
}

structure CampaignPerformancePatchInput {
}

structure CampaignResponseRecord {
    @required
    id: String
    @required
    member: String
    @required
    interaction: String
    @required
    attribution: String
    @required
    kind: String
}

structure CampaignResponseCreateInput {
    @required
    member: String
    @required
    interaction: String
    @required
    attribution: String
    @required
    kind: String
}

structure CampaignResponsePatchInput {
}

structure CampaignRouteRecord {
    @required
    id: String
    @required
    endpoint: String
    @required
    channel: String
    @required
    from: String
    @required
    until: String
    @required
    support: String
}

structure CampaignRouteCreateInput {
    @required
    endpoint: String
    @required
    channel: String
    @required
    from: String
    @required
    until: String
    @required
    support: String
}

structure CampaignRoutePatchInput {
}

structure CampaignRouteEndRecord {
    @required
    id: String
    @required
    route: String
    @required
    at: String
    @required
    reason: String
}

structure CampaignRouteEndCreateInput {
    @required
    route: String
    @required
    at: String
    @required
    reason: String
}

structure CampaignRouteEndPatchInput {
}

structure CampaignWaveRecord {
    @required
    id: String
    @required
    campaign: String
    @required
    key: String
    @required
    from: String
    @required
    until: String
    appointment: String
    @required
    memberCount: Long
}

structure CampaignWaveCreateInput {
    @required
    campaign: String
    @required
    key: String
    @required
    from: String
    @required
    until: String
    appointment: String
    @required
    memberCount: Long
}

structure CampaignWavePatchInput {
}

structure ClassificationAssignmentRecord {
    @required
    id: String
    @required
    classifications: String
    @required
    meaning: String
    @required
    recordedAt: String
}

structure ClassificationAssignmentCreateInput {
    @required
    classifications: String
    @required
    meaning: String
    @required
    recordedAt: String
}

structure ClassificationAssignmentPatchInput {
}

structure ClassificationRetractionRecord {
    @required
    id: String
    @required
    assignment: String
    @required
    effectiveAt: String
    @required
    reason: String
}

structure ClassificationRetractionCreateInput {
    @required
    assignment: String
    @required
    effectiveAt: String
    @required
    reason: String
}

structure ClassificationRetractionPatchInput {
}

structure ClassificationSetRecord {
    @required
    id: String
    @required
    label: String
}

structure ClassificationSetCreateInput {
    @required
    label: String
}

structure ClassificationSetPatchInput {
}

structure ConceptRecord {
    @required
    id: String
    @required
    version: Long
    parent: String
    @required
    taxonomy: String
    @required
    ordinal: Long
    @required
    identifiers: String
}

structure ConceptCreateInput {
    @required
    taxonomy: String
    @required
    ordinal: Long
    @required
    identifiers: String
}

structure ConceptPatchInput {
}

structure ConceptAliasRecord {
    @required
    id: String
    @required
    taxonomy: String
    @required
    alias: String
    @required
    meaning: String
}

structure ConceptAliasCreateInput {
    @required
    taxonomy: String
    @required
    alias: String
    @required
    meaning: String
}

structure ConceptAliasPatchInput {
}

structure ConceptDispositionRecord {
    @required
    id: String
    @required
    concept: String
    replacement: String
    @required
    effectiveAt: String
    @required
    reason: String
}

structure ConceptDispositionCreateInput {
    @required
    concept: String
    replacement: String
    @required
    effectiveAt: String
    @required
    reason: String
}

structure ConceptDispositionPatchInput {
}

structure ConceptRevisionRecord {
    @required
    id: String
    @required
    concept: String
    @required
    taxonomy: String
    @required
    ordinal: Long
    @required
    revision: Long
    previous: String
    parentMeaning: String
    @required
    label: String
    @required
    definition: String
}

structure ConceptRevisionCreateInput {
    @required
    concept: String
    @required
    taxonomy: String
    @required
    ordinal: Long
    @required
    revision: Long
    previous: String
    parentMeaning: String
    @required
    label: String
    @required
    definition: String
}

structure ConceptRevisionPatchInput {
}

structure TaxonomyRecord {
    @required
    id: String
    @required
    key: String
    @required
    identifiers: String
}

structure TaxonomyCreateInput {
    @required
    key: String
    @required
    identifiers: String
}

structure TaxonomyPatchInput {
}

structure AttachmentLinkRecord {
    @required
    id: String
    @required
    thread: String
    @required
    entry: String
    @required
    revision: String
}

structure AttachmentLinkCreateInput {
    @required
    thread: String
    @required
    entry: String
    @required
    revision: String
}

structure AttachmentLinkPatchInput {
}

structure MentionRecord {
    @required
    id: String
    @required
    thread: String
    @required
    entry: String
    @required
    participant: String
}

structure MentionCreateInput {
    @required
    thread: String
    @required
    entry: String
    @required
    participant: String
}

structure MentionPatchInput {
}

structure ReactionRecord {
    @required
    id: String
    @required
    thread: String
    @required
    entry: String
    @required
    author: String
    @required
    code: String
}

structure ReactionCreateInput {
    @required
    thread: String
    @required
    entry: String
    @required
    author: String
    @required
    code: String
}

structure ReactionPatchInput {
}

structure ThreadRecord {
    @required
    id: String
    @required
    participants: String
    @required
    title: String
}

structure ThreadCreateInput {
    @required
    participants: String
    @required
    title: String
}

structure ThreadPatchInput {
}

structure ThreadEntryRecord {
    @required
    id: String
    @required
    thread: String
    @required
    author: String
    @required
    body: String
    corrects: String
    @required
    recordedAt: String
}

structure ThreadEntryCreateInput {
    @required
    thread: String
    @required
    author: String
    @required
    body: String
    corrects: String
    @required
    recordedAt: String
}

structure ThreadEntryPatchInput {
}

structure ThreadEventRecord {
    @required
    id: String
    @required
    thread: String
    @required
    sequence: Long
    previous: String
    @required
    kind: String
    @required
    actor: String
    @required
    at: String
    @required
    closed: Boolean
    entry: String
    reaction: String
    mention: String
    attachment: String
}

structure ThreadEventCreateInput {
    @required
    thread: String
    @required
    sequence: Long
    previous: String
    @required
    kind: String
    @required
    actor: String
    @required
    at: String
    @required
    closed: Boolean
    entry: String
    reaction: String
    mention: String
    attachment: String
}

structure ThreadEventPatchInput {
}

structure ThreadParticipantRecord {
    @required
    id: String
    @required
    thread: String
    @required
    membership: String
}

structure ThreadParticipantCreateInput {
    @required
    thread: String
    @required
    membership: String
}

structure ThreadParticipantPatchInput {
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

structure DeliveryAttemptRecord {
    @required
    id: String
    @required
    createdAt: String
    @required
    updatedAt: String
    @required
    step: String
    @required
    startedAt: String
    @required
    provider: String
    @required
    providerKey: String
}

structure DeliveryAttemptCreateInput {
    @required
    step: String
    @required
    startedAt: String
    @required
    provider: String
    @required
    providerKey: String
}

structure DeliveryAttemptPatchInput {
}

structure DeliveryDestinationRecord {
    @required
    id: String
    @required
    key: String
    @required
    label: String
}

structure DeliveryDestinationCreateInput {
    @required
    key: String
    @required
    label: String
}

structure DeliveryDestinationPatchInput {
}

structure DeliveryIntentRecord {
    @required
    id: String
    @required
    createdAt: String
    @required
    updatedAt: String
    @required
    key: String
    @required
    destination: String
    payload: String
    @required
    maxAttempts: Long
}

structure DeliveryIntentCreateInput {
    @required
    key: String
    @required
    destination: String
    payload: String
    @required
    maxAttempts: Long
}

structure DeliveryIntentPatchInput {
}

structure DeliveryReceiptRecord {
    @required
    id: String
    @required
    createdAt: String
    @required
    updatedAt: String
    @required
    step: String
    @required
    attempt: String
    @required
    outcome: String
    @required
    completedAt: String
    @required
    providerReference: String
    @required
    callbackKey: String
    @required
    detail: String
    support: String
}

structure DeliveryReceiptCreateInput {
    @required
    step: String
    @required
    attempt: String
    @required
    outcome: String
    @required
    completedAt: String
    @required
    providerReference: String
    @required
    callbackKey: String
    @required
    detail: String
    support: String
}

structure DeliveryReceiptPatchInput {
}

structure DeliveryResolutionRecord {
    @required
    id: String
    @required
    createdAt: String
    @required
    updatedAt: String
    @required
    receipt: String
    @required
    outcome: String
    @required
    resolvedAt: String
    @required
    detail: String
    support: String
}

structure DeliveryResolutionCreateInput {
    @required
    receipt: String
    @required
    outcome: String
    @required
    resolvedAt: String
    @required
    detail: String
    support: String
}

structure DeliveryResolutionPatchInput {
}

structure DeliveryStepRecord {
    @required
    id: String
    @required
    createdAt: String
    @required
    updatedAt: String
    @required
    intent: String
    @required
    number: Long
    @required
    choice: String
    previous: String
    receipt: String
    resolution: String
    @required
    reason: String
}

structure DeliveryStepCreateInput {
    @required
    intent: String
    @required
    number: Long
    @required
    choice: String
    previous: String
    receipt: String
    resolution: String
    @required
    reason: String
}

structure DeliveryStepPatchInput {
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

structure MetricBreachEffectRecord {
    @required
    id: String
    @required
    breach: String
    @required
    fulfillment: String
}

structure MetricBreachEffectCreateInput {
    @required
    breach: String
    @required
    fulfillment: String
}

structure MetricBreachEffectPatchInput {
}

structure MetricBreachEventRecord {
    @required
    id: String
    @required
    assessment: String
    @required
    occurredAt: String
}

structure MetricBreachEventCreateInput {
    @required
    assessment: String
    @required
    occurredAt: String
}

structure MetricBreachEventPatchInput {
}

structure MetricDefinitionRecord {
    @required
    id: String
    @required
    key: String
    @required
    definition: String
    @required
    dimension: String
    @required
    unit: String
    @required
    semantics: String
}

structure MetricDefinitionCreateInput {
    @required
    key: String
    @required
    definition: String
    @required
    dimension: String
    @required
    unit: String
    @required
    semantics: String
}

structure MetricDefinitionPatchInput {
}

structure MetricObjectiveRecord {
    @required
    id: String
    @required
    key: String
    @required
    metric: String
    @required
    subject: String
    @required
    policy: String
    @required
    target: String
    minimum: String
    maximum: String
    @required
    from: String
    @required
    until: String
}

structure MetricObjectiveCreateInput {
    @required
    key: String
    @required
    metric: String
    @required
    subject: String
    @required
    policy: String
    @required
    target: String
    minimum: String
    maximum: String
    @required
    from: String
    @required
    until: String
}

structure MetricObjectivePatchInput {
}

structure MetricObservationRecord {
    @required
    id: String
    @required
    key: String
    @required
    metric: String
    @required
    subject: String
    @required
    unit: String
    @required
    value: String
    observedAt: String
    from: String
    until: String
    @required
    source: String
    @required
    sourceRecord: String
    support: String
    @required
    operation: String
    left: String
    right: String
    @required
    depth: Long
}

structure MetricObservationCreateInput {
    @required
    key: String
    @required
    metric: String
    @required
    subject: String
    @required
    unit: String
    @required
    value: String
    observedAt: String
    from: String
    until: String
    @required
    source: String
    @required
    sourceRecord: String
    support: String
    @required
    operation: String
    left: String
    right: String
    @required
    depth: Long
}

structure MetricObservationPatchInput {
}

structure MetricSubjectRecord {
    @required
    id: String
    @required
    key: String
}

structure MetricSubjectCreateInput {
    @required
    key: String
}

structure MetricSubjectPatchInput {
}

structure PerformanceAssessmentRecord {
    @required
    id: String
    @required
    objective: String
    @required
    observation: String
    evaluation: String
}

structure PerformanceAssessmentCreateInput {
    @required
    objective: String
    @required
    observation: String
    evaluation: String
}

structure PerformanceAssessmentPatchInput {
}

structure NotificationRecord {
    @required
    id: String
    @required
    key: String
    @required
    subscription: String
    @required
    preference: String
    content: String
    template: String
    @required
    at: String
}

structure NotificationCreateInput {
    @required
    key: String
    @required
    subscription: String
    @required
    preference: String
    content: String
    template: String
    @required
    at: String
}

structure NotificationPatchInput {
}

structure NotificationDeliveryLinkRecord {
    @required
    id: String
    @required
    notification: String
    @required
    preference: String
    @required
    endpoint: String
    @required
    subscription: String
    @required
    intent: String
}

structure NotificationDeliveryLinkCreateInput {
    @required
    notification: String
    @required
    preference: String
    @required
    endpoint: String
    @required
    subscription: String
    @required
    intent: String
}

structure NotificationDeliveryLinkPatchInput {
}

structure NotificationEndpointLinkRecord {
    @required
    id: String
    @required
    recipient: String
    @required
    destination: String
}

structure NotificationEndpointLinkCreateInput {
    @required
    recipient: String
    @required
    destination: String
}

structure NotificationEndpointLinkPatchInput {
}

structure NotificationPreferenceRecord {
    @required
    id: String
    @required
    subscription: String
    @required
    revision: Long
    previous: String
    @required
    enabled: Boolean
    @required
    reason: String
}

structure NotificationPreferenceCreateInput {
    @required
    subscription: String
    @required
    revision: Long
    previous: String
    @required
    enabled: Boolean
    @required
    reason: String
}

structure NotificationPreferencePatchInput {
}

structure NotificationSubscriptionRecord {
    @required
    id: String
    @required
    topic: String
    @required
    recipient: String
    @required
    endpoint: String
}

structure NotificationSubscriptionCreateInput {
    @required
    topic: String
    @required
    recipient: String
    @required
    endpoint: String
}

structure NotificationSubscriptionPatchInput {
}

structure NotificationSuppressionRecord {
    @required
    id: String
    @required
    notification: String
    @required
    preference: String
    @required
    reason: String
}

structure NotificationSuppressionCreateInput {
    @required
    notification: String
    @required
    preference: String
    @required
    reason: String
}

structure NotificationSuppressionPatchInput {
}

structure NotificationTopicRecord {
    @required
    id: String
    @required
    key: String
    @required
    label: String
}

structure NotificationTopicCreateInput {
    @required
    key: String
    @required
    label: String
}

structure NotificationTopicPatchInput {
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

structure BudgetActualRecord {
    @required
    id: String
    @required
    encumbrance: String
    @required
    amount: String
    @required
    posting: String
    @required
    account: String
    usage: String
    fulfillment: String
}

structure BudgetActualCreateInput {
    @required
    encumbrance: String
    @required
    amount: String
    @required
    posting: String
    @required
    account: String
    usage: String
    fulfillment: String
}

structure BudgetActualPatchInput {
}

structure BudgetEventRecord {
    @required
    id: String
    @required
    envelope: String
    @required
    encumbrance: String
    @required
    ordinal: Long
    previous: String
    @required
    action: String
    actual: String
    reversal: String
}

structure BudgetEventCreateInput {
    @required
    envelope: String
    @required
    encumbrance: String
    @required
    ordinal: Long
    previous: String
    @required
    action: String
    actual: String
    reversal: String
}

structure BudgetEventPatchInput {
}

structure EncumbranceRecord {
    @required
    id: String
    @required
    envelope: String
    @required
    key: String
    @required
    amount: String
    reservation: String
}

structure EncumbranceCreateInput {
    @required
    envelope: String
    @required
    key: String
    @required
    amount: String
    reservation: String
}

structure EncumbrancePatchInput {
}

structure ForecastScenarioRecord {
    @required
    id: String
    @required
    plan: String
    @required
    revision: Long
    previous: String
    @required
    assumptions: String
    @required
    label: String
}

structure ForecastScenarioCreateInput {
    @required
    plan: String
    @required
    revision: Long
    previous: String
    @required
    assumptions: String
    @required
    label: String
}

structure ForecastScenarioPatchInput {
}

structure ForecastValueRecord {
    @required
    id: String
    @required
    scenario: String
    @required
    goal: String
    @required
    quantity: String
}

structure ForecastValueCreateInput {
    @required
    scenario: String
    @required
    goal: String
    @required
    quantity: String
}

structure ForecastValuePatchInput {
}

structure FundingEnvelopeRecord {
    @required
    id: String
    @required
    plan: String
    @required
    account: String
    @required
    limit: String
    @required
    unit: String
}

structure FundingEnvelopeCreateInput {
    @required
    plan: String
    @required
    account: String
    @required
    limit: String
    @required
    unit: String
}

structure FundingEnvelopePatchInput {
}

structure GoalRecord {
    @required
    id: String
    @required
    plan: String
    @required
    metric: String
    @required
    unit: String
    @required
    target: String
}

structure GoalCreateInput {
    @required
    plan: String
    @required
    metric: String
    @required
    unit: String
    @required
    target: String
}

structure GoalPatchInput {
}

structure MilestoneRecord {
    @required
    id: String
    @required
    plan: String
    @required
    goal: String
    @required
    dueAt: String
    @required
    fulfillmentSet: String
}

structure MilestoneCreateInput {
    @required
    plan: String
    @required
    goal: String
    @required
    dueAt: String
    @required
    fulfillmentSet: String
}

structure MilestonePatchInput {
}

structure MilestoneEvaluationRecord {
    @required
    id: String
    @required
    milestone: String
    @required
    finish: String
}

structure MilestoneEvaluationCreateInput {
    @required
    milestone: String
    @required
    finish: String
}

structure MilestoneEvaluationPatchInput {
}

structure PlanRecord {
    @required
    id: String
    @required
    definition: String
    @required
    label: String
    classification: String
}

structure PlanCreateInput {
    @required
    definition: String
    @required
    label: String
    classification: String
}

structure PlanPatchInput {
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

