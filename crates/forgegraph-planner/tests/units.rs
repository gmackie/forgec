//! Composable-unit plan (FORG-28): unit boundaries for the reference app, and which edits move
//! a unit's interface hash. Implementation bytes of `impl/` units are hashed by
//! `@forgegraph/units`; here only forge-native implementation digests are checked.
use forgegraph_planner::{plan, units};
use forgegraph_semantic::{DomainIR, Package, compile, load_package};
use std::path::Path;

fn acme() -> units::UnitPlan {
    let ex = Path::new(concat!(env!("CARGO_MANIFEST_DIR"), "/../../examples"));
    let pay = compile(&load_package(&ex.join("payments")).unwrap(), &[])
        .ir
        .unwrap();
    let ir = compile(&load_package(&ex.join("acme")).unwrap(), &[&pay])
        .ir
        .unwrap();
    units::plan(&ir, &[&pay], &plan(&ir).unwrap())
}

fn compile_inline(src: &str) -> DomainIR {
    let pkg = Package::inline("@t/units", vec![("src/index.forge".into(), src.into())]);
    let out = compile(&pkg, &[]);
    assert!(
        out.diagnostics.iter().all(|d| !d.is_error()),
        "{:#?}",
        out.diagnostics
    );
    out.ir.unwrap()
}

fn unit_plan(src: &str) -> units::UnitPlan {
    let ir = compile_inline(src);
    units::plan(&ir, &[], &plan(&ir).unwrap())
}

fn unit<'a>(p: &'a units::UnitPlan, name: &str) -> &'a units::PlannedUnit {
    p.units
        .iter()
        .find(|u| u.symbol.ends_with(&format!("/{name}")))
        .unwrap_or_else(|| panic!("no unit {name}"))
}

const BASE: &str = r#"
resource Ticket @crud("/v1/tickets") {
  id : id
  title : text length 1..200
  rules {
    title != ""
  }
  lifecycle status {
    initial Open
    terminal Closed
    close: Open -> Closed
  }
}

shape EscalateInput {
  ticket : Ticket
  reason : text length 1..500
}

/// Escalates a ticket.
function Escalate
  @http(POST, "/v1/tickets/{ticket}/escalate")
{
  input EscalateInput
  output Ticket.Record
  uses {
    Ticket read
    Ticket.status.close
  }
  errors {
    AlreadyClosed
  }
}

workflow Resolve {
  input EscalateInput
  output Ticket.Record
  version 1
  step escalate = Escalate(ticket: input.ticket, reason: input.reason)
  step pause = sleep 5s
  return escalate
}
"#;

#[test]
fn acme_units_cover_functions_externals_operations_and_workflows() {
    let p = acme();
    let summary: Vec<String> = p
        .units
        .iter()
        .map(|u| format!("{} {} {} -> {:?}", u.kind, u.role, u.symbol, u.dependencies))
        .collect();
    insta::assert_json_snapshot!("acme_units", summary);
    let js: Vec<&str> = p
        .units
        .iter()
        .filter(|u| u.kind == "js-module")
        .map(|u| u.symbol.as_str())
        .collect();
    assert_eq!(
        js,
        [
            "@acme/commerce/_/FulfillOrder",
            "@acme/commerce/_/RebuildOrderSummary",
            "@acme/commerce/_/SubmitOrder",
            "@acme/payments/_/AuthorizePayment",
        ]
    );
    // Every entry point with a root names a planned unit; every dependency resolves.
    let symbols: std::collections::BTreeSet<&str> =
        p.units.iter().map(|u| u.symbol.as_str()).collect();
    for e in &p.entry_points {
        if let Some(root) = &e.root {
            assert!(symbols.contains(root.as_str()), "{} -> {root}", e.id);
        }
    }
    for u in &p.units {
        for d in &u.dependencies {
            assert!(symbols.contains(d.as_str()), "{} -> {d}", u.symbol);
        }
    }
}

#[test]
fn unit_plan_is_deterministic() {
    let a = serde_json::to_string(&acme()).unwrap();
    let b = serde_json::to_string(&acme()).unwrap();
    assert_eq!(a, b);
}

#[test]
fn interface_hash_ignores_docs_routes_and_rules() {
    let base = unit_plan(BASE);
    let edited = unit_plan(
        &BASE
            .replace(
                "/// Escalates a ticket.",
                "/// Escalates a ticket to a human.",
            )
            .replace("/v1/tickets/{ticket}/escalate", "/v1/escalations/{ticket}")
            .replace("title != \"\"", "title != \"-\""),
    );
    for name in [
        "Escalate",
        "Resolve",
        "Ticket.status.close",
        "Ticket.create",
    ] {
        assert_eq!(
            unit(&base, name).interface_hash,
            unit(&edited, name).interface_hash,
            "{name}"
        );
    }
    // A rule is behaviour: the generated operations' implementation digest moves, the interface does not.
    assert_ne!(
        unit(&base, "Ticket.create").implementation,
        unit(&edited, "Ticket.create").implementation
    );
}

