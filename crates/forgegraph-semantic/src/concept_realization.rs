//! Provider-independent validation of normalized observed engagement records.
//! Callers supply resolved IDs and epoch-millisecond bounds; this checks the supplied
//! snapshot, not completeness of storage, authority, or future runtime enforcement.
use crate::concept::{ConceptIR, Type, Violation};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EngagementRecord {
    pub id: String,
    pub interaction: String,
    pub started_at: i64,
    pub ended_at: Option<i64>,
    pub parent: Option<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EngagementMember {
    pub id: String,
    /// Occurrence Fact or Process declaration ID.
    pub declaration: String,
    pub engagement: String,
}
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EngagementSnapshot {
    pub engagements: Vec<EngagementRecord>,
    pub events: Vec<EngagementMember>,
    pub processes: Vec<EngagementMember>,
}
impl ConceptIR {
    /// Validate a complete observed snapshot against the authored interaction contract.
    /// Passing is evidence about these records only, not a provider certification.
    pub fn check_engagement_snapshot(&self, snapshot: &EngagementSnapshot) -> Vec<Violation> {
        let mut errors = self.validate_closed();
        let mut fail = |id: &str, message: &str| {
            errors.push(Violation {
                code: "E-L0-ENGAGEMENT".into(),
                subject: id.into(),
                message: message.into(),
            })
        };
        let mut records = BTreeMap::new();
        for record in &snapshot.engagements {
            if record.id.trim().is_empty() || records.insert(&record.id, record).is_some() {
                fail(
                    &record.id,
                    "engagement identity must be nonempty and unique",
                );
            }
            if !self
                .semantics
                .interactions
                .contains_key(&record.interaction)
            {
                fail(&record.id, "unknown interaction declaration");
            }
            if record.ended_at.is_none()
                && self
                    .semantics
                    .interactions
                    .get(&record.interaction)
                    .and_then(|i| {
                        let temporal = self.semantics.temporal.get(&i.carrier)?;
                        self.entities
                            .get(&i.carrier)?
                            .fields
                            .get(temporal.valid.as_ref()?.to.as_ref()?)
                    })
                    .is_some_and(|field| !field.ty.optional)
            {
                fail(&record.id, "required engagement end is missing");
            }
            if record.ended_at.is_some_and(|end| end < record.started_at) {
                fail(&record.id, "engagement ends before it starts");
            }
        }
        for record in &snapshot.engagements {
            if let Some(parent_id) = &record.parent {
                match records.get(parent_id) {
                    None => fail(&record.id, "parent engagement is absent from the snapshot"),
                    Some(parent) => {
                        let parent_type = self
                            .semantics
                            .interactions
                            .get(&parent.interaction)
                            .map(|i| &i.carrier);
                        let field = self
                            .semantics
                            .interactions
                            .get(&record.interaction)
                            .and_then(|i| {
                                self.entities
                                    .get(&i.carrier)?
                                    .fields
                                    .get(i.parent.as_ref()?)
                            });
                        if !field.is_some_and(|f| matches!(&f.ty.base, Type::Entity {id, ..} if Some(id) == parent_type)) { fail(&record.id, "parent engagement does not match the declared parent type"); }
                    }
                }
            } else if self
                .semantics
                .interactions
                .get(&record.interaction)
                .and_then(|i| {
                    self.entities
                        .get(&i.carrier)?
                        .fields
                        .get(i.parent.as_ref()?)
                })
                .is_some_and(|f| !f.ty.optional)
            {
                fail(&record.id, "required parent engagement is missing");
            }
            let mut visited = BTreeSet::new();
            let mut cursor = Some(record);
            while let Some(current) = cursor {
                if !visited.insert(&current.id) {
                    fail(&record.id, "parent engagement cycle");
                    break;
                }
                cursor = current
                    .parent
                    .as_ref()
                    .and_then(|id| records.get(id).copied());
            }
        }
        for (members, is_event) in [(&snapshot.events, true), (&snapshot.processes, false)] {
            let mut identities = BTreeSet::new();
            for member in members {
                // One process execution may span several engagements. Events may also
                // carry multiple explicit context fields, so membership is a typed tuple.
                if member.id.trim().is_empty()
                    || !identities.insert((&member.declaration, &member.id, &member.engagement))
                {
                    fail(
                        &member.id,
                        "membership identity must be nonempty and unique",
                    );
                }
                let contract = records
                    .get(&member.engagement)
                    .and_then(|r| self.semantics.interactions.get(&r.interaction));
                if !contract.is_some_and(|i| {
                    if is_event {
                        i.events.contains_key(&member.declaration)
                    } else {
                        i.processes.contains_key(&member.declaration)
                    }
                }) {
                    fail(
                        &member.id,
                        "member has no matching declared engagement binding",
                    );
                }
            }
        }
        errors
    }
}
