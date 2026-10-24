//! Composable-unit plan (FORG-28, research). Splits a deployment into units: one per
//! implemented or generated function, resource operation (CRUD, query, transition) and
//! workflow. Each unit carries an interface derived from DomainIR alone, its capability
//! imports bound to providers, the platform bindings it needs, and the units it calls.
//!
//! This plan is the compiler's half of a Closure Manifest. It has no implementation bytes:
//! units whose behaviour lives in `impl/` are bundled by `@forgegraph/units`, which hashes
//! the bundles and seals the manifest (`schemas/closure-manifest.schema.json`). Units that
//! the runtime executes from the declaration (`forge-native`) get their implementation
//! digest here. Nothing in this module is part of `app.json`.

use crate::Plans;
use forgegraph_semantic::ir::*;
use serde::Serialize;
use serde_json::{Value, json};
use std::collections::{BTreeMap, BTreeSet};

pub const UNIT_PLAN_VERSION: &str = "unit-plan/1";
/// Domain separators. A digest is `sha256:` + hex(sha256(separator + canonical JSON)).
pub const INTERFACE_DOMAIN: &str = "forge:unit-interface:";
pub const IMPLEMENTATION_DOMAIN: &str = "forge:unit-impl:";
/// Planned target. Bindings are Cloudflare Worker binding names (`env.<name>`).
pub const TARGET: &str = "cloudflare-workers";
/// The Cloudflare host's outbox/workflow sweep (examples/acme/deploy/cloudflare/wrangler.jsonc).
const SWEEP_CRON: &str = "*/5 * * * *";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UnitPlan {
    pub version: String,
    pub package: UnitPackage,
    pub target: String,
    pub units: Vec<PlannedUnit>,
    pub entry_points: Vec<EntryPoint>,
    /// Bindings every host needs whatever runs in it (storage, cursor signing, auth mode).
    pub host_bindings: Vec<Binding>,
    /// Served surfaces that are not split into units yet; recorded so their absence is visible.
    pub uncovered: Vec<Uncovered>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UnitPackage {
    pub name: String,
    pub version: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlannedUnit {
    /// Stable id of the declaration the unit implements.
    pub symbol: String,
    /// function | external | operation | workflow
    pub role: String,
    /// js-module | forge-native. Metadata only: never part of the unit's identity.
    pub kind: String,
    pub interface: Value,
    pub interface_hash: String,
    /// forge-native: `{ declaration }` digest. js-module: where the bundler finds the body.
    pub implementation: Value,
    /// Symbols of the units this unit calls. Their interface hashes enter this unit's hash; the
    /// exact implementations are pinned by the closure hash of each entry point.
    pub dependencies: Vec<String>,
    pub imports: Vec<CapabilityImport>,
    pub bindings: Vec<Binding>,
    /// Implemented function units: the WIT world generated from the interface (FORG-31), or why
    /// it cannot be generated. A WASM component can implement the unit only when this is `ok`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub wit: Option<crate::wit::UnitWit>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq, PartialOrd, Ord)]
#[serde(rename_all = "camelCase")]
pub struct CapabilityImport {
    /// `resource:<id>#<capability>`, `transition:<op id>`, `function:<id>`, `send:<channel>#<message>`,
    /// `wait:<channel>#<message>`, `sleep`.
    pub capability: String,
    pub provider: Provider,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq, PartialOrd, Ord)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Provider {
    /// Another unit, linked by symbol here and by unit hash in the sealed manifest.
    Unit { symbol: String },
    /// A service the runtime host provides (resource-store, outbox, signals, timers).
    Runtime { service: String },
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq, PartialOrd, Ord)]
#[serde(rename_all = "camelCase")]
pub struct Binding {
    /// d1 | r2 | secret | var | queue-producer | queue-consumer | durable-object | workflow | cron
    #[serde(rename = "type")]
    pub ty: String,
    pub name: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EntryPoint {
    /// http-route | queue-consumer | cron | workflow | workflow-step | durable-object
    pub kind: String,
    pub id: String,
    pub trigger: Value,
    /// Root unit symbol, or none for an entry point served by the runtime alone.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub root: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub runtime_service: Option<String>,
    /// Bindings the trigger itself needs (consumer queue, cron, class); unit bindings are added when sealing.
    pub bindings: Vec<Binding>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Uncovered {
    pub kind: String,
    pub id: String,
    pub reason: String,
}

/// Canonical form: object keys sorted, `doc` removed everywhere (documentation is not a signature).
fn canonical(v: &Value) -> Value {
    match v {
        Value::Object(m) => {
            let mut keys: Vec<&String> = m.keys().filter(|k| *k != "doc").collect();
            keys.sort();
            let mut out = serde_json::Map::new();
            for k in keys {
                out.insert(k.clone(), canonical(&m[k]));
            }
            Value::Object(out)
        }
        Value::Array(a) => Value::Array(a.iter().map(canonical).collect()),
        other => other.clone(),
    }
}

pub fn digest(domain: &str, v: &Value) -> String {
    let text = serde_json::to_string(&canonical(v)).expect("serialize");
    format!("sha256:{}", hash_hex(&format!("{domain}{text}")))
}

/// Declarations visible to the deployment: the package first, then its dependencies.
pub(crate) struct Scope<'a> {
    pub(crate) irs: Vec<&'a DomainIR>,
}

impl<'a> Scope<'a> {
    pub(crate) fn function(&self, id: &str) -> Option<&'a Function> {
        self.irs.iter().find_map(|ir| ir.find_function(id))
    }
    pub(crate) fn resource(&self, id: &str) -> Option<&'a Resource> {
        self.irs.iter().find_map(|ir| ir.find_resource(id))
    }
    pub(crate) fn channel(&self, id: &str) -> Option<&'a Channel> {
        self.irs.iter().find_map(|ir| ir.find_channel(id))
    }

    /// Every named type a signature reaches, by id: shapes, enums, records, lifecycle states and
    /// messages, expanded transitively. References and identities stay ids on the wire, so the
    /// referenced resource is not expanded.
    fn types(&self, roots: &[&TypeSpec]) -> BTreeMap<String, Value> {
        let mut out = BTreeMap::new();
        let mut stack: Vec<TypeSpec> = roots.iter().map(|t| (*t).clone()).collect();
        while let Some(ty) = stack.pop() {
            let (key, entry, fields): (String, Value, Vec<Field>) = match &ty.base {
                TypeBase::Collection { element, .. } => {
                    stack.push((**element).clone());
                    continue;
                }
                TypeBase::Shape { id } => match self.irs.iter().find_map(|ir| ir.find_shape(id)) {
                    Some(s) => (
                        id.clone(),
                        json!({ "kind": "shape", "fields": s.fields }),
                        s.fields.clone(),
                    ),
                    None => (id.clone(), json!({ "kind": "unresolved" }), vec![]),
                },
                TypeBase::Enum { id } => match self.irs.iter().find_map(|ir| ir.find_enum(id)) {
                    Some(e) => (
                        id.clone(),
                        json!({ "kind": "enum", "members": e.members }),
                        vec![],
                    ),
                    None => (id.clone(), json!({ "kind": "unresolved" }), vec![]),
                },
                TypeBase::Record { resource } => match self.resource(resource) {
                    Some(r) => {
                        let wire: Vec<Field> =
                            r.fields.iter().filter(|f| !f.hidden).cloned().collect();
                        (
                            format!("{resource}.Record"),
                            json!({ "kind": "record", "fields": wire }),
                            wire,
                        )
                    }
                    None => (resource.clone(), json!({ "kind": "unresolved" }), vec![]),
                },
                TypeBase::Status { resource } => (
                    format!("{resource}.Status"),
                    json!({ "kind": "status", "states": self.resource(resource).and_then(|r| r.lifecycle.as_ref()).map(|l| l.states.clone()) }),
                    vec![],
                ),
                TypeBase::Message { channel, message } => {
                    let fields = self
                        .channel(channel)
                        .and_then(|c| c.messages.iter().find(|m| &m.name == message))
                        .map(|m| m.fields.clone())
                        .unwrap_or_default();
                    (
                        format!("{channel}#{message}"),
                        json!({ "kind": "message", "fields": fields }),
                        fields,
                    )
                }
                TypeBase::Scalar { .. }
                | TypeBase::Reference { .. }
                | TypeBase::Identity { .. } => {
                    continue;
                }
            };
            if out.contains_key(&key) {
                continue;
            }
            out.insert(key, entry);
            stack.extend(fields.into_iter().map(|f| f.ty));
        }
        out
    }
}