#[test]
fn interface_hash_moves_with_the_signature() {
    let base = unit_plan(BASE);
    let cases = [
        // error set
        BASE.replace("    AlreadyClosed\n", "    AlreadyClosed\n    Locked\n"),
        // a field of the input shape, reached transitively
        BASE.replace("reason : text length 1..500", "reason : text length 1..800"),
        // required capabilities
        BASE.replace("    Ticket read\n", "    Ticket write\n"),
    ];
    for edited in &cases {
        let edited = unit_plan(edited);
        assert_ne!(
            unit(&base, "Escalate").interface_hash,
            unit(&edited, "Escalate").interface_hash
        );
    }
    // The workflow shares EscalateInput, so its interface moves with the shape too.
    let widened = unit_plan(&BASE.replace("reason : text length 1..500", "reason : text"));
    assert_ne!(
        unit(&base, "Resolve").interface_hash,
        unit(&widened, "Resolve").interface_hash
    );
}

#[test]
fn workflow_graph_is_implementation_not_interface() {
    let base = unit_plan(BASE);
    let edited = unit_plan(&BASE.replace("sleep 5s", "sleep 10s"));
    let (a, b) = (unit(&base, "Resolve"), unit(&edited, "Resolve"));
    assert_eq!(a.interface_hash, b.interface_hash);
    assert_ne!(a.implementation, b.implementation);
    assert_eq!(a.dependencies, ["@t/units/_/Escalate"]);
}

#[test]
fn function_units_import_capabilities_from_uses() {
    let p = unit_plan(BASE);
    let f = unit(&p, "Escalate");
    assert_eq!(f.kind, "js-module");
    let caps: Vec<&str> = f.imports.iter().map(|i| i.capability.as_str()).collect();
    assert_eq!(
        caps,
        [
            "resource:@t/units/_/Ticket#read",
            "transition:@t/units/_/Ticket.status.close"
        ]
    );
    assert_eq!(f.dependencies, ["@t/units/_/Ticket.status.close"]);
}

#[test]
fn interface_hash_is_structural_not_nominal() {
    // Two functions with the same signature and different names share an interface: either body
    // (a JS module or a WASM component of the same shape) can be bound to either symbol.
    let twin = BASE.replace(
        "workflow Resolve {",
        "function Reopen {\n  input EscalateInput\n  output Ticket.Record\n  uses {\n    Ticket read\n    Ticket.status.close\n  }\n  errors {\n    AlreadyClosed\n  }\n}\n\nworkflow Resolve {",
    );
    let p = unit_plan(&twin);
    let (a, b) = (unit(&p, "Escalate"), unit(&p, "Reopen"));
    assert_ne!(a.symbol, b.symbol);
    assert_eq!(a.interface_hash, b.interface_hash);
    // The symbol stays the binding name; a different signature still differs.
    let other = unit_plan(&twin.replace(
        "  errors {\n    AlreadyClosed\n  }\n}\n\nworkflow",
        "  errors {\n    Locked\n  }\n}\n\nworkflow",
    ));
    assert_ne!(
        unit(&other, "Escalate").interface_hash,
        unit(&other, "Reopen").interface_hash
    );
}

