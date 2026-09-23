//! Opt-in business semantics. These declarations contain no storage or execution choices.
use crate::concept::{ConceptIR, Field, Type, Violation};
use crate::ir::Expr;
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BusinessSemantics {
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub temporal: BTreeMap<String, TemporalSemantics>,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub external_constraints: BTreeMap<String, crate::concept_governance::ExternalConstraint>,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub interactions: BTreeMap<String, Interaction>,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub subjects: BTreeMap<String, Subject>,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub representations: BTreeMap<String, SubjectRepresentation>,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub selections: BTreeMap<String, TemporalSelection>,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub contracts: BTreeMap<String, Contract>,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub relationships: BTreeMap<String, Relationship>,
    #[serde(default, skip_serializing_if = "BTreeSet::is_empty")]
    pub events: BTreeSet<String>,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub effects: BTreeMap<String, BusinessEffect>,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub views: BTreeMap<String, PerspectiveView>,
}
impl BusinessSemantics {
    pub fn is_empty(&self) -> bool {
        self == &Self::default()
    }
}

/// Domain-owned actor identity. Profiles classify meaning; they are not compiler subtypes.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Subject {
    pub carrier: String,
    pub profiles: BTreeSet<String>,
}
/// Explicit principal-to-actor mapping carried by a typed, optionally scoped relationship.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SubjectRepresentation {
    pub relationship: String,
    pub principal_role: String,
    pub subject_role: String,
    pub scope_roles: BTreeSet<String>,
}

