//! Externally imposed declarations, distinct from internal contracts and authorization.
use crate::concept::{ConceptIR, Violation};
use crate::concept_semantics::ContractOwner;
use serde::{Deserialize, Serialize};
use std::collections::BTreeSet;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ExternalConstraint {
    /// Subject declaration whose profiles explicitly include `authority`.
    pub authority: String,
    /// Typed jurisdiction entity declaration, never an untyped context reference.
    pub jurisdiction: String,
    pub citations: BTreeSet<String>,
    pub applicability: Applicability,
    /// Business contracts that must hold when applicable.
    pub requirements: BTreeSet<String>,
    /// Processes whose execution is prohibited when applicable.
    pub prohibitions: BTreeSet<String>,
    /// Half-open effective interval, epoch milliseconds.
    pub valid_from: i64,
    pub valid_until: Option<i64>,
    pub supersedes: BTreeSet<String>,
    pub evidence: BTreeSet<String>,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Applicability {
    pub process: String,
    pub predicate: crate::ir::Expr,
}
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConstraintExplanation {
    pub constraint: String,
    pub authority: String,
    pub jurisdiction: String,
    pub citations: BTreeSet<String>,
    pub applicability: Applicability,
    pub requirements: BTreeSet<String>,
    pub prohibited: bool,
}
impl ConceptIR {
    pub(crate) fn validate_external_constraints(&self) -> Vec<Violation> {
        let mut errors = vec![];
        for (id, constraint) in &self.semantics.external_constraints {
            let mut fail = |message: &str| {
                errors.push(Violation {
                    code: "E-L0-EXTERNAL-CONSTRAINT".into(),
                    subject: id.clone(),
                    message: message.into(),
                })
            };
            if !self
                .semantics
                .subjects
                .get(&constraint.authority)
                .is_some_and(|s| s.profiles.contains("authority"))
            {
                fail("authority must reference a Subject with an authority profile");
            }
            if !self.entities.contains_key(&constraint.jurisdiction) {
                fail("jurisdiction must reference a declared entity");
            }
            if constraint.citations.is_empty()
                || constraint.citations.iter().any(|c| c.trim().is_empty())
            {
                fail("external constraint requires nonempty source citations");
            }
            if !self.valid_external_applicability(&constraint.applicability) {
                fail(
                    "applicability must be a typed boolean predicate in a declared process context",
                );
            }
            if constraint.requirements.is_empty() && constraint.prohibitions.is_empty() {
                fail("external constraint must require a contract or prohibit a process");
            }
            for required in &constraint.requirements {
                if !self.semantics.contracts.contains_key(required) {
                    fail("unknown required business contract");
                }
            }
            for prohibited in &constraint.prohibitions {
                if !self.processes.contains_key(prohibited) {
                    fail("unknown prohibited process");
                }
            }
            if constraint
                .valid_until
                .is_some_and(|until| until <= constraint.valid_from)
            {
                fail("external constraint effective interval must be nonempty and ordered");
            }
            for evidence in &constraint.evidence {
                if !self.entities.contains_key(evidence) && !self.facts.contains_key(evidence) {
                    fail("unknown provenance entity or fact");
                }
            }
            for previous in &constraint.supersedes {
                match self.semantics.external_constraints.get(previous) {
                    None => fail("unknown superseded external constraint"),
                    Some(old) if old.valid_from > constraint.valid_from => {
                        fail("a revision cannot precede the constraint it supersedes")
                    }
                    _ => {}
                }
            }
            let mut visited = BTreeSet::new();
            let mut pending: Vec<_> = constraint.supersedes.iter().collect();
            while let Some(previous) = pending.pop() {
                if previous == id {
                    fail("external constraint supersession cycle");
                    break;
                }
                if visited.insert(previous)
                    && let Some(old) = self.semantics.external_constraints.get(previous)
                {
                    pending.extend(&old.supersedes);
                }
            }
        }
        errors
    }
    /// Explain declarations effective at `at` for a process. Applicability is NOT evaluated;
    /// returned predicate references must be checked in the caller's typed business context.
    /// Supersession edges retain history and do not silently rewrite validity intervals.
    pub fn external_constraints_for(&self, process: &str, at: i64) -> Vec<ConstraintExplanation> {
        self.semantics.external_constraints.iter().filter_map(|(id,c)| {
            if at < c.valid_from || c.valid_until.is_some_and(|until| at >= until) { return None; }
            let requirements: BTreeSet<_> = c.requirements.iter().filter(|id| self.semantics.contracts.get(*id).is_some_and(|contract| matches!(&contract.owner, ContractOwner::Process { id } if id == process))).cloned().collect();
            let prohibited = c.prohibitions.contains(process);
            if requirements.is_empty() && !prohibited { return None; }
            Some(ConstraintExplanation { constraint: id.clone(), authority:c.authority.clone(), jurisdiction:c.jurisdiction.clone(), citations:c.citations.clone(), applicability:c.applicability.clone(), requirements, prohibited })
        }).collect()
    }
}
