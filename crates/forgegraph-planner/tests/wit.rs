//! WIT worlds generated from DomainIR (FORG-31): the world a WASM component implements for a
//! function unit, its lowering, and the diagnostics for interfaces WIT cannot carry.
use forgegraph_planner::{plan, units, wit::UnitWit};
use forgegraph_semantic::{DomainIR, Package, compile, load_package};
use std::path::Path;

fn examples() -> &'static Path {
    Path::new(concat!(env!("CARGO_MANIFEST_DIR"), "/../../examples"))
}

fn compile_dir(name: &str, deps: &[&DomainIR]) -> DomainIR {
    compile(&load_package(&examples().join(name)).unwrap(), deps)
        .ir
        .unwrap()
}

fn compile_inline(src: &str) -> DomainIR {
    let pkg = Package::inline("@t/wit", vec![("src/index.forge".into(), src.into())]);
    let out = compile(&pkg, &[]);
    assert!(
        out.diagnostics.iter().all(|d| !d.is_error()),
        "{:#?}",
        out.diagnostics
    );
    out.ir.unwrap()
}

fn unit_plan(ir: &DomainIR, deps: &[&DomainIR]) -> units::UnitPlan {
    units::plan(ir, deps, &plan(ir).unwrap())
}

fn wit_of<'a>(p: &'a units::UnitPlan, name: &str) -> &'a UnitWit {
    p.units
        .iter()
        .find(|u| u.symbol.ends_with(&format!("/{name}")))
        .unwrap_or_else(|| panic!("no unit {name}"))
        .wit
        .as_ref()
        .unwrap_or_else(|| panic!("{name} has no wit"))
}

fn world<'a>(p: &'a units::UnitPlan, name: &str) -> &'a str {
    match wit_of(p, name) {
        UnitWit::Ok { world, .. } => world,
        UnitWit::Unsupported { diagnostics } => panic!("{name}: {diagnostics:#?}"),
    }
}

fn diagnostics(src: &str, name: &str) -> Vec<String> {
    let ir = compile_inline(src);
    let p = unit_plan(&ir, &[]);
    match wit_of(&p, name) {
        UnitWit::Ok { world, .. } => panic!("{name} unexpectedly lowered:\n{world}"),
        UnitWit::Unsupported { diagnostics } => diagnostics.iter().map(|d| d.to_string()).collect(),
    }
}

#[test]
fn pricing_quote_order_world_and_lowering() {
    let ir = compile_dir("pricing", &[]);
    let p = unit_plan(&ir, &[]);
    insta::assert_snapshot!("pricing_quote_order_wit", world(&p, "QuoteOrder"));
    let UnitWit::Ok {
        lowering, digest, ..
    } = wit_of(&p, "QuoteOrder")
    else {
        unreachable!()
    };
    insta::assert_json_snapshot!("pricing_quote_order_lowering", lowering);
    assert!(digest.starts_with("sha256:"));
}

#[test]
fn committed_component_wit_matches_the_generated_world() {
    // The Rust unit is built against a checked-in copy; it must never drift from the compiler.
    let ir = compile_dir("pricing", &[]);
    let p = unit_plan(&ir, &[]);
    let committed =
        std::fs::read_to_string(examples().join("pricing/impl/quote-order-rs/wit/unit.wit"))
            .unwrap();
    assert_eq!(
        committed,
        world(&p, "QuoteOrder"),
        "regenerate with `forgec wit examples/pricing --unit QuoteOrder > examples/pricing/impl/quote-order-rs/wit/unit.wit`"
    );
}

#[test]
fn acme_capabilities_become_imported_interfaces() {
    let pay = compile_dir("payments", &[]);
    let ir = compile_dir("acme", &[&pay]);
    let p = unit_plan(&ir, &[&pay]);
    insta::assert_snapshot!("acme_submit_order_wit", world(&p, "SubmitOrder"));
    insta::assert_snapshot!("acme_fulfill_order_wit", world(&p, "FulfillOrder"));
    // No input, output or errors, but a capability: only a handle fault can fail it.
    assert!(world(&p, "RebuildOrderSummary").contains("export run: func() -> result<_, failure>;"));
    // Only implemented functions get a world; generated operations and workflows run forge-native.
    for u in &p.units {
        assert_eq!(
            u.wit.is_some(),
            u.role == "function" || u.role == "external",
            "{}",
            u.symbol
        );
    }
}

