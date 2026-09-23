use crate::concept::{ConceptIR, Violation};
use std::collections::BTreeSet;
impl ConceptIR {
    pub(crate) fn validate_subjects(&self) -> Vec<Violation> {
        let mut errors = vec![];
        let mut carriers = BTreeSet::new();
        for (id, subject) in &self.semantics.subjects {
            let mut fail = |message: &str| {
                errors.push(Violation {
                    code: "E-L0-SUBJECT".into(),
                    subject: id.clone(),
                    message: message.into(),
                })
            };
            if !self.entities.contains_key(&subject.carrier) {
                fail("subject carrier must be a declared entity, not a principal");
            }
            if !carriers.insert(&subject.carrier) {
                fail("subject carrier has multiple declarations");
            }
            if subject.profiles.is_empty() || subject.profiles.iter().any(|p| p.trim().is_empty()) {
                fail("subject requires nonempty domain profiles");
            }
        }
        for (id, representation) in &self.semantics.representations {
            let mut fail = |message: &str| {
                errors.push(Violation {
                    code: "E-L0-SUBJECT".into(),
                    subject: id.clone(),
                    message: message.into(),
                })
            };
            let Some(relation) = self
                .semantics
                .relationships
                .get(&representation.relationship)
            else {
                fail("unknown representation relationship");
                continue;
            };
            if relation.carrier.is_none() {
                fail("representation must have a typed durable carrier");
            }
            if !relation
                .endpoints
                .get(&representation.principal_role)
                .is_some_and(|e| self.principals.contains_key(&e.target))
            {
                fail("representation principal role must target a declared principal");
            }
            if !relation
                .endpoints
                .get(&representation.subject_role)
                .is_some_and(|e| carriers.contains(&e.target))
            {
                fail("representation subject role must target a declared Subject carrier");
            }
            if representation.principal_role == representation.subject_role {
                fail("principal and subject roles must be distinct");
            }
            for scope in &representation.scope_roles {
                if scope == &representation.principal_role
                    || scope == &representation.subject_role
                    || !relation.endpoints.contains_key(scope)
                {
                    fail("scope must be a separate declared relationship role");
                }
            }
        }
        errors
    }
}
