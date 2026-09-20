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
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PackageInfo {
    pub name: String,
    pub version: String,
    pub edition: String,
    pub profile: String,
    pub targets: Vec<String>,
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
    Call { id: String, target: CallTarget, args: Vec<NamedArg>, catches: Vec<Catch> },
    Sleep { id: String, duration: String },
    Wait { id: String, channel: String, message: String, #[serde(skip_serializing_if = "Option::is_none")] correlate: Option<Correlation>, #[serde(skip_serializing_if = "Option::is_none")] timeout: Option<Timeout> },
    Choice { id: String, condition: Expr, then: Vec<Step>, otherwise: Vec<Step> },
    Parallel { id: String, branches: Vec<Vec<Step>> },
    Return { value: Expr },
    Fail { error: String },
}

impl Step {
    /// `kind:id` label used by tooling and tests.
    pub fn kind(&self) -> String {
        match self {
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
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TypeSpec {
    pub base: TypeBase,
    pub optional: bool,
    pub normalizers: Vec<String>,
    pub constraints: Vec<Constraint>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum TypeBase {
    Scalar { name: String, args: Vec<String> },
    Enum { id: String },
    Shape { id: String },
    Reference { resource: String },
    Record { resource: String },
    Identity { resource: String },
    Status { resource: String },
    Message { channel: String, message: String },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Constraint {
    Length { #[serde(skip_serializing_if = "Option::is_none")] min: Option<u64>, #[serde(skip_serializing_if = "Option::is_none")] max: Option<u64> },
    Compare { op: String, value: Literal },
    Pattern { value: String },
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
    EnumMember { r#enum: String, member: String },
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
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Expr {
    Binary { op: String, lhs: Box<Expr>, rhs: Box<Expr> },
    Unary { op: String, operand: Box<Expr> },
    Name { path: Vec<String> },
    Literal { literal: Literal },
    Call { callee: Vec<String>, args: Vec<Expr> },
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
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ContentPolicy {
    pub media_types: Vec<String>,
    pub max_bytes: u64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Unique {
    pub name: String,
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
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Use {
    Resource { resource: String, capability: String },
    Transition { resource: String, action: String },
    Function { function: String },
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
    Availability { target: String, window: String },
    Latency { target: String, within: String, window: String },
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
        self.modules.iter().flat_map(|m| m.resources.iter()).find(|r| r.id == id)
    }
    pub fn find_channel(&self, id: &str) -> Option<&Channel> {
        self.modules.iter().flat_map(|m| m.channels.iter()).find(|c| c.id == id)
    }
    pub fn find_function(&self, id: &str) -> Option<&Function> {
        self.modules.iter().flat_map(|m| m.functions.iter()).find(|c| c.id == id)
    }
    pub fn find_shape(&self, id: &str) -> Option<&Shape> {
        self.modules.iter().flat_map(|m| m.shapes.iter()).find(|c| c.id == id)
    }
    pub fn find_enum(&self, id: &str) -> Option<&EnumDecl> {
        self.modules.iter().flat_map(|m| m.enums.iter()).find(|c| c.id == id)
    }
    /// Content hash of the canonical serialization.
    pub fn content_hash(&self) -> String {
        use sha2::Digest;
        let bytes = serde_json::to_vec(self).expect("serialize");
        hex::encode(sha2::Sha256::digest(bytes))
    }
}
