//! Target-independent public contracts: record/create/patch schemas per
//! resource, operations with HTTP bindings, lifecycle actions, functions.

use crate::naming;
use forge_semantic::ir::*;
use serde::Serialize;
use serde_json::{json, Value};

pub const CONTRACTS_VERSION: &str = "contracts/1";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Contracts {
    pub version: String,
    pub package: String,
    pub resources: Vec<ResourceContract>,
    pub functions: Vec<FunctionContract>,
    pub views: Vec<ViewContract>,
    pub projections: Vec<ProjectionContract>,
    pub caches: Vec<CacheContract>,
    pub workflows: Vec<WorkflowContract>,
}

/// A durable workflow (plan §15): `POST {start}` (the `@http` binding or `{path}`), `GET {path}/{id}`,
/// `POST {path}/{id}/cancel`, `POST {path}/signals/{message}` with `{ messageId, payload }`.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowContract {
    pub id: String,
    pub name: String,
    pub version: u32,
    pub graph_hash: String,
    pub errors: Vec<String>,
    /// Messages the workflow waits on: (channel id, message name).
    pub signals: Vec<(String, String)>,
    pub start: HttpBinding,
    pub path: String,
}

/// A bounded read-only query (plan §17): `GET {http.path}?<params>&limit&cursor`.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ViewContract {
    pub id: String,
    pub name: String,
    pub source: String,
    pub params: Vec<String>,
    pub record: JsonSchema,
    pub order: Vec<OrderKey>,
    pub http: HttpBinding,
}

/// A rebuildable read model (plan §17): `GET {path}/{id}`, `GET {path}/status`, `POST {path}/rebuild`.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectionContract {
    pub id: String,
    pub name: String,
    pub source: String,
    pub by: Vec<String>,
    pub record: JsonSchema,
    pub path: String,
}

