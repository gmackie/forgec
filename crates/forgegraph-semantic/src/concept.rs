//! L0 business contracts. Projection evidence is separate from semantic identity.
use crate::ir::{self, DomainIR, Expr};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};

pub const CONCEPT_IR_VERSION: &str = "concept-ir/1";

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ConceptIR {
    pub version: String,
    /// Package identity only: provider targets and runtime profile are L1.
    pub package: String,
    pub entities: BTreeMap<String, Entity>,
    pub facts: BTreeMap<String, Fact>,
    pub externals: BTreeMap<String, External>,
    pub principals: BTreeMap<String, Principal>,
    pub policies: BTreeMap<String, Policy>,
    pub processes: BTreeMap<String, Process>,
    pub purposes: BTreeMap<String, ir::Purpose>,
    pub data_classes: BTreeMap<String, ir::DataClass>,
    pub shapes: BTreeMap<String, BTreeMap<String, Field>>,
    pub enums: BTreeMap<String, BTreeSet<String>>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Entity {
    pub name: String,
    pub fields: BTreeMap<String, Field>,
    pub invariants: Vec<ir::Unique>,
    pub lifecycle: Option<ir::Lifecycle>,
    pub subject: Option<ir::SubjectBinding>,
    pub record_context: Option<String>,
    pub purpose_scoped: bool,
    /// Existing static capability ceiling, not a replacement ABAC system.
    pub capabilities: Vec<ir::Capability>,
    pub purpose_bindings: Vec<ir::PurposeBinding>,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Fact {
    pub name: String,
    pub fields: BTreeMap<String, Field>,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Field {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sequence: Option<ir::Sequence>,
    pub ty: ConceptType,
    pub immutable: bool,
    pub default: Option<ir::Literal>,
    pub derived: Option<Expr>,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ConceptType {
    pub base: Type,
    pub optional: bool,
    pub constraints: Vec<ir::Constraint>,
    pub normalizers: Vec<String>,
    pub data_class: Option<String>,
    pub purpose: Option<String>,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase", deny_unknown_fields)]
pub enum Type {
    Collection {
        collection: ir::CollectionKind,
        element: Box<ConceptType>,
    },
    Scalar {
        name: String,
        args: Vec<String>,
    },
    Enum {
        id: String,
    },
    Shape {
        id: String,
    },
    Entity {
        id: String,
        representation: EntityRepresentation,
    },
    Fact {
        id: String,
    },
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum EntityRepresentation {
    Reference,
    Record,
    Identity,
    Status,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct External {
    pub name: String,
    pub data: BTreeMap<String, ConceptType>,
    pub events: BTreeSet<String>,
    pub accepts: BTreeMap<String, ConceptType>,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Principal {
    pub name: String,
    pub attributes: BTreeMap<String, ConceptType>,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Policy {
    pub name: String,
    pub principal: String,
    pub resource: ConceptType,
    pub purpose: Option<String>,
    pub required_attributes: BTreeSet<String>,
    pub effect: PolicyEffect,
    pub predicate: Expr,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum PolicyEffect {
    Permit,
    Deny,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Authorization {
    pub policy: String,
    pub mode: AuthorizationMode,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum AuthorizationMode {
    RequireAll,
    FilterVisible,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Process {
    pub name: String,
    pub purpose: Option<String>,
    pub principal: Option<String>,
    pub authorizations: Vec<Authorization>,
    pub activations: BTreeMap<String, Activation>,
    pub inputs: BTreeMap<String, ProcessInput>,
    pub outputs: BTreeMap<String, ProcessOutput>,
    pub behavior: Option<Behavior>,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase", deny_unknown_fields)]
pub enum Activation {
    Request {
        payload: Option<ConceptType>,
    },
    Fact {
        fact: String,
    },
    Change {
        entity: String,
    },
    ExternalEvent {
        external: String,
        event: String,
    },
    Schedule {
        expression: String,
        timezone: Option<String>,
    },
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ProcessInput {
    pub ty: ConceptType,
    pub origin: InputOrigin,
    pub selection: Selection,
    pub authorization: Option<Authorization>,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase", deny_unknown_fields)]
pub enum InputOrigin {
    Internal,
    External { external: String },
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Selection {
    /// Unknown is essential when projecting a permission to read into a possible dependency.
    pub cardinality: Cardinality,
    pub for_binding: Option<String>,
    pub predicate: Option<Expr>,
    pub during: Option<String>,
    pub as_of: Option<Expr>,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Cardinality {
    One,
    Optional,
    Many,
    Latest,
    Unknown,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ProcessOutput {
    pub ty: ConceptType,
    pub disposition: OutputDisposition,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase", deny_unknown_fields)]
pub enum OutputDisposition {
    ProduceEntity,
    EmitFact,
    Return,
    Export { external: String },
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase", deny_unknown_fields)]
pub enum Behavior {
    /// A partial set of business waits; ordering/control flow is explicitly unknown in projection.
    Workflow {
        waits: BTreeMap<String, String>,
    },
    StateMachine {
        entity: String,
        lifecycle: ir::Lifecycle,
    },
    Stateful {
        state: ConceptType,
    },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Projection {
    pub concept: ConceptIR,
    /// L0 anchor -> source/L1 anchor. Kept outside the ConceptIR hash.
    pub realizations: BTreeMap<String, String>,
    pub coverage: BTreeMap<String, BTreeSet<String>>,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Violation {
    pub code: String,
    pub subject: String,
    pub message: String,
}

/// Transport-free graph for documentation and editor consumers. Ports identify edges.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Graph {
    pub nodes: BTreeMap<String, String>,
    pub edges: BTreeSet<Edge>,
}
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
pub struct Edge {
    pub from: String,
    pub to: String,
    pub port: String,
    pub kind: String,
}
fn type_id(ty: &ConceptType) -> Option<&str> {
    match &ty.base {
        Type::Entity { id, .. } | Type::Fact { id } | Type::Shape { id } | Type::Enum { id } => {
            Some(id)
        }
        Type::Scalar { .. } | Type::Collection { .. } => None,
    }
}
impl ConceptIR {
    pub fn graph(&self) -> Graph {
        let mut graph = Graph {
            nodes: BTreeMap::new(),
            edges: BTreeSet::new(),
        };
        for (kind, ids) in [
            ("entity", self.entities.keys().collect::<Vec<_>>()),
            ("fact", self.facts.keys().collect()),
            ("external", self.externals.keys().collect()),
            ("principal", self.principals.keys().collect()),
            ("policy", self.policies.keys().collect()),
            ("process", self.processes.keys().collect()),
        ] {
            for id in ids {
                graph.nodes.insert(id.clone(), kind.into());
            }
        }
        for (id, process) in &self.processes {
            let mut edge = |from: &str, to: &str, port: &str, kind: &str| {
                graph.nodes.entry(from.into()).or_insert("reference".into());
                graph.nodes.entry(to.into()).or_insert("reference".into());
                graph.edges.insert(Edge {
                    from: from.into(),
                    to: to.into(),
                    port: port.into(),
                    kind: kind.into(),
                });
            };
            if let Some(Behavior::Workflow { waits }) = &process.behavior {
                for (port, fact) in waits {
                    edge(fact, id, port, "wait");
                }
            }
            for (port, input) in &process.inputs {
                if let Some(data) = type_id(&input.ty) {
                    edge(data, id, port, "input");
                }
                if let InputOrigin::External { external } = &input.origin {
                    edge(external, id, port, "acquire");
                }
            }
            for (port, activation) in &process.activations {
                match activation {
                    Activation::Fact { fact } => edge(fact, id, port, "activate"),
                    Activation::Change { entity } => edge(entity, id, port, "activate"),
                    Activation::ExternalEvent { external, .. } => {
                        edge(external, id, port, "activate")
                    }
                    _ => {}
                }
            }
            for (port, output) in &process.outputs {
                let kind = match &output.disposition {
                    OutputDisposition::ProduceEntity => "produce",
                    OutputDisposition::EmitFact => "emit",
                    OutputDisposition::Return => "return",
                    OutputDisposition::Export { .. } => "export",
                };
                if let Some(data) = type_id(&output.ty) {
                    edge(id, data, port, kind);
                }
                if let OutputDisposition::Export { external } = &output.disposition {
                    edge(id, external, port, "export");
                }
            }
        }
        graph
    }
    pub fn canonical_json(&self) -> String {
        serde_json::to_string(self).expect("ConceptIR serialization")
    }
    pub fn content_hash(&self) -> String {
        ir::hash_hex(&self.canonical_json())
    }
    pub fn load(value: &serde_json::Value) -> Result<Self, String> {
        let concept: Self = serde_json::from_value(value.clone()).map_err(|e| e.to_string())?;
        if concept.version != CONCEPT_IR_VERSION {
            return Err(format!("unsupported ConceptIR version {}", concept.version));
        }
        let errors = concept.validate();
        if !errors.is_empty() {
            return Err(serde_json::to_string(&errors).unwrap());
        }
        Ok(concept)
    }
    /// Authoritative producer ownership applies only to explicit produce/emit contracts.
    /// Legacy permissions are not proof of ownership and are never turned into producers.
    pub fn validate(&self) -> Vec<Violation> {
        let mut errors = vec![];
        let mut producers: BTreeMap<String, BTreeSet<String>> = BTreeMap::new();
        for (id, process) in &self.processes {
            let mut missing = |subject: &str, family: &str, target: &str| {
                errors.push(Violation {
                    code: "E-L0-REFERENCE".into(),
                    subject: subject.into(),
                    message: format!("unknown {family} `{target}`"),
                })
            };
            if let Some(principal) = &process.principal
                && !self.principals.contains_key(principal)
            {
                missing(id, "principal", principal);
            }
            for authorization in process.authorizations.iter().chain(
                process
                    .inputs
                    .values()
                    .filter_map(|i| i.authorization.as_ref()),
            ) {
                if !self.policies.contains_key(&authorization.policy) {
                    missing(id, "policy", &authorization.policy);
                }
            }
            for (port, input) in &process.inputs {
                if let InputOrigin::External { external } = &input.origin
                    && !self.externals.contains_key(external)
                {
                    missing(port, "external", external);
                }
            }
            for (port, output) in &process.outputs {
                if let OutputDisposition::Export { external } = &output.disposition
                    && !self.externals.contains_key(external)
                {
                    missing(port, "external", external);
                }
            }
            for (port, activation) in &process.activations {
                if let Activation::ExternalEvent { external, .. } = activation
                    && !self.externals.contains_key(external)
                {
                    missing(port, "external", external);
                }
            }
            for (port, output) in &process.outputs {
                let target = match (&output.disposition, &output.ty.base) {
                    (OutputDisposition::ProduceEntity, Type::Entity { id, .. })
                        if self.entities.contains_key(id) =>
                    {
                        Some(id)
                    }
                    (OutputDisposition::EmitFact, Type::Fact { id })
                        if self.facts.contains_key(id) =>
                    {
                        Some(id)
                    }
                    (OutputDisposition::ProduceEntity | OutputDisposition::EmitFact, _) => {
                        errors.push(Violation { code: "E-L0-OUTPUT".into(), subject: port.clone(), message: "durable output must reference a declared entity/fact of the matching kind".into() });
                        None
                    }
                    _ => None,
                };
                if let Some(target) = target {
                    producers
                        .entry(target.clone())
                        .or_default()
                        .insert(id.clone());
                }
            }
        }
        for (id, policy) in &self.policies {
            if !self.principals.contains_key(&policy.principal) {
                errors.push(Violation {
                    code: "E-L0-REFERENCE".into(),
                    subject: id.clone(),
                    message: format!("unknown principal `{}`", policy.principal),
                });
            }
        }
        for (subject, owners) in producers {
            if owners.len() > 1 {
                errors.push(Violation {
                    code: "E-L0-PRODUCER".into(),
                    subject,
                    message: format!(
                        "multiple authoritative logical producers: {}",
                        owners.into_iter().collect::<Vec<_>>().join(", ")
                    ),
                });
            }
        }
        errors
    }
    /// Conservative checking of the supported projection: equality is required for claimed
    /// contracts. This is not a proof about handwritten implementations or unknown semantics.
    pub fn check_realization(&self, realization: &DomainIR) -> Vec<Violation> {
        let actual = project(realization).concept;
        let expected = serde_json::to_value(self).unwrap();
        let actual = serde_json::to_value(actual).unwrap();
        expected
            .as_object()
            .unwrap()
            .iter()
            .filter(|(key, value)| actual.get(*key) != Some(*value))
            .map(|(key, _)| Violation {
                code: "E-L0-REALIZATION".into(),
                subject: key.clone(),
                message: "realization projection differs from the required concept contract".into(),
            })
            .collect()
    }
}

fn fact_id(channel: &str, message: &str) -> String {
    format!("{channel}#fact:{message}")
}
fn ty(t: &ir::TypeSpec) -> ConceptType {
    let base = match &t.base {
        ir::TypeBase::Collection {
            collection,
            element,
        } => Type::Collection {
            collection: *collection,
            element: Box::new(ty(element)),
        },
        ir::TypeBase::Scalar { name, args } => Type::Scalar {
            name: name.clone(),
            args: args.clone(),
        },
        ir::TypeBase::Enum { id } => Type::Enum { id: id.clone() },
        ir::TypeBase::Shape { id } => Type::Shape { id: id.clone() },
        ir::TypeBase::Reference { resource } => Type::Entity {
            id: resource.clone(),
            representation: EntityRepresentation::Reference,
        },
        ir::TypeBase::Record { resource } => Type::Entity {
            id: resource.clone(),
            representation: EntityRepresentation::Record,
        },
        ir::TypeBase::Identity { resource } => Type::Entity {
            id: resource.clone(),
            representation: EntityRepresentation::Identity,
        },
        ir::TypeBase::Status { resource } => Type::Entity {
            id: resource.clone(),
            representation: EntityRepresentation::Status,
        },
        ir::TypeBase::Message { channel, message } => Type::Fact {
            id: fact_id(channel, message),
        },
    };
    ConceptType {
        base,
        optional: t.optional,
        constraints: t.constraints.clone(),
        normalizers: t.normalizers.clone(),
        data_class: t.data_class.clone(),
        purpose: t.purpose.clone(),
    }
}
fn fields(source: &[ir::Field]) -> BTreeMap<String, Field> {
    source
        .iter()
        .filter(|f| !f.hidden && !f.synthesized)
        .map(|f| {
            (
                f.name.clone(),
                Field {
                    ty: ty(&f.ty),
                    immutable: f.immutable,
                    default: f.default.clone(),
                    derived: f.derived.clone(),
                    sequence: f.sequence.clone(),
                },
            )
        })
        .collect()
}
fn process(
    name: &str,
    input: Option<&ir::TypeSpec>,
    output: Option<&ir::TypeSpec>,
    request: bool,
    id: &str,
) -> Process {
    let mut p = Process {
        name: name.into(),
        purpose: None,
        principal: None,
        authorizations: vec![],
        activations: BTreeMap::new(),
        inputs: BTreeMap::new(),
        outputs: BTreeMap::new(),
        behavior: None,
    };
    if request {
        p.activations.insert(
            format!("{id}#activation:request"),
            Activation::Request {
                payload: input.map(ty),
            },
        );
    }
    if let Some(input) = input {
        p.inputs.insert(
            format!("{id}#input:input"),
            ProcessInput {
                ty: ty(input),
                origin: InputOrigin::Internal,
                selection: Selection {
                    cardinality: if input.optional {
                        Cardinality::Optional
                    } else {
                        Cardinality::One
                    },
                    for_binding: None,
                    predicate: None,
                    during: None,
                    as_of: None,
                },
                authorization: None,
            },
        );
    }
    if let Some(output) = output {
        p.outputs.insert(
            format!("{id}#output:return"),
            ProcessOutput {
                ty: ty(output),
                disposition: OutputDisposition::Return,
            },
        );
    }
    p
}

/// Conservative legacy projection. No guessed logical owners, ABAC, external systems, or
/// execution-derived read selections. Every omitted family is visible in coverage.
pub fn project(ir: &DomainIR) -> Projection {
    let mut out = Projection {
        concept: ConceptIR {
            version: CONCEPT_IR_VERSION.into(),
            package: ir.package.name.clone(),
            entities: BTreeMap::new(),
            facts: BTreeMap::new(),
            externals: BTreeMap::new(),
            principals: BTreeMap::new(),
            policies: BTreeMap::new(),
            processes: BTreeMap::new(),
            purposes: BTreeMap::new(),
            data_classes: BTreeMap::new(),
            shapes: BTreeMap::new(),
            enums: BTreeMap::new(),
        },
        realizations: BTreeMap::new(),
        coverage: BTreeMap::new(),
    };
    out.coverage.insert(
        ir.package.name.clone(),
        [
            "partial legacy projection",
            "unknown logical producers",
            "unknown external boundaries and principals/ABAC",
            "resource CRUD ownership is not inferred",
            "read selections and implementation dataflow are not inferred",
        ]
        .map(String::from)
        .into(),
    );
    for module in &ir.modules {
        for r in &module.resources {
            out.concept.entities.insert(
                r.id.clone(),
                Entity {
                    name: r.name.clone(),
                    fields: fields(&r.fields),
                    lifecycle: r.lifecycle.clone(),
                    invariants: r.uniques.clone(),
                    subject: r.decorators.subject.clone(),
                    record_context: r.decorators.record_context.clone(),
                    purpose_scoped: r.decorators.purpose_scoped,
                    capabilities: r.capabilities.clone(),
                    purpose_bindings: r.purpose_bindings.clone(),
                },
            );
            out.realizations.insert(r.id.clone(), r.id.clone());
        }
        for shape in &module.shapes {
            out.concept
                .shapes
                .insert(shape.id.clone(), fields(&shape.fields));
        }
        for e in &module.enums {
            out.concept.enums.insert(
                e.id.clone(),
                e.members.iter().map(|m| m.name.clone()).collect(),
            );
        }
        for p in &module.purposes {
            out.concept.purposes.insert(p.id.clone(), p.clone());
        }
        for d in &module.data_classes {
            out.concept.data_classes.insert(d.id.clone(), d.clone());
        }
        for c in &module.channels {
            for message in &c.messages {
                let id = fact_id(c.contract.as_deref().unwrap_or(&c.id), &message.name);
                out.concept.facts.insert(
                    id.clone(),
                    Fact {
                        name: message.name.clone(),
                        fields: fields(&message.fields),
                    },
                );
                out.realizations
                    .insert(id.clone(), format!("{}#message:{}", c.id, message.name));
                out.coverage.insert(
                    id,
                    [
                        "synthesized fact identity retains legacy contract namespace",
                        "message contract does not prove immutable business occurrence",
                    ]
                    .map(String::from)
                    .into(),
                );
            }
        }
        for f in &module.functions {
            let mut p = process(
                &f.name,
                f.input.as_ref(),
                f.output.as_ref(),
                f.http.is_some(),
                &f.id,
            );
            p.purpose = f.purpose.clone();
            out.concept.processes.insert(f.id.clone(), p);
            out.realizations.insert(f.id.clone(), f.id.clone());
            out.coverage.insert(f.id.clone(), ["declared signature only; uses/sends are permissions, not proven consumption/production".into()].into());
        }
        for w in &module.workflows {
            let mut p = process(
                &w.name,
                w.input.as_ref(),
                w.output.as_ref(),
                w.http.is_some(),
                &w.id,
            );
            let mut waits = BTreeMap::new();
            collect_waits(&w.steps, &w.id, &mut waits);
            p.behavior = Some(Behavior::Workflow { waits });
            out.concept.processes.insert(w.id.clone(), p);
            out.realizations.insert(w.id.clone(), w.id.clone());
            out.coverage.insert(w.id.clone(), ["workflow waits are candidates; business significance, ordering, conditions and correlation are not inferred".into()].into());
        }
    }
    for module in &ir.modules {
        for s in &module.subscriptions {
            if let Some(p) = out.concept.processes.get_mut(&s.handler) {
                let fact = fact_id(&s.channel, &s.message);
                p.activations.insert(
                    format!("{}#activation:{fact}", s.handler),
                    Activation::Fact { fact },
                );
            }
        }
        for s in &module.sources {
            if let Some(p) = out.concept.processes.get_mut(&s.target)
                && let Some(cron) = &s.cron
            {
                p.activations.insert(
                    format!("{}#activation:{}", s.target, s.id),
                    Activation::Schedule {
                        expression: cron.clone(),
                        timezone: s.timezone.clone(),
                    },
                );
            }
        }
    }
    for (id, process) in &out.concept.processes {
        for port in process
            .inputs
            .keys()
            .chain(process.outputs.keys())
            .chain(process.activations.keys())
        {
            out.realizations
                .entry(port.clone())
                .or_insert_with(|| id.clone());
        }
        if let Some(Behavior::Workflow { waits }) = &process.behavior {
            for port in waits.keys() {
                out.realizations.insert(port.clone(), port.clone());
            }
        }
    }
    out
}
fn collect_waits(steps: &[ir::Step], workflow: &str, waits: &mut BTreeMap<String, String>) {
    for step in steps {
        match step {
            ir::Step::Wait {
                id,
                channel,
                message,
                ..
            } => {
                waits.insert(format!("{workflow}#step:{id}"), fact_id(channel, message));
            }
            ir::Step::Choice {
                then, otherwise, ..
            } => {
                collect_waits(then, workflow, waits);
                collect_waits(otherwise, workflow, waits);
            }
            ir::Step::Parallel { branches, .. } => {
                for branch in branches {
                    collect_waits(branch, workflow, waits);
                }
            }
            _ => {}
        }
    }
}