fn sorted<T: Ord>(items: impl IntoIterator<Item = T>) -> Vec<T> {
    items
        .into_iter()
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect()
}

fn queue_producer(subscription: &str) -> String {
    // Mirrors the Cloudflare host: `Q_<SUBSCRIPTION>`, kebab -> upper snake.
    format!("Q_{}", subscription.to_uppercase().replace('-', "_"))
}

fn binding(ty: &str, name: &str) -> Binding {
    Binding {
        ty: ty.into(),
        name: name.into(),
    }
}

fn runtime(service: &str) -> Provider {
    Provider::Runtime {
        service: service.into(),
    }
}

/// Plan the units of a compiled (assembled) deployment. `deps` are the dependency IRs, used to
/// resolve signatures of external functions this package calls but does not declare.
pub fn plan(ir: &DomainIR, deps: &[&DomainIR], plans: &Plans) -> UnitPlan {
    let scope = Scope {
        irs: std::iter::once(ir).chain(deps.iter().copied()).collect(),
    };
    let sends_bindings = |channel: &str, message: &str| -> Vec<Binding> {
        let mut out: Vec<Binding> = plans
            .messaging
            .subscriptions
            .iter()
            .filter(|s| s.channel == channel && s.message == message)
            .map(|s| binding("queue-producer", &queue_producer(&s.name)))
            .collect();
        if plans.realtime.streams.iter().any(|s| s.channel == channel) {
            out.push(binding(
                "durable-object",
                &plans.realtime.cloudflare.binding,
            ));
        }
        out
    };
    let resource_bindings = |resource: &str| -> Vec<Binding> {
        let mut out = vec![binding("d1", "DB")];
        if scope.resource(resource).is_some_and(|r| r.kind == "blob") {
            out.push(binding("r2", "BLOBS"));
        }
        out
    };

    let mut units: BTreeMap<String, PlannedUnit> = BTreeMap::new();
    let mut externals: BTreeSet<String> = BTreeSet::new();

    // Functions: implemented in impl/ (js-module) or generated by the runtime (forge-native).
    for f in ir.modules.iter().flat_map(|m| &m.functions) {
        let unit = function_unit(&scope, f, "function", &sends_bindings, &resource_bindings);
        for u in &f.uses {
            if let Use::Function { function, .. } = u
                && ir.find_function(function).is_none()
            {
                externals.insert(function.clone());
            }
        }
        units.insert(unit.symbol.clone(), unit);
    }
    // Cross-package callables: the signature comes from the dependency's IR, the body from the
    // deployment's `impl/` externals (plan §14).
    for id in &externals {
        let Some(f) = scope.function(id) else {
            continue;
        };
        let mut unit = function_unit(&scope, f, "external", &sends_bindings, &resource_bindings);
        unit.kind = "js-module".into();
        unit.implementation = json!({ "source": "impl", "binding": "external" });
        units.insert(unit.symbol.clone(), unit);
    }

    // Resource operations: CRUD, queries and lifecycle transitions, all generated.
    for r in ir.modules.iter().flat_map(|m| &m.resources) {
        for op in &r.operations {
            let unit = operation_unit(&scope, r, op, &resource_bindings);
            units.insert(unit.symbol.clone(), unit);
        }
    }

    // Workflows: the step graph is the implementation; called functions and transitions are units.
    for w in ir.modules.iter().flat_map(|m| &m.workflows) {
        let cf = plans.workflows.workflows.iter().find(|p| p.id == w.id);
        let unit = workflow_unit(&scope, w, cf.map(|c| c.cloudflare.binding.as_str()));
        units.insert(unit.symbol.clone(), unit);
    }

    let mut entry_points = Vec::new();
    let route = |method: &str, path: &str, root: &str| EntryPoint {
        kind: "http-route".into(),
        id: format!("{method} {path}"),
        trigger: json!({ "method": method, "path": path }),
        root: Some(root.into()),
        runtime_service: None,
        bindings: vec![],
    };
    for r in &plans.contracts.resources {
        for op in &r.operations {
            if let Some(h) = &op.http {
                entry_points.push(route(&h.method, &h.path, &op.id));
            }
        }
    }
    for f in &plans.contracts.functions {
        if let Some(h) = &f.http {
            entry_points.push(route(&h.method, &h.path, &f.id));
        }
    }
    for w in &plans.contracts.workflows {
        // Start and signal delivery advance the workflow, so they need its closure (plan §15).
        entry_points.push(route(&w.start.method, &w.start.path, &w.id));
        entry_points.push(route(
            "POST",
            &format!("{}/signals/{{message}}", w.path),
            &w.id,
        ));
        // Status and cancel only touch the instance record.
        for (method, path) in [
            ("GET", format!("{}/{{id}}", w.path)),
            ("POST", format!("{}/{{id}}/cancel", w.path)),
        ] {
            entry_points.push(EntryPoint {
                kind: "http-route".into(),
                id: format!("{method} {path}"),
                trigger: json!({ "method": method, "path": path, "workflow": w.id }),
                root: None,
                runtime_service: Some("workflow-instances".into()),
                bindings: vec![],
            });
        }
    }
    for s in &plans.messaging.subscriptions {
        entry_points.push(EntryPoint {
            kind: "queue-consumer".into(),
            id: s.name.clone(),
            trigger: json!({ "queue": s.queue, "channel": s.channel, "message": s.message }),
            root: Some(s.handler.clone()),
            runtime_service: None,
            bindings: vec![binding("queue-consumer", &s.queue)],
        });
    }
    for s in &plans.schedules.schedules {
        // A non-UTC schedule has no exact cron; the periodic tick evaluates it (`tick: true`).
        let cron = s
            .cloudflare
            .cron
            .clone()
            .unwrap_or_else(|| SWEEP_CRON.into());
        entry_points.push(EntryPoint {
            kind: "cron".into(),
            id: s.source.clone(),
            trigger: json!({ "cron": cron, "timezone": s.recurrence.timezone, "tick": s.cloudflare.tick }),
            root: Some(s.target.clone()),
            runtime_service: None,
            bindings: vec![binding("cron", &cron)],
        });
    }
    for w in &plans.workflows.workflows {
        entry_points.push(EntryPoint {
            kind: "workflow".into(),
            id: w.id.clone(),
            trigger: json!({ "className": w.cloudflare.class_name, "name": w.cloudflare.name }),
            root: Some(w.id.clone()),
            runtime_service: None,
            bindings: vec![binding("workflow", &w.cloudflare.binding)],
        });
        if let Some(decl) = ir
            .modules
            .iter()
            .flat_map(|m| &m.workflows)
            .find(|d| d.id == w.id)
        {
            let mut calls = Vec::new();
            collect_calls(&decl.steps, &mut calls);
            for (step, target) in calls {
                entry_points.push(EntryPoint {
                    kind: "workflow-step".into(),
                    id: format!("{}#{step}", w.id),
                    trigger: json!({ "workflow": w.id, "step": step }),
                    root: Some(target),
                    runtime_service: None,
                    bindings: vec![],
                });
            }
        }
    }
    if !plans.realtime.streams.is_empty() {
        // One object per (tenant, stream): generic fan-out with no application code.
        entry_points.push(EntryPoint {
            kind: "durable-object".into(),
            id: plans.realtime.cloudflare.class_name.clone(),
            trigger: json!({ "className": plans.realtime.cloudflare.class_name, "streams": plans.realtime.streams.iter().map(|s| &s.channel).collect::<Vec<_>>() }),
            root: None,
            runtime_service: Some("realtime-fanout".into()),
            bindings: vec![binding(
                "durable-object",
                &plans.realtime.cloudflare.binding,
            )],
        });
    }
    // The host's outbox/workflow sweep runs on every deployment, whatever its schedules.
    entry_points.push(EntryPoint {
        kind: "cron".into(),
        id: "forge:sweep".into(),
        trigger: json!({ "cron": SWEEP_CRON, "timezone": "UTC" }),
        root: None,
        runtime_service: Some("outbox-and-workflow-sweep".into()),
        bindings: vec![binding("cron", SWEEP_CRON)],
    });
    entry_points.sort_by(|a, b| (&a.kind, &a.id).cmp(&(&b.kind, &b.id)));

    let mut uncovered = Vec::new();
    for v in &plans.contracts.views {
        uncovered.push(Uncovered {
            kind: "view".into(),
            id: v.id.clone(),
            reason: "read model served by the runtime query engine; not split into a unit in T2"
                .into(),
        });
    }
    for p in &plans.contracts.projections {
        uncovered.push(Uncovered {
            kind: "projection".into(),
            id: p.id.clone(),
            reason: "rebuildable projection maintained by the runtime; not split into a unit in T2"
                .into(),
        });
    }
    for c in &plans.contracts.caches {
        uncovered.push(Uncovered {
            kind: "cache".into(),
            id: c.id.clone(),
            reason: "loader runs inside the runtime; not split into a unit in T2".into(),
        });
    }
    for s in &plans.contracts.schedules {
        uncovered.push(Uncovered {
            kind: "schedule-routes".into(),
            id: s.id.clone(),
            reason: "status and manual tick routes are served by the runtime scheduler".into(),
        });
    }

    UnitPlan {
        version: UNIT_PLAN_VERSION.into(),
        package: UnitPackage {
            name: ir.package.name.clone(),
            version: ir.package.version.clone(),
        },
        target: TARGET.into(),
        units: units.into_values().collect(),
        entry_points,
        host_bindings: vec![
            binding("d1", "DB"),
            binding("secret", "CURSOR_SECRET"),
            binding("var", "FORGE_AUTH"),
        ],
        uncovered,
    }
}