#[test]
fn acme_covers_every_runtime_surface() {
    let p = acme();
    assert!(p.uncovered.is_empty(), "{:?}", p.uncovered);
    let ids: std::collections::BTreeSet<&str> =
        p.entry_points.iter().map(|e| e.id.as_str()).collect();
    for id in [
        "GET /v1/views/pending-orders",
        "GET /v1/customer-order-summaries/status",
        "POST /v1/customer-order-summaries/rebuild",
        "GET /v1/customer-order-summaries/{id}",
        "GET /v1/caches/current-site-policy",
        "GET /v1/schedules/nightly-reconciliation",
        "POST /v1/schedules/nightly-reconciliation/tick",
        "POST /v1/changesets",
        "GET /v1/changesets/{id}/preview",
        "POST /v1/imports/inspect",
        "POST /v1/admin/fence",
        "GET /forge/workspace.json",
        "PUT /_forge/objects/{token}",
        "GET /v1/live/orders",
        "projection:CustomerOrderSummary",
        "forge:sweep",
    ] {
        assert!(ids.contains(id), "{id}");
    }
    let root = |id: &str| {
        p.entry_points
            .iter()
            .find(|e| e.id == id)
            .unwrap()
            .root
            .clone()
    };
    assert_eq!(
        root("forge:sweep").as_deref(),
        Some("@acme/commerce/_/dispatch")
    );
    assert_eq!(
        root("POST /v1/schedules/nightly-reconciliation/tick").as_deref(),
        Some("@acme/commerce/_/schedules")
    );
    assert_eq!(root("GET /v1/schedules/nightly-reconciliation"), None);
    // Read models reach their source through generated operations.
    assert_eq!(
        unit(&p, "PendingOrders").dependencies,
        ["@acme/commerce/_/Order.list.byCustomer"]
    );
    assert_eq!(
        unit(&p, "CurrentSitePolicy").dependencies,
        ["@acme/commerce/_/SitePolicy.effective.bySite"]
    );
    // The dispatcher reaches every subscriber: projections, workflows, schedules, queues, streams.
    let dispatch: Vec<&str> = unit(&p, "dispatch")
        .imports
        .iter()
        .map(|i| i.capability.as_str())
        .collect();
    assert_eq!(
        dispatch,
        [
            "deliver:fulfill-order",
            "deliver:realtime:@acme/commerce/_/OrderEvents",
            "projection:@acme/commerce/_/CustomerOrderSummary",
            "service:@acme/commerce/_/schedules",
            "workflow:@acme/commerce/_/ProcessOrder",
        ]
    );
    // A changeset may name any operation: every operation of every (non-credential) resource.
    let ops = p.units.iter().filter(|u| u.role == "operation").count();
    assert_eq!(unit(&p, "changesets").dependencies.len(), ops);
    // Audited resources publish the implicit `<Resource>.changes` channel.
    let create = unit(&p, "Order.create");
    assert_eq!(
        create.interface["effects"]["sends"],
        serde_json::json!(["@acme/commerce/_/Order.changes#Created"])
    );
    assert!(
        create
            .imports
            .iter()
            .any(|i| i.capability == "send:@acme/commerce/_/Order.changes#Created")
    );
    let cancel = p
        .entry_points
        .iter()
        .find(|e| e.id == "POST /v1/workflows/process-order/{id}/cancel")
        .unwrap();
    assert_eq!(cancel.bindings.len(), 1);
    assert_eq!(cancel.bindings[0].name, "WF_PROCESS_ORDER");
    assert!(p.host_bindings.iter().any(|b| b.name == "FORGE_CORS"));
}

#[test]
fn git_blob_is_git_hash_object() {
    // `printf '' | git hash-object --stdin`, `printf 'hello\n' | git hash-object --stdin`
    assert_eq!(
        units::git_blob(b""),
        "e69de29bb2d1d6434b8b29ae775ad8c2e48c5391"
    );
    assert_eq!(
        units::git_blob(b"hello\n"),
        "ce013625030ba8dba906f756967f9e9ca394464a"
    );
}

fn sourced(src: &str) -> units::UnitPlan {
    let pkg = Package::inline("@t/units", vec![("src/index.forge".into(), src.into())]);
    let out = compile(&pkg, &[]);
    let ir = out.ir.clone().unwrap();
    let mut p = units::plan(&ir, &[], &plan(&ir).unwrap());
    let own = units::PackageSources {
        package: pkg.name.clone(),
        files: pkg
            .files
            .iter()
            .map(|f| (f.path.clone(), f.text.clone()))
            .collect(),
        index: out.source_index.clone(),
    };
    units::attach_sources(&mut p, &own, &[]);
    p
}

#[test]
fn source_spans_locate_declarations_and_never_enter_a_hash() {
    let base = sourced(BASE);
    let f = unit(&base, "Escalate");
    assert_eq!(f.sources.len(), 1);
    let s = &f.sources[0];
    assert_eq!(
        (s.part.as_str(), s.path.as_str()),
        ("declaration", "src/index.forge")
    );
    assert!(
        BASE[s.start..s.end].contains("function Escalate"),
        "{}",
        &BASE[s.start..s.end]
    );
    assert_eq!(s.git_blob, units::git_blob(BASE.as_bytes()));
    // A generated operation is located at its resource.
    let op = &unit(&base, "Ticket.create").sources[0];
    assert!(BASE[op.start..op.end].starts_with("resource Ticket"));
    // Moving every declaration down changes spans and blob hashes, and no hash of any unit.
    let moved_src = format!("// moved\n{BASE}");
    let moved = sourced(&moved_src);
    for (a, b) in base.units.iter().zip(&moved.units) {
        assert_eq!(a.symbol, b.symbol);
        assert_eq!(a.interface_hash, b.interface_hash, "{}", a.symbol);
        assert_eq!(a.implementation, b.implementation, "{}", a.symbol);
        for (x, y) in a.sources.iter().zip(&b.sources) {
            assert_eq!(y.start, x.start + "// moved\n".len());
            assert_ne!(x.git_blob, y.git_blob);
        }
    }
}