/// An engagement has an entity identity; occurrences and work remain separate declarations.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Interaction {
    pub carrier: String,
    /// Relationship declarations with a typed endpoint to this engagement.
    pub participation: BTreeSet<String>,
    /// Occurrence Fact -> field holding this engagement's entity reference.
    pub events: BTreeMap<String, String>,
    /// Process -> input port carrying this engagement's entity reference.
    pub processes: BTreeMap<String, String>,
    /// Optional carrier field referencing another interaction carrier (including this type).
    pub parent: Option<String>,
    pub purpose: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TemporalSemantics {
    pub occurrence: Option<String>,
    pub valid: Option<IntervalBinding>,
    pub knowledge: Option<IntervalBinding>,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct IntervalBinding {
    pub from: String,
    pub to: Option<String>,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum TemporalAxis {
    Occurrence,
    Valid,
    Knowledge,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase", deny_unknown_fields)]
pub enum TemporalRelation {
    At { instant: Expr },
    During { from: Expr, to: Expr },
    Latest,
}
/// Named selectors can be referenced by contracts and policies; context is a process or policy.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TemporalSelection {
    pub context: String,
    pub binding: String,
    pub target: String,
    pub axis: TemporalAxis,
    pub relation: TemporalRelation,
    /// Semantic tie-breaking fields, required for latest (never physical insertion order).
    #[serde(default)]
    pub tie_break: Vec<String>,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Contract {
    pub owner: ContractOwner,
    pub kind: ContractKind,
    pub predicate: Expr,
    #[serde(default)]
    pub selectors: BTreeSet<String>,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase", deny_unknown_fields)]
pub enum ContractOwner {
    Process { id: String },
    Entity { id: String },
    Fact { id: String },
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ContractKind {
    Requires,
    Ensures,
    Invariant,
}
/// A domain-named relationship binds roles to typed fields on its addressable fact/entity.
/// Structural edges instead declare typed endpoints with no carrier or independent lifecycle.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Relationship {
    pub carrier: Option<String>,
    pub endpoints: BTreeMap<String, Endpoint>,
    #[serde(default)]
    pub evidence: BTreeSet<String>,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Endpoint {
    pub target: String,
    pub field: Option<String>,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BusinessEffect {
    /// An effect is a typed Fact, distinct from an occurrence Fact.
    pub fact: String,
    pub causes: BTreeMap<String, String>,  // field -> event fact
    pub targets: BTreeMap<String, String>, // field -> entity/fact (including relationship carriers)
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PerspectiveView {
    pub fact: String,
    pub observer_role: String,
    pub fields: BTreeSet<String>,
    pub authorizations: BTreeSet<String>,
    pub purpose: Option<String>,
}

fn problem(errors: &mut Vec<Violation>, code: &str, subject: &str, message: impl Into<String>) {
    errors.push(Violation {
        code: code.into(),
        subject: subject.into(),
        message: message.into(),
    });
}
fn fields<'a>(c: &'a ConceptIR, id: &str) -> Option<&'a BTreeMap<String, Field>> {
    c.entities
        .get(id)
        .map(|e| &e.fields)
        .or_else(|| c.facts.get(id).map(|f| &f.fields))
}
fn target(ty: &Type) -> Option<&str> {
    match ty {
        Type::Entity { id, .. } | Type::Fact { id } | Type::Principal { id } => Some(id),
        _ => None,
    }
}
fn timestamp(field: &Field) -> bool {
    matches!(&field.ty.base, Type::Scalar { name, .. } if name == "datetime" || name == "timestamp" || name == "date")
}

impl ConceptIR {
    pub(crate) fn valid_external_applicability(
        &self,
        applicability: &crate::concept_governance::Applicability,
    ) -> bool {
        self.processes.contains_key(&applicability.process)
            && matches!(
                self.expression_type(
                    &applicability.predicate,
                    &self.process_scope(&applicability.process, false)
                ),
                Ok(ValueType::Bool)
            )
    }
    pub(crate) fn validate_business_semantics(&self) -> Vec<Violation> {
        let mut errors = self.validate_expressions();
        let s = &self.semantics;
        errors.extend(self.validate_interactions());
        errors.extend(self.validate_subjects());
        errors.extend(self.validate_external_constraints());
        for (id, temporal) in &s.temporal {
            let Some(fs) = fields(self, id) else {
                problem(
                    &mut errors,
                    "E-L0-TEMPORAL",
                    id,
                    "temporal binding requires an entity or fact",
                );
                continue;
            };
            let mut bound = vec![];
            if let Some(f) = &temporal.occurrence {
                bound.push((f, false));
            }
            for interval in [&temporal.valid, &temporal.knowledge].into_iter().flatten() {
                bound.push((&interval.from, false));
                if let Some(to) = &interval.to {
                    bound.push((to, true));
                    if let (Some(start), Some(end)) = (fs.get(&interval.from), fs.get(to)) {
                        let mut end_type = end.ty.clone();
                        end_type.optional = false;
                        if value_type(&start.ty) != value_type(&end_type) {
                            problem(
                                &mut errors,
                                "E-L0-TEMPORAL",
                                id,
                                "interval endpoints must use the same date or timestamp type",
                            );
                        }
                    }
                    if to == &interval.from {
                        problem(
                            &mut errors,
                            "E-L0-TEMPORAL",
                            id,
                            "interval start and end must be distinct fields",
                        );
                    }
                }
            }
            if bound.is_empty() {
                problem(&mut errors, "E-L0-TEMPORAL", id, "empty temporal facet");
            }
            for (name, nullable) in bound {
                if !fs
                    .get(name)
                    .is_some_and(|f| timestamp(f) && (nullable || !f.ty.optional))
                {
                    problem(
                        &mut errors,
                        "E-L0-TEMPORAL",
                        id,
                        format!(
                            "invalid temporal field {name}; starts/occurrence must be required date/timestamp fields"
                        ),
                    );
                }
            }
        }
        for (id, selection) in &s.selections {
            let axis_exists =
                s.temporal
                    .get(&selection.target)
                    .is_some_and(|t| match selection.axis {
                        TemporalAxis::Occurrence => t.occurrence.is_some(),
                        TemporalAxis::Valid => t.valid.is_some(),
                        TemporalAxis::Knowledge => t.knowledge.is_some(),
                    });
            if !axis_exists {
                problem(
                    &mut errors,
                    "E-L0-TEMPORAL",
                    id,
                    "selector requires a declared target time axis",
                );
            }
            if !self.processes.contains_key(&selection.context)
                && !self.policies.contains_key(&selection.context)
            {
                problem(
                    &mut errors,
                    "E-L0-TEMPORAL",
                    id,
                    "selector context must be a process or policy",
                );
            }
            let selected_type = self
                .processes
                .get(&selection.context)
                .and_then(|p| p.inputs.get(&selection.binding))
                .map(|i| &i.ty)
                .or_else(|| {
                    self.policies
                        .get(&selection.context)
                        .filter(|_| selection.binding == "resource")
                        .map(|p| &p.resource)
                });
            if selected_type.and_then(|ty| target(&ty.base)) != Some(selection.target.as_str()) {
                problem(
                    &mut errors,
                    "E-L0-TEMPORAL",
                    id,
                    "selector must bind a typed process input or policy resource",
                );
            }
            if matches!(selection.relation, TemporalRelation::Latest)
                && selection.tie_break.is_empty()
            {
                problem(
                    &mut errors,
                    "E-L0-TEMPORAL",
                    id,
                    "latest requires semantic tie-breaking fields",
                );
            }
            if matches!(selection.relation, TemporalRelation::Latest) {
                let unique = fields(self, &selection.target).is_some_and(|fs| {
                    selection.tie_break.iter().any(|key| {
                        fs.get(key).is_some_and(|f| {
                            f.immutable
                                && !f.ty.optional
                                && matches!(&f.ty.base, Type::Scalar {name, ..} if name == "id")
                        })
                    })
                });
                if !unique {
                    problem(
                        &mut errors,
                        "E-L0-TEMPORAL",
                        id,
                        "latest requires an immutable identity tie-breaker",
                    );
                }
            }
            let mut tie_fields = BTreeSet::new();
            for field in &selection.tie_break {
                if !tie_fields.insert(field) {
                    problem(
                        &mut errors,
                        "E-L0-TEMPORAL",
                        id,
                        "duplicate tie-break field",
                    );
                }
                if !fields(self, &selection.target)
                    .and_then(|fs| fs.get(field))
                    .is_some_and(|f| {
                        matches!(
                            value_type(&f.ty),
                            Ok(ValueType::Bool
                                | ValueType::Number
                                | ValueType::Text
                                | ValueType::Time
                                | ValueType::Date)
                        )
                    })
                {
                    problem(
                        &mut errors,
                        "E-L0-TEMPORAL",
                        id,
                        format!("tie-break field {field} must be a required orderable scalar"),
                    );
                }
            }
        }
        for (id, contract) in &s.contracts {
            let valid = match &contract.owner {
                ContractOwner::Process { id } => self.processes.contains_key(id),
                ContractOwner::Entity { id } => {
                    self.entities.contains_key(id) && contract.kind == ContractKind::Invariant
                }
                ContractOwner::Fact { id } => {
                    self.facts.contains_key(id) && contract.kind == ContractKind::Invariant
                }
            };
            if !valid {
                problem(
                    &mut errors,
                    "E-L0-CONTRACT",
                    id,
                    "invalid contract owner/kind; data declarations support invariants only",
                );
            }
            for selector in &contract.selectors {
                if !s
                    .selections
                    .get(selector)
                    .is_some_and(|selection| match &contract.owner {
                        ContractOwner::Process { id } => &selection.context == id,
                        ContractOwner::Entity { id } | ContractOwner::Fact { id } => {
                            &selection.target == id
                        }
                    })
                {
                    problem(
                        &mut errors,
                        "E-L0-CONTRACT",
                        id,
                        format!("unknown temporal selector {selector}"),
                    );
                }
            }
        }
        for (id, relation) in &s.relationships {
            if relation.endpoints.len() < 2 {
                problem(
                    &mut errors,
                    "E-L0-RELATIONSHIP",
                    id,
                    "relationship requires at least two named roles",
                );
            }
            if let Some(carrier) = &relation.carrier
                && fields(self, carrier).is_none()
            {
                problem(
                    &mut errors,
                    "E-L0-RELATIONSHIP",
                    id,
                    "unknown relationship carrier",
                );
            }
            for (role, endpoint) in &relation.endpoints {
                if fields(self, &endpoint.target).is_none()
                    && !self.principals.contains_key(&endpoint.target)
                {
                    problem(
                        &mut errors,
                        "E-L0-RELATIONSHIP",
                        id,
                        format!("unknown endpoint for {role}"),
                    );
                }
                match (&relation.carrier, &endpoint.field) {
                    (Some(carrier), Some(field))
                        if fields(self, carrier)
                            .and_then(|f| f.get(field))
                            .and_then(|f| target(&f.ty.base))
                            == Some(endpoint.target.as_str()) => {}
                    (None, None) => {}
                    _ => problem(
                        &mut errors,
                        "E-L0-RELATIONSHIP",
                        id,
                        format!(
                            "role {role} must bind a carrier field with the declared endpoint type"
                        ),
                    ),
                }
            }
            for evidence in &relation.evidence {
                if fields(self, evidence).is_none() {
                    problem(
                        &mut errors,
                        "E-L0-RELATIONSHIP",
                        id,
                        "unknown evidence declaration",
                    );
                }
            }
        }
        for event in &s.events {
            if !self.facts.contains_key(event) {
                problem(
                    &mut errors,
                    "E-L0-EFFECT",
                    event,
                    "occurrences must be declared facts",
                );
            }
        }
        for (id, effect) in &s.effects {
            let Some(fact) = self.facts.get(&effect.fact) else {
                problem(
                    &mut errors,
                    "E-L0-EFFECT",
                    id,
                    "effect must be a declared fact",
                );
                continue;
            };
            if s.events.contains(&effect.fact)
                || effect.causes.is_empty()
                || effect.targets.is_empty()
            {
                problem(
                    &mut errors,
                    "E-L0-EFFECT",
                    id,
                    "effect requires causes and targets and must differ from an occurrence",
                );
            }
            for (field, to) in effect.causes.iter().chain(&effect.targets) {
                if fact.fields.get(field).and_then(|f| target(&f.ty.base)) != Some(to.as_str())
                    || fields(self, to).is_none()
                {
                    problem(
                        &mut errors,
                        "E-L0-EFFECT",
                        id,
                        format!("untyped/mismatched effect field {field}"),
                    );
                }
            }
            for cause in effect.causes.values() {
                if !s.events.contains(cause) {
                    problem(
                        &mut errors,
                        "E-L0-EFFECT",
                        id,
                        "cause must be a declared occurrence",
                    );
                }
            }
        }
        for (id, view) in &s.views {
            let Some(fs) = fields(self, &view.fact) else {
                problem(&mut errors, "E-L0-VIEW", id, "unknown neutral fact/entity");
                continue;
            };
            if fs
                .get(&view.observer_role)
                .and_then(|f| target(&f.ty.base))
                .is_none()
            {
                problem(
                    &mut errors,
                    "E-L0-VIEW",
                    id,
                    "observer role must reference a typed participant",
                );
            }
            for field in &view.fields {
                if !fs.get(field).is_some_and(|f| !f.secret) {
                    problem(
                        &mut errors,
                        "E-L0-VIEW",
                        id,
                        format!("unknown projected field {field}"),
                    );
                }
            }
            for auth in &view.authorizations {
                if !self
                    .policies
                    .get(auth)
                    .is_some_and(|p| target(&p.resource.base) == Some(view.fact.as_str()))
                {
                    problem(
                        &mut errors,
                        "E-L0-VIEW",
                        id,
                        "view policy must authorize the neutral fact type",
                    );
                }
            }
            if view
                .purpose
                .as_ref()
                .is_some_and(|p| !self.purposes.contains_key(p))
            {
                problem(&mut errors, "E-L0-VIEW", id, "unknown view purpose");
            }
        }
        errors
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum ValueType {
    Bool,
    Number,
    Text,
    Time,
    Date,
    Null,
    Record(String),
    Collection(Box<ValueType>),
}
fn value_type(ty: &crate::concept::ConceptType) -> Result<ValueType, String> {
    if ty.optional {
        return Err("nullable values require an explicit domain contract before use".into());
    }
    match &ty.base {
        Type::Scalar { name, .. } => match name.as_str() {
            "boolean" | "bool" => Ok(ValueType::Bool),
            "integer" | "int" | "decimal" => Ok(ValueType::Number),
            "datetime" | "timestamp" => Ok(ValueType::Time),
            "date" => Ok(ValueType::Date),
            "text" | "id" => Ok(ValueType::Text),
            _ => Err(format!("unsupported contract scalar {name}")),
        },
        Type::Entity { id, .. }
        | Type::Fact { id }
        | Type::Shape { id }
        | Type::Principal { id } => Ok(ValueType::Record(id.clone())),
        Type::Collection { element, .. } => {
            Ok(ValueType::Collection(Box::new(value_type(element)?)))
        }
        Type::Enum { .. } => Ok(ValueType::Text),
    }
}
impl ConceptIR {
    fn expression_type(
        &self,
        expression: &Expr,
        scope: &BTreeMap<String, ValueType>,
    ) -> Result<ValueType, String> {
        use crate::ir::Literal;
        match expression {
            Expr::Name { path } => {
                let (root, rest) = path.split_first().ok_or("empty contract reference")?;
                let mut ty = scope
                    .get(root)
                    .cloned()
                    .ok_or_else(|| format!("unknown contract binding {root}"))?;
                for field in rest {
                    let ValueType::Record(id) = ty else {
                        return Err(format!("{field} is not a record field"));
                    };
                    let fs = fields(self, &id)
                        .or_else(|| self.shapes.get(&id))
                        .ok_or("unknown record type")?;
                    ty = value_type(
                        &fs.get(field)
                            .ok_or_else(|| format!("unknown field {id}.{field}"))?
                            .ty,
                    )?;
                }
                Ok(ty)
            }
            Expr::Literal { literal } => match literal {
                Literal::Bool(_) => Ok(ValueType::Bool),
                Literal::Int(v) | Literal::Decimal(v)
                    if v.parse::<f64>().is_ok_and(f64::is_finite) =>
                {
                    Ok(ValueType::Number)
                }
                Literal::String(_) => Ok(ValueType::Text),
                Literal::Null => Ok(ValueType::Null),
                _ => Err("unsupported/invalid contract literal".into()),
            },
            Expr::Unary { op, operand } => {
                let ty = self.expression_type(operand, scope)?;
                match (op.as_str(), &ty) {
                    ("!" | "not", ValueType::Bool) | ("-", ValueType::Number) => Ok(ty),
                    _ => Err("invalid unary contract expression".into()),
                }
            }
            Expr::Binary { op, lhs, rhs } => {
                let a = self.expression_type(lhs, scope)?;
                let b = self.expression_type(rhs, scope)?;
                if a != b {
                    return Err("contract operands have different types".into());
                }
                match op.as_str() {
                    "and" | "or" | "&&" | "||" if a == ValueType::Bool => Ok(ValueType::Bool),
                    "==" | "!="
                        if !matches!(a, ValueType::Record(_) | ValueType::Collection(_)) =>
                    {
                        Ok(ValueType::Bool)
                    }
                    "<" | "<=" | ">" | ">="
                        if matches!(a, ValueType::Number | ValueType::Time | ValueType::Date) =>
                    {
                        Ok(ValueType::Bool)
                    }
                    "+" | "-" | "*" if a == ValueType::Number => Ok(ValueType::Number),
                    _ => Err(format!("unsupported contract operator {op} for {a:?}")),
                }
            }
            Expr::Call { callee, args } => {
                if args.len() != 1 {
                    return Err("contract aggregates take one argument".into());
                }
                let ty = self.expression_type(&args[0], scope)?;
                match (callee.as_slice(), ty) {
                    ([name], ValueType::Collection(_)) if name == "count" => Ok(ValueType::Number),
                    ([name], ValueType::Collection(element))
                        if name == "sum" && *element == ValueType::Number =>
                    {
                        Ok(ValueType::Number)
                    }
                    _ => {
                        Err("unsupported contract call; only typed count/sum are available".into())
                    }
                }
            }
        }
    }
    fn process_scope(&self, id: &str, include_outputs: bool) -> BTreeMap<String, ValueType> {
        let mut scope = BTreeMap::new();
        if let Some(p) = self.processes.get(id) {
            for (name, input) in &p.inputs {
                if let Ok(ty) = value_type(&input.ty) {
                    scope.insert(name.clone(), ty);
                }
            }
            if include_outputs {
                for (name, output) in &p.outputs {
                    if let Ok(ty) = value_type(&output.ty) {
                        scope.insert(name.clone(), ty);
                    }
                }
            }
        }
        if let Some(p) = self.policies.get(id) {
            if let Ok(ty) = value_type(&p.resource) {
                scope.insert("resource".into(), ty);
            }
            if let Some(principal) = self.principals.get(&p.principal) {
                for (name, ty) in &principal.attributes {
                    if let Ok(ty) = value_type(ty) {
                        scope.insert(name.clone(), ty);
                    }
                }
            }
        }
        scope
    }
    fn validate_expressions(&self) -> Vec<Violation> {
        let mut errors = vec![];
        for (id, contract) in &self.semantics.contracts {
            let scope = match &contract.owner {
                ContractOwner::Process { id } => {
                    self.process_scope(id, contract.kind != ContractKind::Requires)
                }
                ContractOwner::Entity { id } | ContractOwner::Fact { id } => {
                    BTreeMap::from([("self".into(), ValueType::Record(id.clone()))])
                }
            };
            match self.expression_type(&contract.predicate, &scope) {
                Ok(ValueType::Bool) => {}
                result => problem(
                    &mut errors,
                    "E-L0-CONTRACT",
                    id,
                    format!("contract must be a typed boolean expression: {result:?}"),
                ),
            }
        }
        for (id, selection) in &self.semantics.selections {
            let scope = self.process_scope(&selection.context, false);
            let expressions = match &selection.relation {
                TemporalRelation::At { instant } => vec![instant],
                TemporalRelation::During { from, to } => vec![from, to],
                TemporalRelation::Latest => vec![],
            };
            let axis_type = self
                .semantics
                .temporal
                .get(&selection.target)
                .and_then(|temporal| match selection.axis {
                    TemporalAxis::Occurrence => temporal.occurrence.as_ref(),
                    TemporalAxis::Valid => temporal.valid.as_ref().map(|interval| &interval.from),
                    TemporalAxis::Knowledge => {
                        temporal.knowledge.as_ref().map(|interval| &interval.from)
                    }
                })
                .and_then(|name| fields(self, &selection.target)?.get(name))
                .and_then(|field| value_type(&field.ty).ok());
            for expression in expressions {
                let actual = self.expression_type(expression, &scope).ok();
                if !matches!(actual, Some(ValueType::Time | ValueType::Date)) || actual != axis_type
                {
                    problem(
                        &mut errors,
                        "E-L0-TEMPORAL",
                        id,
                        "selector bounds must match the selected axis date or timestamp type in their context",
                    );
                }
            }
        }
        errors
    }
    /// The same producer analysis used for durable ownership identifies invariant responsibility.
    pub fn invariant_producers(&self) -> BTreeMap<String, BTreeSet<String>> {
        let mut result = BTreeMap::new();
        for (id, contract) in &self.semantics.contracts {
            let owner = match &contract.owner {
                ContractOwner::Entity { id } | ContractOwner::Fact { id } => id,
                _ => continue,
            };
            let producers = self
                .processes
                .iter()
                .filter(|(_, p)| {
                    p.outputs.values().any(|o| {
                        matches!(
                            o.disposition,
                            crate::concept::OutputDisposition::ProduceEntity
                                | crate::concept::OutputDisposition::EmitFact
                        ) && target(&o.ty.base) == Some(owner.as_str())
                    })
                })
                .map(|(id, _)| id.clone())
                .collect();
            result.insert(id.clone(), producers);
        }
        result
    }
}

/// Evidence is an L1 sidecar, deliberately excluded from ConceptIR content identity.
/// These are declared assurance levels, not conclusions of a theorem prover.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Assurance {
    pub concept_hash: String,
    pub mechanism: String,
    pub claims: BTreeMap<String, AssuranceClaim>,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AssuranceClaim {
    pub contract_hash: String,
    pub status: AssuranceStatus,
    pub evidence: BTreeSet<String>,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum AssuranceStatus {
    StaticallyProven,
    RuntimeEnforced,
    ExternallyAssumed,
    Observed,
    Unknown,
}
impl ConceptIR {
    /// Check evidence binding/completeness. This never promotes an assertion to verified proof.
    pub fn check_assurance(&self, evidence: &Assurance) -> Vec<Violation> {
        let mut errors = vec![];
        if evidence.concept_hash != self.content_hash() {
            problem(
                &mut errors,
                "E-L0-ASSURANCE",
                &self.package,
                "assurance is bound to another semantic contract",
            );
        }
        for (id, contract) in &self.semantics.contracts {
            let hash = crate::ir::hash_hex(&serde_json::to_string(contract).unwrap());
            match evidence.claims.get(id) {
                Some(claim)
                    if claim.contract_hash == hash
                        && claim.status != AssuranceStatus::Unknown
                        && !claim.evidence.is_empty() => {}
                _ => problem(
                    &mut errors,
                    "E-L0-UNPROVEN",
                    id,
                    "missing, stale, unknown, or unsupported assurance claim",
                ),
            }
        }
        for id in evidence.claims.keys() {
            if !self.semantics.contracts.contains_key(id) {
                problem(
                    &mut errors,
                    "E-L0-ASSURANCE",
                    id,
                    "claim refers to an unknown contract",
                );
            }
        }
        errors
    }
    pub fn semantic_changes(&self, next: &Self) -> Vec<SemanticChange> {
        fn walk(
            path: String,
            a: &serde_json::Value,
            b: &serde_json::Value,
            out: &mut Vec<SemanticChange>,
        ) {
            if a == b {
                return;
            }
            if let (Some(a), Some(b)) = (a.as_object(), b.as_object()) {
                let keys: BTreeSet<_> = a.keys().chain(b.keys()).collect();
                for key in keys {
                    walk(
                        format!("{path}/{}", key.replace('~', "~0").replace('/', "~1")),
                        a.get(key).unwrap_or(&serde_json::Value::Null),
                        b.get(key).unwrap_or(&serde_json::Value::Null),
                        out,
                    );
                }
            } else {
                out.push(SemanticChange {
                    path,
                    before: a.clone(),
                    after: b.clone(),
                });
            }
        }
        let mut changes = vec![];
        walk(
            String::new(),
            &serde_json::to_value(self).unwrap(),
            &serde_json::to_value(next).unwrap(),
            &mut changes,
        );
        changes
    }
    pub(crate) fn add_business_graph(&self, graph: &mut crate::concept::Graph) {
        let mut edge = |from: &str, to: &str, port: &str, kind: &str| {
            graph.edges.insert(crate::concept::Edge {
                from: from.into(),
                to: to.into(),
                port: port.into(),
                kind: kind.into(),
            });
        };
        for (id, constraint) in &self.semantics.external_constraints {
            graph.nodes.insert(id.clone(), "externalConstraint".into());
            edge(&constraint.authority, id, id, "imposes");
            edge(id, &constraint.jurisdiction, id, "jurisdiction");
            edge(&constraint.applicability.process, id, id, "applicability");
            for required in &constraint.requirements {
                edge(id, required, id, "requires");
            }
            for prohibited in &constraint.prohibitions {
                edge(id, prohibited, id, "prohibits");
            }
            for previous in &constraint.supersedes {
                edge(id, previous, id, "supersedes");
            }
            for evidence in &constraint.evidence {
                edge(evidence, id, id, "supports");
            }
        }
        for (id, subject) in &self.semantics.subjects {
            graph.nodes.insert(id.clone(), "subject".into());
            edge(id, &subject.carrier, id, "carrier");
        }
        for (id, representation) in &self.semantics.representations {
            graph
                .nodes
                .insert(id.clone(), "subjectRepresentation".into());
            edge(id, &representation.relationship, id, "represents");
        }
        for (id, interaction) in &self.semantics.interactions {
            graph.nodes.insert(id.clone(), "interaction".into());
            edge(id, &interaction.carrier, id, "carrier");
            for participation in &interaction.participation {
                edge(participation, id, id, "participatesIn");
            }
            for (event, field) in &interaction.events {
                edge(event, id, field, "occursIn");
            }
            for (process, port) in &interaction.processes {
                edge(process, id, port, "engagesIn");
            }
            if let Some(field) = &interaction.parent
                && let Some(parent) = self
                    .entities
                    .get(&interaction.carrier)
                    .and_then(|e| e.fields.get(field))
                    .and_then(|f| target(&f.ty.base))
            {
                edge(&interaction.carrier, parent, field, "parentInteraction");
            }
            if let Some(purpose) = &interaction.purpose {
                edge(purpose, id, id, "purpose");
            }
        }
        for (id, relation) in &self.semantics.relationships {
            graph.nodes.insert(id.clone(), "relationship".into());
            for (role, endpoint) in &relation.endpoints {
                edge(id, &endpoint.target, role, "endpoint");
            }
            if let Some(carrier) = &relation.carrier {
                edge(id, carrier, id, "carrier");
            }
            for evidence in &relation.evidence {
                edge(evidence, id, id, "supports");
            }
        }
        for (id, effect) in &self.semantics.effects {
            graph.nodes.insert(id.clone(), "effect".into());
            edge(id, &effect.fact, id, "carrier");
            for (field, cause) in &effect.causes {
                edge(cause, id, field, "causes");
            }
            for (field, target) in &effect.targets {
                edge(id, target, field, "affects");
            }
        }
        for (id, view) in &self.semantics.views {
            graph.nodes.insert(id.clone(), "view".into());
            edge(&view.fact, id, &view.observer_role, "perspective");
            for policy in &view.authorizations {
                edge(policy, id, id, "authorize");
            }
        }
        for (id, contract) in &self.semantics.contracts {
            graph.nodes.insert(id.clone(), "contract".into());
            let owner = match &contract.owner {
                ContractOwner::Entity { id }
                | ContractOwner::Fact { id }
                | ContractOwner::Process { id } => id,
            };
            edge(owner, id, id, "contract");
            for selector in &contract.selectors {
                edge(selector, id, id, "timeContext");
            }
        }
        for (id, selection) in &self.semantics.selections {
            graph.nodes.insert(id.clone(), "temporalSelection".into());
            edge(&selection.target, id, id, "select");
            edge(id, &selection.context, id, "timeContext");
        }
    }
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SemanticChange {
    pub path: String,
    pub before: serde_json::Value,
    pub after: serde_json::Value,
}
