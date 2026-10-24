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
//!
//! FORG-33 covers every surface the runtime serves: views, projections, caches and schedules are
//! units; changesets, imports, admin, the scheduler and the outbox/workflow dispatcher are
//! runtime-service units whose closure the planner owns; contract metadata, object bytes, realtime
//! upgrades and workflow/schedule status are runtime-served entry points. `uncovered` lists only
//! declarations the runtime cannot execute as planned. [`attach_sources`] records where each unit
//! is declared, for Loom; spans never enter a unit's digests.

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
    /// Where the unit is declared (FORG-33): filled by [`attach_sources`]. The sealer adds the
    /// `impl/` body. Provenance only: no digest of the unit covers it (see [`SourceRef`]).
    pub sources: Vec<SourceRef>,
    /// Stable id of the declaration the unit's source span is taken from: the unit's own symbol,
    /// or the resource for a generated operation. None for runtime-service units.
    #[serde(skip)]
    pub anchor: Option<String>,
}

/// A source span a unit was planned from, so Loom can check a manifest against a snapshot.
///
/// Spans and blob hashes stay out of `interfaceHash`, `implementationHash`, `unitHash` and
/// `closureHash`. A span moves when unrelated text above it in the same file changes, and the
/// blob hash moves with any edit to the file, so both would re-identify units whose behaviour did
/// not change. What runs is already pinned: the declaration digest (forge-native) or the bundled
/// module bytes (js-module). The sealed manifest's `manifestHash` covers the spans, so they cannot
/// be altered after sealing.
#[derive(Debug, Clone, Serialize, PartialEq, Eq, PartialOrd, Ord)]
#[serde(rename_all = "camelCase")]
pub struct SourceRef {
    /// `declaration` (a `.forge` declaration) or `body` (an `impl/` definition, added by the sealer).
    pub part: String,
    /// The package whose root `path` is relative to, when that is not the manifest's package
    /// (the declaration of an external function lives in the package that exports it).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub package: Option<String>,
    /// Relative to the package root, `/`-separated.
    pub path: String,
    /// Byte range `[start, end)` within the file.
    pub start: usize,
    pub end: usize,
    /// `git hash-object` of the whole file: hex SHA-1 of `blob <len>\0<bytes>`.
    pub git_blob: String,
}

/// A package's `.forge` files and declaration spans (`Compilation::source_index`), by package name.
#[derive(Debug, Clone, Default)]
pub struct PackageSources {
    pub package: String,
    /// Path relative to the package root -> file text.
    pub files: BTreeMap<String, String>,
    /// Stable declaration id -> span.
    pub index: BTreeMap<String, forgegraph_semantic::compiler::SourceSpan>,
}

/// `git hash-object` of a file's bytes: hex SHA-1 over `blob <len>\0` + bytes.
pub fn git_blob(bytes: &[u8]) -> String {
    use sha1::Digest;
    let mut h = sha1::Sha1::new();
    h.update(format!("blob {}\0", bytes.len()).as_bytes());
    h.update(bytes);
    h.finalize().iter().map(|b| format!("{b:02x}")).collect()
}