fn function_unit(
    scope: &Scope,
    f: &Function,
    role: &str,
    sends_bindings: &dyn Fn(&str, &str) -> Vec<Binding>,
    resource_bindings: &dyn Fn(&str) -> Vec<Binding>,
) -> PlannedUnit {
    let mut imports = Vec::new();
    let mut bindings = Vec::new();
    let mut dependencies = Vec::new();
    for u in &f.uses {
        match u {
            Use::Resource {
                resource,
                capability,
            } => {
                imports.push(CapabilityImport {
                    capability: format!("resource:{resource}#{capability}"),
                    provider: runtime("resource-store"),
                });
                bindings.extend(resource_bindings(resource));
            }
            Use::Transition { resource, action } => {
                let op = format!("{resource}.status.{action}");
                imports.push(CapabilityImport {
                    capability: format!("transition:{op}"),
                    provider: Provider::Unit { symbol: op.clone() },
                });
                dependencies.push(op);
            }
            Use::Function { function, .. } => {
                imports.push(CapabilityImport {
                    capability: format!("function:{function}"),
                    provider: Provider::Unit {
                        symbol: function.clone(),
                    },
                });
                dependencies.push(function.clone());
            }
        }
    }
    for s in &f.sends {
        imports.push(CapabilityImport {
            capability: format!("send:{}#{}", s.channel, s.message),
            provider: runtime("outbox"),
        });
        bindings.extend(sends_bindings(&s.channel, &s.message));
    }
    let roots: Vec<&TypeSpec> = f.input.iter().chain(f.output.iter()).collect();
    // Structural: no symbol (the manifest keeps it as the binding name) and no role, so units of the
    // same shape share an interface hash whatever they are called or wherever they are declared.
    let interface = json!({
        "input": f.input,
        "output": f.output,
        "errors": sorted(f.errors.iter().cloned()),
        "effects": { "sends": sorted(f.sends.iter().map(|s| format!("{}#{}", s.channel, s.message))) },
        "capabilities": sorted(imports.iter().map(|i| i.capability.clone())),
        "purpose": f.purpose,
        "types": scope.types(&roots),
    });
    let imports = sorted(imports);
    let wit = (!f.generated).then(|| crate::wit::function_world(scope, f, &imports));
    let (kind, implementation) = if f.generated {
        (
            "forge-native",
            json!({ "declaration": digest(IMPLEMENTATION_DOMAIN, &serde_json::to_value(f).expect("serialize")) }),
        )
    } else {
        (
            "js-module",
            json!({ "source": "impl", "binding": "function" }),
        )
    };
    PlannedUnit {
        symbol: f.id.clone(),
        role: role.into(),
        kind: kind.into(),
        interface_hash: digest(INTERFACE_DOMAIN, &interface),
        interface,
        implementation,
        dependencies: sorted(dependencies),
        imports,
        bindings: sorted(bindings),
        wit,
    }
}