/// A cache reader (plan §16): `GET {http.path}?<keys>` returns `{ value, source, freshUntil }`.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CacheContract {
    pub id: String,
    pub name: String,
    pub keys: Vec<String>,
    /// Resource whose record (or null) is the cached value, when the loader is `<Resource>.effective(...)`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub value_resource: Option<String>,
    pub http: HttpBinding,
}

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct JsonSchema {
    #[serde(rename = "type")]
    pub ty: String,
    pub properties: indexmap::IndexMap<String, Value>,
    pub required: Vec<String>,
    pub additional_properties: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResourceContract {
    pub id: String,
    pub name: String,
    pub wire_name: String,
    pub tenant_scoped: bool,
    pub soft_delete: bool,
    pub versioned: bool,
    pub record: JsonSchema,
    pub create: JsonSchema,
    pub patch: JsonSchema,
    pub queries: Vec<QueryContract>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub lifecycle: Option<LifecycleContract>,
    pub operations: Vec<Operation>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QueryContract {
    pub name: String,
    pub kind: String,
    pub params: Vec<String>,
    pub order: Vec<OrderKey>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LifecycleContract {
    pub field: String,
    pub states: Vec<String>,
    pub initial: String,
    pub actions: Vec<ActionContract>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ActionContract {
    pub name: String,
    pub from: Vec<String>,
    pub to: String,
    pub input: JsonSchema,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FunctionContract {
    pub id: String,
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub http: Option<HttpBinding>,
    pub errors: Vec<String>,
    pub generated: bool,
}

pub fn plan(ir: &DomainIR) -> Contracts {
    let mut resources = Vec::new();
    let mut functions = Vec::new();
    let mut views = Vec::new();
    let mut projections = Vec::new();
    let mut caches = Vec::new();
    let mut workflows = Vec::new();
    let find_resource = |id: &str| ir.modules.iter().flat_map(|m| &m.resources).find(|r| r.id == id);
    for m in &ir.modules {
        for r in &m.resources {
            resources.push(resource(ir, r));
        }
        for f in &m.functions {
            functions.push(FunctionContract { id: f.id.clone(), name: f.name.clone(), http: f.http.clone(), errors: f.errors.clone(), generated: f.generated });
        }
        for v in &m.views {
            let src = find_resource(&v.source).map(|r| resource(ir, r));
            let mut record = JsonSchema { ty: "object".into(), ..Default::default() };
            for f in &v.fields {
                let schema = src.as_ref().and_then(|s| s.record.properties.get(f).cloned()).unwrap_or(json!({ "type": "string" }));
                record.properties.insert(f.clone(), schema);
                record.required.push(f.clone());
            }
            views.push(ViewContract {
                id: v.id.clone(),
                name: v.name.clone(),
                source: v.source.clone(),
                params: v.by.clone(),
                record,
                order: v.order.clone(),
                http: HttpBinding { method: "GET".into(), path: format!("/v1/views/{}", naming::kebab(&v.name)) },
            });
        }
        for p in &m.projections {
            let src = find_resource(&p.source).map(|r| resource(ir, r));
            let mut record = JsonSchema { ty: "object".into(), ..Default::default() };
            for f in &p.by {
                let schema = src.as_ref().and_then(|s| s.record.properties.get(f).cloned()).unwrap_or(json!({ "type": "string" }));
                record.properties.insert(f.clone(), schema);
                record.required.push(f.clone());
            }
            for a in &p.aggregates {
                let schema = match (a.function.as_str(), a.scale) {
                    ("count", _) => json!({ "type": "integer", "x-forge-type": "integer" }),
                    (_, Some(scale)) => json!({ "type": "string", "x-forge-type": "decimal", "x-forge-scale": scale }),
                    _ => src.as_ref().and_then(|s| s.record.properties.get(&a.field).cloned()).unwrap_or(json!({ "type": "number" })),
                };
                record.properties.insert(a.alias.clone(), schema);
                record.required.push(a.alias.clone());
            }
            record.properties.insert("generation".into(), json!({ "type": "integer", "x-forge-type": "integer" }));
            record.required.push("generation".into());
            projections.push(ProjectionContract {
                id: p.id.clone(),
                name: p.name.clone(),
                source: p.source.clone(),
                by: p.by.clone(),
                record,
                path: p.crud.as_ref().map(|c| c.path.clone()).unwrap_or_else(|| format!("/v1/projections/{}", naming::kebab(&p.name))),
            });
        }
        for w in &m.workflows {
            let path = format!("/v1/workflows/{}", naming::kebab(&w.name));
            let mut signals = Vec::new();
            collect_signals(&w.steps, &mut signals);
            workflows.push(WorkflowContract {
                id: w.id.clone(),
                name: w.name.clone(),
                version: w.version,
                graph_hash: w.graph_hash.clone(),
                errors: w.errors.clone(),
                signals,
                start: w.http.clone().unwrap_or_else(|| HttpBinding { method: "POST".into(), path: path.clone() }),
                path,
            });
        }
        for c in &m.caches {
            let value_resource = match &c.loader {
                Expr::Call { callee, .. } if callee.len() == 2 && callee[1] == "effective" => ir.modules.iter().flat_map(|m| &m.resources).find(|r| r.name == callee[0]).map(|r| r.name.clone()),
                _ => None,
            };
            caches.push(CacheContract {
                id: c.id.clone(),
                name: c.name.clone(),
                keys: c.keys.iter().map(|k| k.name.clone()).collect(),
                value_resource,
                http: HttpBinding { method: "GET".into(), path: format!("/v1/caches/{}", naming::kebab(&c.name)) },
            });
        }
    }
    Contracts { version: CONTRACTS_VERSION.into(), package: ir.package.name.clone(), resources, functions, views, projections, caches, workflows }
}

fn collect_signals(steps: &[Step], out: &mut Vec<(String, String)>) {
    for s in steps {
        match s {
            Step::Wait { channel, message, .. } => {
                if !out.iter().any(|(c, m)| c == channel && m == message) {
                    out.push((channel.clone(), message.clone()));
                }
            }
            Step::Choice { then, otherwise, .. } => {
                collect_signals(then, out);
                collect_signals(otherwise, out);
            }
            Step::Parallel { branches, .. } => branches.iter().for_each(|b| collect_signals(b, out)),
            _ => {}
        }
    }
}

fn resource(ir: &DomainIR, r: &Resource) -> ResourceContract {
    let mut record = JsonSchema { ty: "object".into(), ..Default::default() };
    let mut create = JsonSchema { ty: "object".into(), ..Default::default() };
    let mut patch = JsonSchema { ty: "object".into(), ..Default::default() };
    // Output order: id, synthesized system fields, then declared fields (wire-visible; fixed).
    let mut ordered: Vec<&Field> = Vec::new();
    if let Some(id) = r.fields.iter().find(|f| f.name == "id") {
        ordered.push(id);
    }
    ordered.extend(r.fields.iter().filter(|f| f.synthesized));
    ordered.extend(r.fields.iter().filter(|f| !f.synthesized && f.name != "id"));
    for f in ordered {
        if f.hidden {
            continue;
        }
        let schema = field_schema(ir, r, f);
        record.properties.insert(f.name.clone(), schema.clone());
        record.required.push(f.name.clone());
        if f.server_owned || f.synthesized {
            continue;
        }
        create.properties.insert(f.name.clone(), schema.clone());
        if !f.ty.optional && f.default.is_none() {
            create.required.push(f.name.clone());
        }
        if !f.immutable {
            patch.properties.insert(f.name.clone(), schema);
        }
    }
    let mut queries: Vec<QueryContract> = r.finds.iter().map(|f| QueryContract { name: f.name.clone(), kind: "find".into(), params: f.fields.clone(), order: vec![] }).collect();
    queries.extend(r.lists.iter().map(|l| QueryContract { name: l.name.clone(), kind: "list".into(), params: l.fields.clone(), order: l.order.clone() }));
    let lifecycle = r.lifecycle.as_ref().map(|lc| LifecycleContract {
        field: lc.field.clone(),
        states: lc.states.clone(),
        initial: lc.initial.clone(),
        actions: lc
            .transitions
            .iter()
            .map(|t| {
                let mut input = JsonSchema { ty: "object".into(), ..Default::default() };
                for f in &t.input {
                    input.properties.insert(f.name.clone(), field_schema(ir, r, f));
                    if !f.ty.optional && f.default.is_none() {
                        input.required.push(f.name.clone());
                    }
                }
                ActionContract { name: t.action.clone(), from: t.from.clone(), to: t.to.clone(), input }
            })
            .collect(),
    });
    ResourceContract {
        id: r.id.clone(),
        name: r.name.clone(),
        wire_name: naming::wire(&r.name),
        tenant_scoped: r.decorators.tenant,
        soft_delete: r.decorators.soft_delete,
        versioned: r.decorators.versioned,
        record,
        create,
        patch,
        queries,
        lifecycle,
        operations: r.operations.clone(),
    }
}

/// JSON Schema (2020-12 subset) for a field, carrying Forge semantics in `x-forge-*`.
pub fn field_schema(ir: &DomainIR, owner: &Resource, f: &Field) -> Value {
    let mut s = type_schema(ir, owner, &f.ty);
    if let Some(obj) = s.as_object_mut() {
        if f.ty.optional {
            let t = obj.get("type").cloned().unwrap_or(json!("string"));
            obj.insert("type".into(), json!([t, "null"]));
        }
        if let Some(d) = &f.default {
            obj.insert("default".into(), literal_json(d));
        }
        if f.server_owned {
            obj.insert("readOnly".into(), json!(true));
        }
        if !f.ty.normalizers.is_empty() {
            obj.insert("x-forge-normalizers".into(), json!(f.ty.normalizers));
        }
        if let Some(doc) = &f.doc {
            obj.insert("description".into(), json!(doc));
        }
    }
    s
}

fn literal_json(l: &Literal) -> Value {
    match l {
        Literal::Int(i) => json!(i.parse::<i64>().unwrap_or(0)),
        Literal::Decimal(d) => json!(d),
        Literal::String(s) => json!(s),
        Literal::Bool(b) => json!(b),
        Literal::Null => Value::Null,
        Literal::Duration(d) | Literal::Percent(d) => json!(d),
        Literal::EnumMember { member, .. } => json!(member),
    }
}

fn type_schema(ir: &DomainIR, owner: &Resource, ty: &TypeSpec) -> Value {
    let mut s = match &ty.base {
        TypeBase::Scalar { name, args } => match name.as_str() {
            "id" => json!({ "type": "string", "x-forge-type": "id", "maxLength": 64, "pattern": "^[A-Za-z0-9_-]+$" }),
            "text" => json!({ "type": "string", "x-forge-type": "text" }),
            "email" => json!({ "type": "string", "format": "email", "x-forge-type": "email" }),
            "url" => json!({ "type": "string", "format": "uri", "x-forge-type": "url" }),
            "timezone" => json!({ "type": "string", "x-forge-type": "timezone" }),
            "countryCode" => json!({ "type": "string", "pattern": "^[A-Z]{2}$", "x-forge-type": "countryCode" }),
            "integer" => json!({ "type": "integer", "minimum": -9007199254740991i64, "maximum": 9007199254740991i64, "x-forge-type": "integer" }),
            "decimal" => json!({ "type": "string", "pattern": "^-?[0-9]+(\\.[0-9]+)?$", "x-forge-type": "decimal", "x-forge-scale": args.first().and_then(|a| a.parse::<u32>().ok()).unwrap_or(2) }),
            "money" => json!({ "type": "string", "pattern": "^-?[0-9]+(\\.[0-9]+)?$", "x-forge-type": "money", "x-forge-currency": args.first().cloned().unwrap_or_else(|| "USD".into()) }),
            "boolean" => json!({ "type": "boolean" }),
            "date" => json!({ "type": "string", "format": "date", "x-forge-type": "date" }),
            "datetime" => json!({ "type": "string", "format": "date-time", "x-forge-type": "datetime", "x-forge-precision": "ms" }),
            "localTime" => json!({ "type": "string", "pattern": "^([01][0-9]|2[0-3]):[0-5][0-9](:[0-5][0-9])?$", "x-forge-type": "localTime" }),
            "duration" => json!({ "type": "string", "format": "duration", "x-forge-type": "duration" }),
            "json" => json!({}),
            other => json!({ "type": "string", "x-forge-type": other }),
        },
        TypeBase::Enum { id } => {
            let values: Vec<String> = ir.find_enum(id).map(|e| e.members.iter().map(|m| m.value.clone()).collect()).unwrap_or_default();
            json!({ "type": "string", "enum": values, "x-forge-enum": id })
        }
        TypeBase::Shape { id } => json!({ "$ref": format!("#/$defs/{}", id) }),
        TypeBase::Reference { resource } => json!({ "type": "string", "x-forge-reference": resource }),
        TypeBase::Identity { resource } => json!({ "type": "string", "x-forge-identity": resource }),
        TypeBase::Record { resource } => json!({ "$ref": format!("#/$defs/{}.Record", resource) }),
        TypeBase::Status { resource } => {
            let states = if resource == &owner.id { owner.lifecycle.as_ref().map(|l| l.states.clone()) } else { ir.find_resource(resource).and_then(|r| r.lifecycle.as_ref()).map(|l| l.states.clone()) };
            json!({ "type": "string", "enum": states.unwrap_or_default(), "x-forge-status": resource })
        }
        TypeBase::Message { channel, message } => json!({ "$ref": format!("#/$defs/{}.{}", channel, message) }),
    };
    if let Some(obj) = s.as_object_mut() {
        for c in &ty.constraints {
            match c {
                Constraint::Length { min, max } => {
                    if let Some(min) = min {
                        obj.insert("minLength".into(), json!(min));
                    }
                    if let Some(max) = max {
                        obj.insert("maxLength".into(), json!(max));
                    }
                }
                Constraint::Compare { op, value } => {
                    let v = literal_json(value);
                    let key = match op.as_str() {
                        ">=" => "minimum",
                        ">" => "exclusiveMinimum",
                        "<=" => "maximum",
                        "<" => "exclusiveMaximum",
                        _ => continue,
                    };
                    // decimal/money bounds stay strings (exact); integers stay numbers
                    obj.insert(key.into(), v);
                }
                Constraint::Pattern { value } => {
                    obj.insert("pattern".into(), json!(value));
                }
            }
        }
    }
    s
}
