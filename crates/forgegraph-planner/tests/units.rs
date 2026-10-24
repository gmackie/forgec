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