fn operation_unit(
    scope: &Scope,
    r: &Resource,
    op: &Operation,
    resource_bindings: &dyn Fn(&str) -> Vec<Binding>,
) -> PlannedUnit {
    let record = TypeSpec {
        base: TypeBase::Record {
            resource: r.id.clone(),
        },
        optional: false,
        normalizers: vec![],
        constraints: vec![],
        purpose: None,
        data_class: None,
    };
    // The part of the declaration that shapes this operation's wire signature.
    let detail = match (op.kind.as_str(), &op.query, &op.action) {
        (_, _, Some(action)) => json!({
            "transition": r.lifecycle.as_ref().and_then(|l| l.transitions.iter().find(|t| &t.action == action)),
        }),
        (_, Some(query), _) => json!({
            "find": r.finds.iter().find(|x| &x.name == query),
            "list": r.lists.iter().find(|x| &x.name == query),
        }),
        _ => Value::Null,
    };
    let mut field_types: Vec<TypeSpec> = vec![record];
    if let Some(action) = &op.action
        && let Some(t) = r
            .lifecycle
            .as_ref()
            .and_then(|l| l.transitions.iter().find(|t| &t.action == action))
    {
        field_types.extend(t.input.iter().map(|f| f.ty.clone()));
    }
    let interface = json!({
        "operation": { "kind": op.kind, "query": op.query, "action": op.action },
        "resource": r.id,
        "detail": detail,
        "errors": [],
        "effects": { "sends": [] },
        "capabilities": [],
        "types": scope.types(&field_types.iter().collect::<Vec<_>>()),
    });
    // Generated behaviour: the whole resource declaration (rules, uniques, decorators,
    // lifecycle) is what the runtime executes. Routes are entry-point data, not behaviour.
    let mut declaration = serde_json::to_value(r).expect("serialize");
    if let Some(ops) = declaration["operations"].as_array_mut() {
        for o in ops {
            if let Some(o) = o.as_object_mut() {
                o.remove("http");
            }
        }
    }
    let implementation = json!({
        "declaration": digest(IMPLEMENTATION_DOMAIN, &json!({ "operation": op.id, "resource": declaration })),
    });
    let mut bindings = resource_bindings(&r.id);
    if !matches!(
        op.kind.as_str(),
        "beginUpload" | "finalizeUpload" | "download"
    ) {
        bindings.retain(|b| b.ty != "r2");
    }
    PlannedUnit {
        symbol: op.id.clone(),
        role: "operation".into(),
        kind: "forge-native".into(),
        interface_hash: digest(INTERFACE_DOMAIN, &interface),
        interface,
        implementation,
        dependencies: vec![],
        imports: vec![CapabilityImport {
            capability: format!("resource:{}#{}", r.id, storage_capability(&op.kind)),
            provider: runtime("resource-store"),
        }],
        bindings: sorted(bindings),
        wit: None,
    }
}

