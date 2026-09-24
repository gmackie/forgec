use crate::concept::{ConceptIR, EntityRepresentation, Type, Violation};

fn reference(ty: &Type, carrier: &str) -> bool {
    matches!(ty, Type::Entity { id, representation: EntityRepresentation::Reference } if id == carrier)
}
impl ConceptIR {
    pub(crate) fn validate_interactions(&self) -> Vec<Violation> {
        let mut errors = vec![];
        let mut carriers = std::collections::BTreeSet::new();
        for (id, interaction) in &self.semantics.interactions {
            let mut fail = |message: &str| {
                errors.push(Violation {
                    code: "E-L0-INTERACTION".into(),
                    subject: id.clone(),
                    message: message.into(),
                })
            };
            let Some(entity) = self.entities.get(&interaction.carrier) else {
                fail("interaction carrier must be a declared entity");
                continue;
            };
            if !carriers.insert(&interaction.carrier) {
                fail("interaction carrier has multiple semantic declarations");
            }
            if interaction.participation.is_empty() {
                fail("interaction requires a participation relationship");
            }
            for relation in &interaction.participation {
                if !self.semantics.relationships.get(relation).is_some_and(|r| {
                    r.carrier.is_some()
                        && r.endpoints
                            .values()
                            .any(|e| e.target == interaction.carrier)
                }) {
                    fail(
                        "participation must be a carried relationship with an endpoint to the interaction carrier",
                    );
                }
            }
            for (event, field) in &interaction.events {
                if !self.semantics.events.contains(event)
                    || !self
                        .facts
                        .get(event)
                        .and_then(|f| f.fields.get(field))
                        .is_some_and(|f| {
                            reference(&f.ty.base, &interaction.carrier) && !f.ty.optional
                        })
                {
                    fail(
                        "interaction event must bind a required entity reference on an occurrence Fact",
                    );
                }
            }
            for (process, port) in &interaction.processes {
                if !self
                    .processes
                    .get(process)
                    .and_then(|p| p.inputs.get(port))
                    .is_some_and(|p| reference(&p.ty.base, &interaction.carrier) && !p.ty.optional)
                {
                    fail("interaction process must bind a required entity reference input port");
                }
            }
            if let Some(field) = &interaction.parent {
                let valid = entity.fields.get(field).is_some_and(|f| {
                    self.semantics
                        .interactions
                        .values()
                        .any(|parent| reference(&f.ty.base, &parent.carrier))
                });
                if !valid {
                    fail("parent field must reference a declared interaction carrier");
                }
            }
            if let Some(purpose) = &interaction.purpose
                && !self.purposes.contains_key(purpose)
            {
                fail("unknown interaction purpose");
            }
            // Existing temporal validation checks the interval fields and their date/time types.
            if !self
                .semantics
                .temporal
                .get(&interaction.carrier)
                .is_some_and(|t| t.valid.is_some())
            {
                fail(
                    "interaction carrier requires a valid-time interval for its engagement bounds",
                );
            }
        }
        errors
    }
}
