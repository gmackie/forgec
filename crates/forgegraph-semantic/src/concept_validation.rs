//! Opt-in declaration closure; partial loading remains suitable for editor fragments.
use crate::concept::*;

fn require(errors: &mut Vec<Violation>, subject: &str, exists: bool, family: &str, id: &str) {
    if !exists {
        errors.push(Violation {
            code: "E-L0-REFERENCE".into(),
            subject: subject.into(),
            message: format!("unknown {family} `{id}`"),
        });
    }
}
impl ConceptIR {
    /// Load a complete model, checking declaration closure and external port types.
    /// This does not prove implementation, selection expressions, or policy predicates.
    pub fn load_closed(value: &serde_json::Value) -> Result<Self, String> {
        let concept = Self::load(value)?;
        let errors = concept.validate_closed();
        if errors.is_empty() {
            Ok(concept)
        } else {
            Err(serde_json::to_string(&errors).unwrap())
        }
    }

    fn closed_type(&self, ty: &ConceptType, subject: &str, errors: &mut Vec<Violation>) {
        let target = match &ty.base {
            Type::Principal { id } => Some((self.principals.contains_key(id), "principal", id)),
            Type::Entity { id, .. } => Some((self.entities.contains_key(id), "entity", id)),
            Type::Fact { id } => Some((self.facts.contains_key(id), "fact", id)),
            Type::Shape { id } => Some((self.shapes.contains_key(id), "shape", id)),
            Type::Enum { id } => Some((self.enums.contains_key(id), "enum", id)),
            Type::Collection { element, .. } => {
                self.closed_type(element, subject, errors);
                None
            }
            Type::Scalar { .. } => None,
        };
        if let Some((exists, family, id)) = target {
            require(errors, subject, exists, family, id);
        }
        if let Some(id) = &ty.purpose {
            require(
                errors,
                subject,
                self.purposes.contains_key(id),
                "purpose",
                id,
            );
        }
        if let Some(id) = &ty.data_class {
            require(
                errors,
                subject,
                self.data_classes.contains_key(id),
                "data class",
                id,
            );
        }
    }

    /// Existing validation plus recursive type/activation/behavior declaration closure.
    /// External ports require exact ConceptType equality, including facets and optionality.
    /// Graph diagnostic reference nodes are never treated as declarations.
    pub fn validate_closed(&self) -> Vec<Violation> {
        let mut errors = self.validate();
        for fields in self
            .entities
            .values()
            .map(|e| &e.fields)
            .chain(self.facts.values().map(|f| &f.fields))
            .chain(self.shapes.values())
        {
            for (id, field) in fields {
                self.closed_type(&field.ty, id, &mut errors);
            }
        }
        for external in self.externals.values() {
            for (id, ty) in external.data.iter().chain(external.accepts.iter()) {
                self.closed_type(ty, id, &mut errors);
            }
        }
        for principal in self.principals.values() {
            for (id, ty) in &principal.attributes {
                self.closed_type(ty, id, &mut errors);
            }
        }
        for (id, policy) in &self.policies {
            self.closed_type(&policy.resource, id, &mut errors);
            if let Some(purpose) = &policy.purpose {
                require(
                    &mut errors,
                    id,
                    self.purposes.contains_key(purpose),
                    "purpose",
                    purpose,
                );
            }
        }
        for (id, process) in &self.processes {
            if let Some(purpose) = &process.purpose {
                require(
                    &mut errors,
                    id,
                    self.purposes.contains_key(purpose),
                    "purpose",
                    purpose,
                );
            }
            for (port, activation) in &process.activations {
                match activation {
                    Activation::Request { payload: Some(ty) } => {
                        self.closed_type(ty, port, &mut errors)
                    }
                    Activation::Fact { fact } => require(
                        &mut errors,
                        port,
                        self.facts.contains_key(fact),
                        "activation fact",
                        fact,
                    ),
                    Activation::Change { entity } => require(
                        &mut errors,
                        port,
                        self.entities.contains_key(entity),
                        "activation entity",
                        entity,
                    ),
                    Activation::ExternalEvent { external, event } => {
                        if let Some(source) = self.externals.get(external) {
                            require(
                                &mut errors,
                                port,
                                source.events.contains(event),
                                "external event",
                                event,
                            );
                        }
                    }
                    _ => {}
                }
            }
            for (port, input) in &process.inputs {
                self.closed_type(&input.ty, port, &mut errors);
                if let InputOrigin::External { external } = &input.origin
                    && let Some(source) = self.externals.get(external)
                    && !source.data.values().any(|ty| ty == &input.ty)
                {
                    errors.push(Violation {
                        code: "E-L0-EXTERNAL-TYPE".into(),
                        subject: port.clone(),
                        message: format!(
                            "external input type must exactly match a data port on `{external}`"
                        ),
                    });
                }
            }
            for (port, output) in &process.outputs {
                self.closed_type(&output.ty, port, &mut errors);
                if let OutputDisposition::Export { external } = &output.disposition
                    && let Some(target) = self.externals.get(external)
                    && !target.accepts.values().any(|ty| ty == &output.ty)
                {
                    errors.push(Violation { code: "E-L0-EXTERNAL-TYPE".into(), subject: port.clone(), message: format!("external output type must exactly match an accepts port on `{external}`") });
                }
            }
            if let Some(behavior) = &process.behavior {
                if let Some(ty) = &behavior.stateful {
                    self.closed_type(ty, id, &mut errors);
                }
                if let Some(workflow) = &behavior.workflow {
                    for (port, fact) in &workflow.waits {
                        require(
                            &mut errors,
                            port,
                            self.facts.contains_key(fact),
                            "workflow fact",
                            fact,
                        );
                    }
                }
            }
        }
        errors
    }
}
