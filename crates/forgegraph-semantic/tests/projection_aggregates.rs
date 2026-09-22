use forgegraph_semantic::{Package, compile, load_package};
use std::path::Path;
#[test]
fn portfolio_has_typed_conditional_aggregates() {
    let path = Path::new(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../examples/project-portfolio"
    ));
    let c = compile(&load_package(path).unwrap(), &[]);
    assert!(c.ir.is_some(), "{}", c.render());
    let ir = c.ir.unwrap();
    assert!(ir.requires.contains(&"projection-aggregates/1".into()));
    let p = &ir.modules[0].projections[0];
    assert_eq!(
        p.aggregates.iter().filter(|a| a.filter.is_some()).count(),
        4
    );
    assert!(p.aggregates.iter().any(|a| a.function == "latest"));
}
#[test]
fn aggregate_types_and_predicate_fields_are_checked() {
    for aggregate in [
        "sum title as total",
        "min title as minimum",
        "count items where unknown == 1",
    ] {
        let src = format!(
            "resource R @versioned {{ id : id\n group : text\n title : text }}\nprojection P {{ from R\n by group\n {aggregate}\n}}"
        );
        let c = compile(
            &Package::inline("@test/projection", vec![("src/a.forge".into(), src)]),
            &[],
        );
        assert!(c.ir.is_none(), "{aggregate}");
    }
}

#[test]
fn changes_require_a_new_generation() {
    let old = serde_json::json!({"ir":{"modules":[{"projections":[{"id":"P","source":"R","by":["project"],"aggregates":[{"function":"count","alias":"open"}]}]}]}});
    let mut new = old.clone();
    new["ir"]["modules"][0]["projections"][0]["aggregates"][0]["filter"] =
        serde_json::json!({"kind":"literal","literal":{"type":"bool","value":true}});
    let report = forgegraph_semantic::diff::compare(&old, &new);
    assert!(
        report
            .findings
            .iter()
            .any(|f| f.code == "projection-definition-changed"
                && f.needs.contains(&"rebuild-projection-generation"))
    );
}