/// The storage capability a generated operation exercises, in the `uses` vocabulary.
fn storage_capability(kind: &str) -> &'static str {
    match kind {
        "create" => "create",
        "delete" => "delete",
        "update" | "restore" | "move" | "transition" | "beginUpload" | "finalizeUpload" => "write",
        _ => "read",
    }
}

fn collect_calls(steps: &[Step], out: &mut Vec<(String, String)>) {
    for s in steps {
        match s {
            Step::Call { id, target, .. } => out.push((id.clone(), call_symbol(target))),
            Step::Map { id, call, .. } => {
                let mut inner = Vec::new();
                collect_calls(std::slice::from_ref(call), &mut inner);
                out.extend(inner.into_iter().map(|(_, t)| (id.clone(), t)));
            }
            Step::Choice {
                then, otherwise, ..
            } => {
                collect_calls(then, out);
                collect_calls(otherwise, out);
            }
            Step::Parallel { branches, .. } => {
                for b in branches {
                    collect_calls(b, out);
                }
            }
            _ => {}
        }
    }
}

fn collect_waits(steps: &[Step], waits: &mut Vec<String>, sleeps: &mut bool) {
    for s in steps {
        match s {
            Step::Wait {
                channel, message, ..
            } => waits.push(format!("{channel}#{message}")),
            Step::Sleep { .. } => *sleeps = true,
            Step::Choice {
                then, otherwise, ..
            } => {
                collect_waits(then, waits, sleeps);
                collect_waits(otherwise, waits, sleeps);
            }
            Step::Parallel { branches, .. } => {
                for b in branches {
                    collect_waits(b, waits, sleeps);
                }
            }
            _ => {}
        }
    }
}