#[test]
fn same_interface_same_world() {
    let src = r#"
shape In {
  amount : money<USD> >= 0
}
shape Out {
  total : money<USD>
}
function Alpha {
  input In
  output Out
  errors {
    Nope
  }
}
function Beta {
  input In
  output Out
  errors {
    Nope
  }
}
"#;
    let ir = compile_inline(src);
    let p = unit_plan(&ir, &[]);
    assert_eq!(wit_of(&p, "Alpha"), wit_of(&p, "Beta"));
    // A different error set is a different world.
    let changed = compile_inline(&src.replacen("    Nope\n", "    Nope\n    Again\n", 1));
    let q = unit_plan(&changed, &[]);
    assert_ne!(wit_of(&q, "Alpha"), wit_of(&q, "Beta"));
}

#[test]
fn every_lowered_type_kind() {
    let src = r#"
enum Kind {
  Record = "record"
  PlainText = "plain-text"
}
resource Note @crud("/v1/notes") {
  id : id
  title : text length 1..200
  lifecycle status {
    initial Open
    terminal Closed
    close: Open -> Closed
      input {
        reason : text length 1..100
      }
  }
}
shape Everything {
  note : Note
  kind : Kind
  count : integer
  ratio : decimal<4>
  flag : boolean
  day : date
  at : datetime
  local : localTime
  wait : duration
  mail : email?
  site : url
  zone : timezone
  country : countryCode
  tags : set<text> length <= 8
  scores : map<text, integer> length <= 8
  grid : list<list<integer> length <= 4> length <= 4
}
function Kitchen {
  input Everything
  output Note.Record
  uses {
    Note read
    Note.status.close
  }
  errors {
    Type
  }
}
"#;
    let ir = compile_inline(src);
    let p = unit_plan(&ir, &[]);
    insta::assert_snapshot!("every_lowered_type_kind_wit", world(&p, "Kitchen"));
}

#[test]
fn json_has_no_wit_type() {
    let d = diagnostics(
        "shape In {\n  payload : json\n}\nfunction Opaque {\n  input In\n}\n",
        "Opaque",
    );
    assert_eq!(
        d,
        [
            "error[E-WIT-001]: input.payload: `json` has no WIT type: an untyped value cannot cross a typed component boundary; declare a shape for it"
        ]
    );
}

#[test]
fn resource_writes_have_no_wit_lowering_yet() {
    let d = diagnostics(
        "resource Note @crud(\"/v1/notes\") {\n  id : id\n  title : text length 1..200\n}\nfunction Touch {\n  uses {\n    Note write\n  }\n}\n",
        "Touch",
    );
    assert_eq!(d.len(), 1, "{d:#?}");
    assert!(d[0].starts_with("error[E-WIT-005]: capability resource:@t/wit/_/Note#write: `write` handles have no WIT lowering yet"), "{d:#?}");
}

#[test]
fn an_error_named_fault_collides_with_capability_faults() {
    let d = diagnostics(
        "resource Note @crud(\"/v1/notes\") {\n  id : id\n  title : text length 1..200\n}\nfunction Look {\n  uses {\n    Note read\n  }\n  errors {\n    Fault\n  }\n}\n",
        "Look",
    );
    assert_eq!(
        d,
        [
            "error[E-WIT-003]: errors: error `Fault` collides with the `fault` case that carries capability failures"
        ]
    );
}

#[test]
fn colliding_field_names_are_refused() {
    let d = diagnostics(
        "shape In {\n  taxRate : integer\n  tax_rate : integer\n}\nfunction Twice {\n  input In\n}\n",
        "Twice",
    );
    assert_eq!(
        d,
        [
            "error[E-WIT-003]: input.tax_rate: fields `taxRate` and `tax_rate` of `@t/wit/_/In` both lower to the WIT field `tax-rate`"
        ]
    );
}
