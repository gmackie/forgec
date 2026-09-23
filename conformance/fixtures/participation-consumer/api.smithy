$version: "2.0"

namespace foundation.probe.participation.consumers

@error("client")
structure Problem {
    @required
    code: String
    @required
    title: String
    detail: String
}

structure ParticipantRecord {
    @required
    id: String
    @required
    createdAt: String
    @required
    updatedAt: String
    @required
    label: String
}

structure ParticipantCreateInput {
    @required
    label: String
}

structure ParticipantPatchInput {
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

structure ClassroomRecord {
    @required
    id: String
    @required
    version: Long
    @required
    enrollment: String
}

structure ClassroomCreateInput {
    @required
    enrollment: String
}

structure ClassroomPatchInput {
}

structure OrganizationParticipantRecord {
    @required
    id: String
    @required
    organizationCode: String
    @required
    participant: String
}

structure OrganizationParticipantCreateInput {
    @required
    organizationCode: String
    @required
    participant: String
}

structure OrganizationParticipantPatchInput {
}

structure PrincipalParticipantRecord {
    @required
    id: String
    @required
    principal: String
    @required
    participant: String
}

structure PrincipalParticipantCreateInput {
    @required
    principal: String
    @required
    participant: String
}

structure PrincipalParticipantPatchInput {
}

structure ReviewBoardRecord {
    @required
    id: String
    @required
    version: Long
    @required
    reviewers: String
}

structure ReviewBoardCreateInput {
    @required
    reviewers: String
}

structure ReviewBoardPatchInput {
}

structure TeamRecord {
    @required
    id: String
    @required
    version: Long
    @required
    members: String
}

structure TeamCreateInput {
    @required
    members: String
}

structure TeamPatchInput {
}