fn call_symbol(target: &CallTarget) -> String {
    match target {
        CallTarget::Function { function } => function.clone(),
        CallTarget::Transition { resource, action } => format!("{resource}.status.{action}"),
    }
}

fn workflow_unit(scope: &Scope, w: &Workflow, cf_binding: Option<&str>) -> PlannedUnit {
    let mut calls = Vec::new();
    collect_calls(&w.steps, &mut calls);
    let (mut waits, mut sleeps) = (Vec::new(), false);
    collect_waits(&w.steps, &mut waits, &mut sleeps);
    let mut imports: Vec<CapabilityImport> = calls
        .iter()
        .map(|(_, target)| CapabilityImport {
            capability: if target.contains(".status.") {
                format!("transition:{target}")
            } else {
                format!("function:{target}")
            },
            provider: Provider::Unit {
                symbol: target.clone(),
            },
        })
        .collect();
    imports.extend(waits.iter().map(|w| CapabilityImport {
        capability: format!("wait:{w}"),
        provider: runtime("signals"),
    }));
    if sleeps {
        imports.push(CapabilityImport {
            capability: "sleep".into(),
            provider: runtime("timers"),
        });
    }
    let roots: Vec<&TypeSpec> = w.input.iter().chain(w.output.iter()).collect();
    let interface = json!({
        // In-flight instances pin the version: it is part of what callers rely on.
        "version": w.version,
        "input": w.input,
        "output": w.output,
        "errors": sorted(w.errors.iter().cloned()),
        "effects": { "sends": [], "waits": sorted(waits.iter().cloned()) },
        "capabilities": sorted(imports.iter().map(|i| i.capability.clone())),
        "types": scope.types(&roots),
    });
    let mut bindings = vec![binding("d1", "DB")];
    if let Some(b) = cf_binding {
        bindings.push(binding("workflow", b));
    }
    PlannedUnit {
        symbol: w.id.clone(),
        role: "workflow".into(),
        kind: "forge-native".into(),
        interface_hash: digest(INTERFACE_DOMAIN, &interface),
        interface,
        implementation: json!({ "declaration": format!("sha256:{}", w.graph_hash) }),
        dependencies: sorted(calls.into_iter().map(|(_, t)| t)),
        imports: sorted(imports),
        bindings: sorted(bindings),
        wit: None,
    }
}
