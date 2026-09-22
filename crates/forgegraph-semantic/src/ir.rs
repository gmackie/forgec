//! DomainIR: the package-level semantic model. Serialized deterministically;
//! see specs/ir/domain-ir.md. Every collection is sorted by name or stable id.

use serde::{Deserialize, Serialize};

pub const DOMAIN_IR_VERSION: &str = "domain-ir/1";

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DomainIR {
    pub version: String,
    pub package: PackageInfo,
    pub imports: Vec<Import>,
    pub modules: Vec<Module>,
    /// Critical features a consumer must understand (plan §4.2, fail closed): a reader that does
    /// not know one of these refuses the artifact instead of dropping semantics.
    #[serde(default)]
    pub requires: Vec<String>,
}

/// Features this compiler/runtime build understands. Unknown `requires` entries fail closed.
pub const KNOWN_FEATURES: &[&str] = &[
    "governance/1",
    "conditional-unique/1",
    "projection-aggregates/1",
    "collections/1",
    "workflow-map/1",
    "sequences/1",
    "work-queues/1",
    "credentials/1",
];

impl DomainIR {
    /// Load an IR produced by another build: version and critical features must be understood.
    pub fn load(v: &serde_json::Value) -> Result<DomainIR, String> {
        let version = v["version"].as_str().unwrap_or("");
        if version != DOMAIN_IR_VERSION {
            return Err(format!(
                "unsupported IR version `{version}` (this build reads {DOMAIN_IR_VERSION})"
            ));
        }
        let ir: DomainIR =
            serde_json::from_value(v.clone()).map_err(|e| format!("malformed IR: {e}"))?;
        if let Some(f) = ir
            .requires
            .iter()
            .find(|f| !KNOWN_FEATURES.contains(&f.as_str()))
        {
            return Err(format!(
                "IR requires unknown critical feature `{f}`; refusing to interpret it partially"
            ));
        }
        Ok(ir)
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PackageInfo {
    pub name: String,
    pub version: String,
    pub edition: String,
    pub profile: String,
    pub targets: Vec<String>,
    #[serde(default)]
    pub observability: ObservabilityConfig,
}

/// `[observability]` in forge.toml (plan §20): editable SLO targets per operation class, not
/// predicted performance.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ObservabilityConfig {
    pub window: String,
    /// class (`crud-read`, `crud-write`, `function`, ...) -> target
    pub slo: Vec<(String, SloTarget)>,
}
impl Default for ObservabilityConfig {
    fn default() -> Self {
        Self {
            window: "28d".into(),
            slo: vec![],
        }
    }
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SloTarget {
    pub availability: String,
    pub latency_good: String,
    pub latency_within: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Import {
    pub alias: String,
    pub package: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Module {
    pub id: String,
    pub enums: Vec<EnumDecl>,
    pub types: Vec<TypeAlias>,
    pub shapes: Vec<Shape>,
    /// Compile-time field templates, never runtime supertypes.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub facets: Vec<Shape>,
    /// Effective field anchor -> originating facet field anchor. No source paths.
    #[serde(default, skip_serializing_if = "std::collections::BTreeMap::is_empty")]
    pub facet_origins: std::collections::BTreeMap<String, String>,
    pub resources: Vec<Resource>,
    pub functions: Vec<Function>,
    pub channels: Vec<Channel>,
    pub sources: Vec<Source>,
    pub subscriptions: Vec<Subscription>,
    #[serde(default)]
    pub views: Vec<View>,
    #[serde(default)]
    pub projections: Vec<Projection>,
    #[serde(default)]
    pub caches: Vec<Cache>,
    #[serde(default)]
    pub workflows: Vec<Workflow>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub work_queues: Vec<WorkQueue>,
    /// Edition 2027 governance vocabulary (plan D07/D11): meaning, never authority.
    #[serde(default)]
    pub purposes: Vec<Purpose>,
    #[serde(default)]
    pub data_classes: Vec<DataClass>,
}

pub use crate::capability::{Atom, EffectiveCapabilities, Surface};
pub use crate::taxonomy::{DataSemantics, Lineage, Taxonomy};

/// `@subject(person)` — this record is about a subject of that kind; `@subject(from: field)` — it is about
/// the subject of the referenced record (a guardian relationship needs a concrete link, not a role string).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "binding", rename_all = "camelCase")]
pub enum SubjectBinding {
    Kind { kind: String },
    From { field: String },
}
impl SubjectBinding {
    #[allow(non_snake_case)]
    pub fn Kind(kind: impl Into<String>) -> Self {
        SubjectBinding::Kind { kind: kind.into() }
    }
    #[allow(non_snake_case)]
    pub fn From(field: impl Into<String>) -> Self {
        SubjectBinding::From {
            field: field.into(),
        }
    }
}

/// Intent context. `extends` is taxonomy meaning only; it grants no field or action authority.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Purpose {
    pub id: String,
    pub name: String,
    pub exported: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub doc: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub extends: Option<String>,
}

/// Classification facet: describes data, not access rights.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DataClass {
    pub id: String,
    pub name: String,
    pub exported: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub doc: Option<String>,
    /// Taxonomy parent (`data.contact.email`).
    pub extends: String,
}

/// Resource-local capability fragment (plan §8.2): grants union through `includes`; denials stay sticky.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Capability {
    pub name: String,
    pub includes: Vec<String>,
    pub atoms: Vec<CapabilityAtom>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CapabilityAtom {
    pub deny: bool,
    /// read | update | create | filter | order | actions
    pub verb: String,
    pub names: Vec<String>,
}

/// `for Purpose { use Capability }`: the only way a purpose acquires a resource surface.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PurposeBinding {
    pub purpose: String,
    pub capability: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkQueue {
    pub id: String,
    pub name: String,
    pub execute: String,
    pub lease_ms: u32,
    pub max_attempts: u32,
    pub max_tasks: u32,
    pub max_runners: u32,
}

/// Durable composition of capabilities with explicit control flow (plan §15).
/// Step ids are the declared step names: semantic identifiers, never positions.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Workflow {
    pub id: String,
    pub name: String,
    pub exported: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub doc: Option<String>,
    /// Pinned by in-flight instances; a deployment never reinterprets their graph.
    pub version: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub input: Option<TypeSpec>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub output: Option<TypeSpec>,
    pub errors: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub http: Option<HttpBinding>,
    pub steps: Vec<Step>,
    /// SHA-256 of the canonical step graph: equal hashes are compatible implementations.
    pub graph_hash: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Step {
    Map {
        id: String,
        binding: String,
        source: Expr,
        concurrency: u32,
        max_items: u32,
        call: Box<Step>,
    },
    Call {
        id: String,
        target: CallTarget,
        args: Vec<NamedArg>,
        catches: Vec<Catch>,
    },
    Sleep {
        id: String,
        duration: String,
    },
    Wait {
        id: String,
        channel: String,
        message: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        correlate: Option<Correlation>,
        #[serde(skip_serializing_if = "Option::is_none")]
        timeout: Option<Timeout>,
    },
    Choice {
        id: String,
        condition: Expr,
        then: Vec<Step>,
        otherwise: Vec<Step>,
    },
    Parallel {
        id: String,
        branches: Vec<Vec<Step>>,
    },
    Return {
        value: Expr,
    },
    Fail {
        error: String,
    },
}

impl Step {
    /// `kind:id` label used by tooling and tests.
    pub fn kind(&self) -> String {
        match self {
            Step::Map { id, .. } => format!("map:{id}"),
            Step::Call { id, .. } => format!("call:{id}"),
            Step::Sleep { id, .. } => format!("sleep:{id}"),
            Step::Wait { id, .. } => format!("wait:{id}"),
            Step::Choice { id, .. } => format!("choice:{id}"),
            Step::Parallel { id, .. } => format!("parallel:{id}"),
            Step::Return { .. } => "return".into(),
            Step::Fail { .. } => "fail".into(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum CallTarget {
    Function { function: String },
    Transition { resource: String, action: String },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NamedArg {
    pub name: String,
    pub value: Expr,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Catch {
    pub error: String,
    pub then: Terminal,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Correlation {
    pub field: String,
    pub value: Expr,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Timeout {
    pub duration: String,
    pub then: Terminal,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Terminal {
    Return { value: Expr },
    Fail { error: String },
}

/// A logical read-only query over declared data (plan §17): bounded, indexed, never a scan.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct View {
    pub id: String,
    pub name: String,
    pub exported: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub doc: Option<String>,
    pub source: String,
    pub by: Vec<String>,
    #[serde(rename = "where", skip_serializing_if = "Option::is_none")]
    pub filter: Option<Expr>,
    pub order: Vec<OrderKey>,
    pub fields: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub http: Option<HttpBinding>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Aggregate {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub filter: Option<Expr>,
    pub function: String,
    pub field: String,
    pub alias: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub scale: Option<u32>,
}

/// A persistent, rebuildable read model maintained from source change events (plan §17).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Projection {
    pub id: String,
    pub name: String,
    pub exported: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub doc: Option<String>,
    pub source: String,
    pub by: Vec<String>,
    #[serde(rename = "where", skip_serializing_if = "Option::is_none")]
    pub filter: Option<Expr>,
    pub aggregates: Vec<Aggregate>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub crud: Option<CrudBinding>,
}

/// A disposable value with an explicit loader and freshness contract (plan §16).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Cache {
    pub id: String,
    pub name: String,
    pub exported: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub doc: Option<String>,
    pub keys: Vec<Field>,
    pub loader: Expr,
    pub fresh_until: Expr,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stale_until: Option<Expr>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EnumDecl {
    pub id: String,
    pub name: String,
    pub exported: bool,
    pub synthesized: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub doc: Option<String>,
    pub members: Vec<EnumMember>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EnumMember {
    pub name: String,
    pub value: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub doc: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TypeAlias {
    pub id: String,
    pub name: String,
    pub exported: bool,
    #[serde(rename = "type")]
    pub ty: TypeSpec,
    /// Edition 2027: `@data(Class)`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub data_class: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TypeSpec {
    pub base: TypeBase,
    pub optional: bool,
    pub normalizers: Vec<String>,
    pub constraints: Vec<Constraint>,
    /// Edition 2027: `Record<Purpose>` — the purpose surface a record type is scoped to.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub purpose: Option<String>,
    /// Edition 2027: classification attached through `@data(Class)` on the field or its alias.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub data_class: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum TypeBase {
    Collection {
        collection: CollectionKind,
        element: Box<TypeSpec>,
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
    Reference {
        resource: String,
    },
    Record {
        resource: String,
    },
    Identity {
        resource: String,
    },
    Status {
        resource: String,
    },
    Message {
        channel: String,
        message: String,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum CollectionKind {
    List,
    Set,
    Map,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Constraint {
    Length {
        #[serde(skip_serializing_if = "Option::is_none")]
        min: Option<u64>,
        #[serde(skip_serializing_if = "Option::is_none")]
        max: Option<u64>,
    },
    Compare {
        op: String,
        value: Literal,
    },
    Pattern {
        value: String,
    },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", content = "value", rename_all = "camelCase")]
pub enum Literal {
    Int(String),
    Decimal(String),
    String(String),
    Bool(bool),
    Null,
    Duration(String),
    Percent(String),
    /// `Enum.Member`
    EnumMember {
        r#enum: String,
        member: String,
    },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Shape {
    pub id: String,
    pub name: String,
    pub exported: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub doc: Option<String>,
    pub fields: Vec<Field>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Field {
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub secret: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sequence: Option<Sequence>,
    pub name: String,
    #[serde(rename = "type")]
    pub ty: TypeSpec,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub default: Option<Literal>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub derived: Option<Expr>,
    pub immutable: bool,
    pub server_owned: bool,
    pub synthesized: bool,
    /// Stored but never exposed on the wire (internal bookkeeping such as upload staging state).
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub hidden: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub doc: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Sequence {
    pub partition: Option<String>,
    pub start: u64,
    pub max: u64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Expr {
    Binary {
        op: String,
        lhs: Box<Expr>,
        rhs: Box<Expr>,
    },
    Unary {
        op: String,
        operand: Box<Expr>,
    },
    Name {
        path: Vec<String>,
    },
    Literal {
        literal: Literal,
    },
    Call {
        callee: Vec<String>,
        args: Vec<Expr>,
    },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ResourceDecorators {
    pub tenant: bool,
    pub timestamps: bool,
    pub soft_delete: bool,
    pub versioned: bool,
    pub audited: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub crud: Option<CrudBinding>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub effective_dated: Option<EffectiveDated>,
    pub hierarchical: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
    /// Edition 2027: every interface exposes this resource through a purpose surface.
    #[serde(default)]
    pub purpose_scoped: bool,
    /// Edition 2027: who the record is about — a subject of a kind, or the subject of a referenced record.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub subject: Option<SubjectBinding>,
    /// Edition 2027: `@record(education | healthcare | employment | industrial | finance | organizational)`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub record_context: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CrudBinding {
    pub path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub operations: Option<Vec<String>>,
    /// Lifecycle actions explicitly published under `{path}/{id}/actions/<action>`.
    pub actions: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EffectiveDated {
    pub unique_by: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Resource {
    pub id: String,
    pub name: String,
    /// "resource" or "blob"
    pub kind: String,
    pub exported: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub doc: Option<String>,
    pub decorators: ResourceDecorators,
    pub fields: Vec<Field>,
    pub uniques: Vec<Unique>,
    pub finds: Vec<Find>,
    pub lists: Vec<List>,
    pub rules: Vec<Expr>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub lifecycle: Option<Lifecycle>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub content: Option<ContentPolicy>,
    pub operations: Vec<Operation>,
    #[serde(default)]
    pub capabilities: Vec<Capability>,
    #[serde(default)]
    pub purpose_bindings: Vec<PurposeBinding>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ContentPolicy {
    pub media_types: Vec<String>,
    pub max_bytes: u64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UniqueCondition {
    pub field: String,
    /// Canonical enum wire values. The predicate holds when the field matches any value.
    pub values: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Unique {
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub condition: Option<UniqueCondition>,
    pub fields: Vec<String>,
    pub within: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Find {
    pub name: String,
    pub fields: Vec<String>,
    pub covered_by: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct List {
    pub name: String,
    pub fields: Vec<String>,
    pub order: Vec<OrderKey>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OrderKey {
    pub field: String,
    pub direction: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Lifecycle {
    pub field: String,
    pub enum_id: String,
    pub states: Vec<String>,
    pub initial: String,
    pub terminals: Vec<String>,
    pub transitions: Vec<Transition>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Transition {
    pub action: String,
    pub from: Vec<String>,
    pub to: String,
    pub input: Vec<Field>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub doc: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Operation {
    pub id: String,
    pub kind: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub query: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub action: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub http: Option<HttpBinding>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HttpBinding {
    pub method: String,
    pub path: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Function {
    pub id: String,
    pub name: String,
    pub exported: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub doc: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub input: Option<TypeSpec>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub output: Option<TypeSpec>,
    pub uses: Vec<Use>,
    pub sends: Vec<Send>,
    pub errors: Vec<String>,
    pub slo: Vec<Slo>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub http: Option<HttpBinding>,
    /// True when the body is generated (CRUD, bare transitions); false means `impl/` must supply it.
    pub generated: bool,
    /// Edition 2027: the purpose this function runs under.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub purpose: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Use {
    Resource {
        resource: String,
        capability: String,
    },
    Transition {
        resource: String,
        action: String,
    },
    Function {
        function: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        purpose: Option<String>,
    },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Send {
    pub message: String,
    pub channel: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Slo {
    Availability {
        target: String,
        window: String,
    },
    Latency {
        target: String,
        within: String,
        window: String,
    },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Channel {
    pub id: String,
    pub name: String,
    pub exported: bool,
    /// Upstream contract identity when declared with `from`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub contract: Option<String>,
    pub distribution: String,
    pub delivery: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub direction: Option<String>,
    pub messages: Vec<Message>,
    /// Realtime profile (plan §19): outbound fan-out of this channel's messages over WebSocket.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub websocket: Option<WebSocketBinding>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WebSocketBinding {
    pub path: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Message {
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub doc: Option<String>,
    pub fields: Vec<Field>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Source {
    pub id: String,
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cron: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub timezone: Option<String>,
    pub target: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Subscription {
    pub channel: String,
    pub message: String,
    pub handler: String,
}

/// SHA-256 hex of arbitrary text (exposed so hosts can build composite identities).
pub fn hash_hex(text: &str) -> String {
    use sha2::Digest;
    hex::encode(sha2::Sha256::digest(text.as_bytes()))
}

impl DomainIR {
    pub fn find_resource(&self, id: &str) -> Option<&Resource> {
        self.modules
            .iter()
            .flat_map(|m| m.resources.iter())
            .find(|r| r.id == id)
    }
    pub fn find_channel(&self, id: &str) -> Option<&Channel> {
        self.modules
            .iter()
            .flat_map(|m| m.channels.iter())
            .find(|c| c.id == id)
    }
    pub fn find_function(&self, id: &str) -> Option<&Function> {
        self.modules
            .iter()
            .flat_map(|m| m.functions.iter())
            .find(|c| c.id == id)
    }
    pub fn find_shape(&self, id: &str) -> Option<&Shape> {
        self.modules
            .iter()
            .flat_map(|m| m.shapes.iter())
            .find(|c| c.id == id)
    }
    pub fn find_enum(&self, id: &str) -> Option<&EnumDecl> {
        self.modules
            .iter()
            .flat_map(|m| m.enums.iter())
            .find(|c| c.id == id)
    }
    /// Content hash of the canonical serialization.
    pub fn content_hash(&self) -> String {
        use sha2::Digest;
        let bytes = serde_json::to_vec(self).expect("serialize");
        hex::encode(sha2::Sha256::digest(bytes))
    }

    /// FORGE-029: domain-separated digests. `source` covers everything; `wire` the operation/value
    /// contracts (no docs, no governance); `docs` documentation only; `security` the governance
    /// surface (classification, purposes, capabilities, bindings, subjects) plus the wire field set.
    pub fn digests(&self) -> Digests {
        use sha2::Digest;
        // Canonical form: object keys sorted (the IR serializer preserves declaration order, which is
        // not part of the contract), arrays kept ordered.
        let h = |domain: &str, v: &serde_json::Value| {
            hex::encode(sha2::Sha256::digest(
                format!(
                    "forge:{domain}:{}",
                    serde_json::to_string(&canonical(v)).expect("serialize")
                )
                .as_bytes(),
            ))
        };
        let full = serde_json::to_value(self).expect("serialize");
        let mut wire = full.clone();
        strip_keys(
            &mut wire,
            &[
                "doc",
                "label",
                "purposes",
                "dataClasses",
                "capabilities",
                "purposeBindings",
                "purposeScoped",
                "subject",
                "dataClass",
                "purpose",
            ],
        );
        let mut docs = serde_json::Value::Array(vec![]);
        collect_keys(&full, "doc", &mut docs);
        let mut security = full.clone();
        strip_keys(&mut security, &["doc", "label"]);
        Digests {
            source: h("source", &full),
            wire: h("wire", &wire),
            docs: h("docs", &docs),
            security: h("security", &security),
        }
    }
}

/// Separate semantic digests (plan §4.3).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Digests {
    pub source: String,
    pub wire: String,
    pub docs: String,
    pub security: String,
}

fn canonical(v: &serde_json::Value) -> serde_json::Value {
    match v {
        serde_json::Value::Object(m) => {
            let mut keys: Vec<&String> = m.keys().collect();
            keys.sort();
            let mut out = serde_json::Map::new();
            for k in keys {
                out.insert(k.clone(), canonical(&m[k]));
            }
            serde_json::Value::Object(out)
        }
        serde_json::Value::Array(a) => serde_json::Value::Array(a.iter().map(canonical).collect()),
        other => other.clone(),
    }
}

fn strip_keys(v: &mut serde_json::Value, keys: &[&str]) {
    match v {
        serde_json::Value::Object(m) => {
            for k in keys {
                m.remove(*k);
            }
            for x in m.values_mut() {
                strip_keys(x, keys);
            }
        }
        serde_json::Value::Array(a) => a.iter_mut().for_each(|x| strip_keys(x, keys)),
        _ => {}
    }
}
fn collect_keys(v: &serde_json::Value, key: &str, out: &mut serde_json::Value) {
    match v {
        serde_json::Value::Object(m) => {
            if let Some(d) = m.get(key) {
                out.as_array_mut().unwrap().push(d.clone());
            }
            m.values().for_each(|x| collect_keys(x, key, out));
        }
        serde_json::Value::Array(a) => a.iter().for_each(|x| collect_keys(x, key, out)),
        _ => {}
    }
}