/// Records each unit's `.forge` declaration span and file blob hash. `own` is the deployment's
/// package, `deps` its dependencies (external units are declared there). Units whose anchor has no
/// span (runtime services) keep an empty list.
pub fn attach_sources(plan: &mut UnitPlan, own: &PackageSources, deps: &[PackageSources]) {
    for u in &mut plan.units {
        let Some(anchor) = &u.anchor else { continue };
        let pkg = std::iter::once(own).chain(deps.iter()).find(|p| {
            anchor.starts_with(&format!("{}/", p.package)) && p.index.contains_key(anchor)
        });
        let Some(pkg) = pkg else { continue };
        let span = &pkg.index[anchor];
        let Some(text) = pkg.files.get(&span.file) else {
            continue;
        };
        u.sources = vec![SourceRef {
            part: "declaration".into(),
            package: (pkg.package != own.package).then(|| pkg.package.clone()),
            path: span.file.clone(),
            start: span.start,
            end: span.end,
            git_blob: git_blob(text.as_bytes()),
        }];
    }
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
            let unit = operation_unit(&scope, r, op, &sends_bindings, &resource_bindings);
            units.insert(unit.symbol.clone(), unit);
        }
    }

    // Workflows: the step graph is the implementation; called functions and transitions are units.
    for w in ir.modules.iter().flat_map(|m| &m.workflows) {
        let cf = plans.workflows.workflows.iter().find(|p| p.id == w.id);
        let unit = workflow_unit(&scope, w, cf.map(|c| c.cloudflare.binding.as_str()));
        units.insert(unit.symbol.clone(), unit);
    }

    let mut uncovered = Vec::new();
    // Read models (plan §16–17) and schedules (§19): the runtime executes each from its declaration
    // and reaches the source resource through generated operations (`engine.callInternal`), so those
    // operations are dependencies. A declaration the runtime cannot execute stays uncovered.
    for v in ir.modules.iter().flat_map(|m| &m.views) {
        let contract = plans.contracts.views.iter().find(|c| c.id == v.id);
        match view_unit(&scope, v, contract) {
            Ok(u) => insert_unit(&mut units, &mut uncovered, u),
            Err(reason) => uncovered.push(uncovered_entry("view", &v.id, reason)),
        }
    }
    for p in ir.modules.iter().flat_map(|m| &m.projections) {
        let contract = plans.contracts.projections.iter().find(|c| c.id == p.id);
        match projection_unit(&scope, p, contract) {
            Ok(u) => insert_unit(&mut units, &mut uncovered, u),
            Err(reason) => uncovered.push(uncovered_entry("projection", &p.id, reason)),
        }
    }
    for c in ir.modules.iter().flat_map(|m| &m.caches) {
        match cache_unit(&scope, c) {
            Ok(u) => insert_unit(&mut units, &mut uncovered, u),
            Err(reason) => uncovered.push(uncovered_entry("cache", &c.id, reason)),
        }
    }
    for s in ir.modules.iter().flat_map(|m| &m.sources) {
        match schedule_unit(&scope, s) {
            Ok(u) => insert_unit(&mut units, &mut uncovered, u),
            Err(reason) => uncovered.push(uncovered_entry("schedule", &s.id, reason)),
        }
    }

    // Runtime services with a planner-owned closure. Their behaviour is the runtime's (the executor
    // pins it); what the planner owns is what each may reach. Symbols follow the runtime's own
    // operation ids (`<package>/_/changesets.propose`).
    let pkg = &ir.package.name;
    let own_resources: Vec<&Resource> = ir.modules.iter().flat_map(|m| &m.resources).collect();
    let stageable = |r: &&&Resource| !r.fields.iter().any(|f| f.secret);
    let changesets = format!("{pkg}/_/changesets");
    let imports_svc = format!("{pkg}/_/imports");
    let admin = format!("{pkg}/_/admin");
    let scheduler = format!("{pkg}/_/schedules");
    let dispatch = format!("{pkg}/_/dispatch");
    // A changeset may name any operation on a resource without credential fields (changeset.ts).
    let changeset_ops: Vec<CapabilityImport> = own_resources
        .iter()
        .filter(stageable)
        .flat_map(|r| &r.operations)
        .map(|op| unit_import("operation", &op.id))
        .collect();
    insert_unit(
        &mut units,
        &mut uncovered,
        service_unit(
            &changesets,
            "changesets",
            changeset_ops,
            vec![binding("d1", "DB")],
        ),
    );
    // CSV import (imports.ts): reads unique keys of the target resource, then proposes a changeset.
    let mut import_caps = vec![unit_import("service", &changesets)];
    import_caps.extend(
        own_resources
            .iter()
            .filter(stageable)
            .map(|r| CapabilityImport {
                capability: format!("resource:{}#read", r.id),
                provider: runtime("resource-store"),
            }),
    );
    insert_unit(
        &mut units,
        &mut uncovered,
        service_unit(
            &imports_svc,
            "imports",
            import_caps,
            vec![binding("d1", "DB")],
        ),
    );
    // Operator routes: portability export/import/verify/fence work on raw rows of every resource;
    // governance (subject location, inspection) pages through list operations.
    let mut admin_caps = Vec::new();
    for r in &own_resources {
        for mode in ["read", "create", "write", "delete"] {
            admin_caps.push(CapabilityImport {
                capability: format!("resource:{}#{mode}", r.id),
                provider: runtime("resource-store"),
            });
        }
        admin_caps.extend(
            r.operations
                .iter()
                .filter(|op| op.kind == "list")
                .map(|op| unit_import("operation", &op.id)),
        );
    }
    let mut admin_bindings = vec![binding("d1", "DB")];
    if own_resources.iter().any(|r| r.kind == "blob") {
        admin_bindings.push(binding("r2", "BLOBS"));
    }
    insert_unit(
        &mut units,
        &mut uncovered,
        service_unit(&admin, "admin", admin_caps, admin_bindings),
    );
    // The scheduler ticks every source at once (schedules.ts tickScoped), so a tick reaches them all.
    let schedule_units: Vec<String> = ir
        .modules
        .iter()
        .flat_map(|m| &m.sources)
        .filter(|s| units.get(&s.id).is_some_and(|u| u.role == "schedule"))
        .map(|s| s.id.clone())
        .collect();
    if !schedule_units.is_empty() {
        let caps = schedule_units
            .iter()
            .map(|s| unit_import("schedule", s))
            .collect();
        insert_unit(
            &mut units,
            &mut uncovered,
            service_unit(&scheduler, "schedules", caps, vec![binding("d1", "DB")]),
        );
    }
    // The outbox/workflow sweep and post-commit dispatch: delivers every outbox row to every
    // subscription (queues, projections, workflow waits, realtime streams), resumes workflows and
    // runs due schedules. Its closure is everything those reach, not the whole app.
    let mut dispatch_caps = Vec::new();
    let mut dispatch_bindings = vec![binding("d1", "DB")];
    for p in ir.modules.iter().flat_map(|m| &m.projections) {
        if units.get(&p.id).is_some_and(|u| u.role == "projection") {
            dispatch_caps.push(unit_import("projection", &p.id));
        }
    }
    for w in ir.modules.iter().flat_map(|m| &m.workflows) {
        dispatch_caps.push(unit_import("workflow", &w.id));
    }
    if !schedule_units.is_empty() {
        dispatch_caps.push(unit_import("service", &scheduler));
    }
    for s in &plans.messaging.subscriptions {
        dispatch_caps.push(CapabilityImport {
            capability: format!("deliver:{}", s.name),
            provider: runtime("outbox"),
        });
        dispatch_bindings.push(binding("queue-producer", &queue_producer(&s.name)));
    }
    for s in &plans.realtime.streams {
        dispatch_caps.push(CapabilityImport {
            capability: format!("deliver:realtime:{}", s.channel),
            provider: runtime("outbox"),
        });
        dispatch_bindings.push(binding(
            "durable-object",
            &plans.realtime.cloudflare.binding,
        ));
    }
    insert_unit(
        &mut units,
        &mut uncovered,
        service_unit(&dispatch, "dispatch", dispatch_caps, dispatch_bindings),
    );

    let mut entry_points = Vec::new();
    let route = |method: &str, path: &str, root: &str| EntryPoint {
        kind: "http-route".into(),
        id: format!("{method} {path}"),
        trigger: json!({ "method": method, "path": path }),
        root: Some(root.into()),
        runtime_service: None,
        bindings: vec![],
    };
    // Served by the runtime without application code: the entry point names the runtime service.
    let served = |method: &str, path: &str, service: &str, extra: Value, bindings: Vec<Binding>| {
        let mut trigger = json!({ "method": method, "path": path });
        if let (Some(t), Value::Object(extra)) = (trigger.as_object_mut(), extra) {
            t.extend(extra);
        }
        EntryPoint {
            kind: "http-route".into(),
            id: format!("{method} {path}"),
            trigger,
            root: None,
            runtime_service: Some(service.into()),
            bindings,
        }
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
    let workflow_binding = |id: &str| {
        plans
            .workflows
            .workflows
            .iter()
            .find(|p| p.id == id)
            .map(|p| binding("workflow", &p.cloudflare.binding))
    };
    for w in &plans.contracts.workflows {
        // Start and signal delivery advance the workflow, so they need its closure (plan §15).
        entry_points.push(route(&w.start.method, &w.start.path, &w.id));
        entry_points.push(route(
            "POST",
            &format!("{}/signals/{{message}}", w.path),
            &w.id,
        ));
        // Status and cancel only touch the instance record. Cancelling also wakes the native
        // instance (workflows.ts), so the cancel route needs the workflow binding.
        let workflow = json!({ "workflow": w.id });
        entry_points.push(served(
            "GET",
            &format!("{}/{{id}}", w.path),
            "workflow-instances",
            workflow.clone(),
            vec![],
        ));
        entry_points.push(served(
            "POST",
            &format!("{}/{{id}}/cancel", w.path),
            "workflow-instances",
            workflow,
            workflow_binding(&w.id).into_iter().collect(),
        ));
    }
    // Read models: the runtime binds the same paths the contracts publish (http.ts readModelRoutes).
    for v in &plans.contracts.views {
        if units.get(&v.id).is_some_and(|u| u.role == "view") {
            entry_points.push(route(&v.http.method, &v.http.path, &v.id));
        }
    }
    for p in &plans.contracts.projections {
        let Some(u) = units.get(&p.id).filter(|u| u.role == "projection") else {
            continue;
        };
        for (method, path) in [
            ("GET", format!("{}/status", p.path)),
            ("POST", format!("{}/rebuild", p.path)),
            ("GET", format!("{}/{{id}}", p.path)),
        ] {
            entry_points.push(route(method, &path, &p.id));
        }
        // The implicit `<Resource>.changes` channel feeds the projection inside the dispatcher.
        let subscription = format!("projection:{}", p.name);
        entry_points.push(EntryPoint {
            kind: "subscription".into(),
            id: subscription.clone(),
            trigger: json!({ "channel": format!("{}.changes", p.source), "messages": u.interface["consumes"].clone(), "subscription": subscription, "delivery": "in-process" }),
            root: Some(p.id.clone()),
            runtime_service: None,
            bindings: vec![],
        });
    }
    for c in &plans.contracts.caches {
        if units.get(&c.id).is_some_and(|u| u.role == "cache") {
            entry_points.push(route(&c.http.method, &c.http.path, &c.id));
        }
    }
    for s in &plans.contracts.schedules {
        // Status reads the source's ledger; a manual tick runs the scheduler (every due source).
        entry_points.push(served(
            "GET",
            &s.path,
            "schedule-status",
            json!({ "schedule": s.id }),
            vec![],
        ));
        if units.contains_key(&scheduler) {
            entry_points.push(route("POST", &format!("{}/tick", s.path), &scheduler));
        }
    }
    // Built-in routes (http.ts builtinRoutes).
    for (method, path) in [
        ("POST", "/v1/changesets"),
        ("GET", "/v1/changesets/{id}"),
        ("GET", "/v1/changesets/{id}/preview"),
        ("POST", "/v1/changesets/{id}/approve"),
        ("POST", "/v1/changesets/{id}/commit"),
    ] {
        entry_points.push(route(method, path, &changesets));
    }
    for path in ["/v1/imports/inspect", "/v1/imports/stage"] {
        entry_points.push(route("POST", path, &imports_svc));
    }
    for path in [
        "/v1/admin/export",
        "/v1/admin/import",
        "/v1/admin/verify",
        "/v1/admin/fence",
        "/v1/admin/subjects/locate",
        "/v1/admin/inspect",
    ] {
        entry_points.push(route("POST", path, &admin));
    }
    // Contract metadata (FORGE-056 discovery, OpenAPI, record workspace) projects the whole bundle.
    for path in [
        "/forge/discovery",
        "/forge/openapi.json",
        "/forge/workspace.json",
    ] {
        entry_points.push(served("GET", path, "contract-metadata", json!({}), vec![]));
    }
    // Signed object URLs: the Worker-served equivalent of presigned URLs (adapters/r2.ts).
    if own_resources.iter().any(|r| r.kind == "blob") {
        for method in ["GET", "PUT"] {
            entry_points.push(served(
                method,
                "/_forge/objects/{token}",
                "object-bytes",
                json!({}),
                vec![binding("r2", "BLOBS")],
            ));
        }
    }
    // A WebSocket upgrade is authenticated by the Worker and handed to the stream's object.
    for s in &plans.realtime.streams {
        entry_points.push(served(
            "GET",
            &s.path,
            "realtime-upgrade",
            json!({ "upgrade": "websocket", "channel": s.channel }),
            vec![binding(
                "durable-object",
                &plans.realtime.cloudflare.binding,
            )],
        ));
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
        let root = if units.contains_key(&s.source) {
            s.source.clone()
        } else {
            s.target.clone()
        };
        entry_points.push(EntryPoint {
            kind: "cron".into(),
            id: s.source.clone(),
            trigger: json!({ "cron": cron, "timezone": s.recurrence.timezone, "tick": s.cloudflare.tick }),
            root: Some(root),
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
    // The host's outbox/workflow sweep runs on every deployment, whatever its schedules. The
    // dispatch unit is its closure; a linker also runs post-commit dispatch with it.
    entry_points.push(EntryPoint {
        kind: "cron".into(),
        id: "forge:sweep".into(),
        trigger: json!({ "cron": SWEEP_CRON, "timezone": "UTC" }),
        root: units.contains_key(&dispatch).then(|| dispatch.clone()),
        runtime_service: Some("outbox-and-workflow-sweep".into()),
        bindings: vec![binding("cron", SWEEP_CRON)],
    });
    entry_points.sort_by(|a, b| (&a.kind, &a.id).cmp(&(&b.kind, &b.id)));
    let mut ids = BTreeSet::new();
    entry_points.retain(|e| ids.insert(e.id.clone()));

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
            // Allowed browser origins (hosts/cloudflare.ts); absent means no CORS headers.
            binding("var", "FORGE_CORS"),
        ],
        uncovered,
    }
}

fn uncovered_entry(kind: &str, id: &str, reason: String) -> Uncovered {
    Uncovered {
        kind: kind.into(),
        id: id.into(),
        reason,
    }
}

/// Adds a unit unless its symbol is taken (a declaration named like a runtime service), in which
/// case the surface is reported uncovered rather than silently merged.
fn insert_unit(
    units: &mut BTreeMap<String, PlannedUnit>,
    uncovered: &mut Vec<Uncovered>,
    unit: PlannedUnit,
) {
    if units.contains_key(&unit.symbol) {
        uncovered.push(uncovered_entry(
            &unit.role,
            &unit.symbol,
            format!(
                "a {} unit cannot take the symbol of an existing unit",
                unit.role
            ),
        ));
        return;
    }
    units.insert(unit.symbol.clone(), unit);
}

/// An import provided by another unit: `<kind>:<symbol>`.
fn unit_import(kind: &str, symbol: &str) -> CapabilityImport {
    CapabilityImport {
        capability: format!("{kind}:{symbol}"),
        provider: Provider::Unit {
            symbol: symbol.into(),
        },
    }
}

fn unit_dependencies(imports: &[CapabilityImport]) -> Vec<String> {
    sorted(imports.iter().filter_map(|i| match &i.provider {
        Provider::Unit { symbol } => Some(symbol.clone()),
        Provider::Runtime { .. } => None,
    }))
}

/// A declaration without its HTTP binding: routes are entry-point data, not behaviour.
fn declaration_digest(decl: &impl Serialize, drop: &[&str]) -> String {
    let mut v = serde_json::to_value(decl).expect("serialize");
    if let Some(o) = v.as_object_mut() {
        for k in drop {
            o.remove(*k);
        }
    }
    digest(IMPLEMENTATION_DOMAIN, &v)
}

fn read_model_unit(
    symbol: &str,
    role: &str,
    interface: Value,
    declaration: String,
    imports: Vec<CapabilityImport>,
) -> PlannedUnit {
    let imports = sorted(imports);
    PlannedUnit {
        symbol: symbol.into(),
        role: role.into(),
        kind: "forge-native".into(),
        interface_hash: digest(INTERFACE_DOMAIN, &interface),
        interface,
        implementation: json!({ "declaration": declaration }),
        dependencies: unit_dependencies(&imports),
        imports,
        bindings: vec![binding("d1", "DB")],
        wit: None,
        sources: vec![],
        anchor: Some(symbol.into()),
    }
}

/// A view lowers onto the source's bounded list for its `by` fields (readmodels.ts view()).
fn view_unit(
    scope: &Scope,
    v: &View,
    contract: Option<&crate::contracts::ViewContract>,
) -> Result<PlannedUnit, String> {
    let r = scope
        .resource(&v.source)
        .ok_or_else(|| format!("source {} is not a resource in scope", v.source))?;
    let list = r
        .lists
        .iter()
        .find(|l| l.fields == v.by)
        .ok_or_else(|| format!("{} has no list by ({})", r.name, v.by.join(", ")))?;
    let op = r
        .operations
        .iter()
        .find(|o| o.kind == "list" && o.query.as_deref() == Some(list.name.as_str()))
        .ok_or_else(|| format!("{} has no operation for list {}", r.name, list.name))?;
    let contract = contract.ok_or("no view contract")?;
    let caps = vec![unit_import("operation", &op.id)];
    let interface = json!({
        "readModel": "view",
        "params": contract.params,
        "record": contract.record,
        "order": contract.order,
        "errors": [],
        "effects": { "sends": [] },
        "capabilities": caps.iter().map(|i| &i.capability).collect::<Vec<_>>(),
    });
    Ok(read_model_unit(
        &v.id,
        "view",
        interface,
        declaration_digest(v, &["http"]),
        caps,
    ))
}

/// A projection applies `<source>.changes` events, reading the changed record from storage, and
/// rebuilds by paging the source's `list.all` (readmodels.ts applyEvent, rebuild).
fn projection_unit(
    scope: &Scope,
    p: &Projection,
    contract: Option<&crate::contracts::ProjectionContract>,
) -> Result<PlannedUnit, String> {
    let r = scope
        .resource(&p.source)
        .ok_or_else(|| format!("source {} is not a resource in scope", p.source))?;
    if !r.decorators.audited {
        return Err(format!(
            "source {} is not @audited, so it publishes no change events",
            r.name
        ));
    }
    let all = r
        .operations
        .iter()
        .find(|o| o.kind == "list" && o.query.as_deref() == Some("all"))
        .ok_or_else(|| format!("{} has no list.all to rebuild from", r.name))?;
    let contract = contract.ok_or("no projection contract")?;
    let caps = vec![
        unit_import("operation", &all.id),
        CapabilityImport {
            capability: format!("resource:{}#read", r.id),
            provider: runtime("resource-store"),
        },
    ];
    let interface = json!({
        "readModel": "projection",
        "by": contract.by,
        "record": contract.record,
        // What it consumes: the change messages of its source (engine.ts changeEvent).
        "consumes": ["Created", "Deleted", "Restored", "Transitioned", "Updated"],
        "errors": [],
        "effects": { "sends": [] },
        "capabilities": caps.iter().map(|i| &i.capability).collect::<BTreeSet<_>>(),
    });
    Ok(read_model_unit(
        &p.id,
        "projection",
        interface,
        declaration_digest(p, &["crud"]),
        caps,
    ))
}

/// A cache loads through `<Resource>.effective(...)` (readmodels.ts runLoader).
fn cache_unit(scope: &Scope, c: &Cache) -> Result<PlannedUnit, String> {
    let Expr::Call { callee, .. } = &c.loader else {
        return Err("only <Resource>.effective(...) loaders are executed".into());
    };
    let [resource, method] = callee.as_slice() else {
        return Err("only <Resource>.effective(...) loaders are executed".into());
    };
    if method != "effective" {
        return Err("only <Resource>.effective(...) loaders are executed".into());
    }
    let r = scope
        .irs
        .iter()
        .flat_map(|ir| ir.modules.iter().flat_map(|m| &m.resources))
        .find(|r| &r.name == resource)
        .ok_or_else(|| format!("loader resource {resource} is not in scope"))?;
    let op = r
        .operations
        .iter()
        .find(|o| o.kind == "effective")
        .ok_or_else(|| format!("{} has no effective operation", r.name))?;
    let caps = vec![unit_import("operation", &op.id)];
    let value = TypeSpec {
        base: TypeBase::Record {
            resource: r.id.clone(),
        },
        optional: true,
        normalizers: vec![],
        constraints: vec![],
        purpose: None,
        data_class: None,
    };
    let mut roots: Vec<&TypeSpec> = c.keys.iter().map(|k| &k.ty).collect();
    roots.push(&value);
    let interface = json!({
        "readModel": "cache",
        "keys": c.keys,
        "value": value,
        "errors": [],
        "effects": { "sends": [] },
        "capabilities": caps.iter().map(|i| &i.capability).collect::<Vec<_>>(),
        "types": scope.types(&roots),
    });
    Ok(read_model_unit(
        &c.id,
        "cache",
        interface,
        declaration_digest(c, &[]),
        caps,
    ))
}

/// A schedule runs its target at each occurrence its ledger has not recorded (schedules.ts).
fn schedule_unit(scope: &Scope, s: &Source) -> Result<PlannedUnit, String> {
    let kind = if scope.function(&s.target).is_some() {
        "function"
    } else if scope.irs.iter().any(|ir| {
        ir.modules
            .iter()
            .flat_map(|m| &m.workflows)
            .any(|w| w.id == s.target)
    }) {
        "workflow"
    } else {
        return Err(format!("target {} is not a function or workflow", s.target));
    };
    let caps = vec![unit_import(kind, &s.target)];
    // Callers rely on nothing but the trigger; cron and timezone are behaviour.
    let interface = json!({
        "trigger": "schedule",
        "errors": [],
        "effects": { "sends": [] },
        "capabilities": caps.iter().map(|i| &i.capability).collect::<Vec<_>>(),
    });
    let mut u = read_model_unit(
        &s.id,
        "schedule",
        interface,
        declaration_digest(s, &[]),
        caps,
    );
    u.anchor = Some(s.id.clone());
    Ok(u)
}

/// A runtime service unit: the runtime implements it (the executor version pins the code); the
/// planner owns what it may reach. Its declaration digest is the service name alone.
fn service_unit(
    symbol: &str,
    service: &str,
    imports: Vec<CapabilityImport>,
    bindings: Vec<Binding>,
) -> PlannedUnit {
    let imports = sorted(imports);
    let interface = json!({
        "service": service,
        "errors": [],
        "effects": { "sends": [] },
        "capabilities": imports.iter().map(|i| &i.capability).collect::<Vec<_>>(),
    });
    PlannedUnit {
        symbol: symbol.into(),
        role: "service".into(),
        kind: "forge-native".into(),
        interface_hash: digest(INTERFACE_DOMAIN, &interface),
        interface,
        implementation: json!({ "declaration": digest(IMPLEMENTATION_DOMAIN, &json!({ "service": service })) }),
        dependencies: unit_dependencies(&imports),
        imports,
        bindings: sorted(bindings),
        wit: None,
        sources: vec![],
        anchor: None,
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
    // An implementation sees its capabilities' types as much as its own signature's (FORG-36):
    // they enter the interface as the WIT world's imports carry them.
    let (surface, reached) = crate::wit::capability_surface(scope, &imports);
    let roots: Vec<&TypeSpec> = f
        .input
        .iter()
        .chain(f.output.iter())
        .chain(&reached)
        .collect();
    // Structural: no symbol (the manifest keeps it as the binding name) and no role, so units of the
    // same shape share an interface hash whatever they are called or wherever they are declared.
    let mut interface = json!({
        "input": f.input,
        "output": f.output,
        "errors": sorted(f.errors.iter().cloned()),
        "effects": { "sends": sorted(f.sends.iter().map(|s| format!("{}#{}", s.channel, s.message))) },
        "capabilities": sorted(imports.iter().map(|i| i.capability.clone())),
        "purpose": f.purpose,
        "types": scope.types(&roots),
    });
    // Only units with capabilities carry it, so a pure unit's interface hash is unchanged.
    if !surface.is_empty() {
        interface["capabilitySignatures"] = json!(surface);
    }
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
        sources: vec![],
        anchor: Some(f.id.clone()),
    }
}

fn operation_unit(
    scope: &Scope,
    r: &Resource,
    op: &Operation,
    sends_bindings: &dyn Fn(&str, &str) -> Vec<Binding>,
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
    // Audited resources publish one change event per commit on the implicit `<Resource>.changes`
    // channel (runtime engine.ts changeEvent, blobs.ts); projections consume it.
    let changes = change_message(r, &op.kind).map(|m| (format!("{}.changes", r.id), m));
    let interface = json!({
        "operation": { "kind": op.kind, "query": op.query, "action": op.action },
        "resource": r.id,
        "detail": detail,
        "errors": [],
        "effects": { "sends": changes.iter().map(|(c, m)| format!("{c}#{m}")).collect::<Vec<_>>() },
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
    let mut imports = vec![CapabilityImport {
        capability: format!("resource:{}#{}", r.id, storage_capability(&op.kind)),
        provider: runtime("resource-store"),
    }];
    if let Some((channel, message)) = &changes {
        imports.push(CapabilityImport {
            capability: format!("send:{channel}#{message}"),
            provider: runtime("outbox"),
        });
        bindings.extend(sends_bindings(channel, message));
    }
    PlannedUnit {
        symbol: op.id.clone(),
        role: "operation".into(),
        kind: "forge-native".into(),
        interface_hash: digest(INTERFACE_DOMAIN, &interface),
        interface,
        implementation,
        dependencies: vec![],
        imports: sorted(imports),
        bindings: sorted(bindings),
        wit: None,
        sources: vec![],
        anchor: Some(r.id.clone()),
    }
}

/// The message an operation publishes on its audited resource's implicit `<Resource>.changes`
/// channel, as the runtime names it. `move` and the blob upload steps commit as updates.
fn change_message(r: &Resource, kind: &str) -> Option<&'static str> {
    if !r.decorators.audited {
        return None;
    }
    match kind {
        "create" => Some("Created"),
        "update" | "move" | "beginUpload" | "finalizeUpload" => Some("Updated"),
        "delete" => Some("Deleted"),
        "restore" => Some("Restored"),
        "transition" => Some("Transitioned"),
        _ => None,
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
        sources: vec![],
        anchor: Some(w.id.clone()),
    }
}
