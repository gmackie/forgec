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

/// `latest` always names its ordering; write order is never inferred (#198).
#[test]
fn latest_requires_an_explicit_orderable_ordering_field() {
    let compile_with = |aggregate: &str| {
        let src = format!(
            "resource R @versioned {{ id : id\n group : text\n value : integer\n at : datetime\n maybe : datetime?\n label : text }}\nprojection P {{ from R\n by group\n {aggregate}\n}}"
        );
        compile(
            &Package::inline("@test/projection", vec![("src/a.forge".into(), src)]),
            &[],
        )
    };
    let ok = compile_with("latest value by at as current");
    assert!(ok.ir.is_some(), "{}", ok.render());
    let ir = ok.ir.unwrap();
    let aggregate = &ir.modules[0].projections[0].aggregates[0];
    assert_eq!(
        (aggregate.alias.as_str(), aggregate.by.as_deref()),
        ("current", Some("at"))
    );
    for bad in [
        "latest value as current",
        "latest value by label as current",
        "latest value by maybe as current",
        "latest value by missing as current",
    ] {
        let c = compile_with(bad);
        assert!(
            c.diagnostics.iter().any(|d| d.code == "E-PROJ-006"),
            "{bad}: {}",
            c.render()
        );
    }
    // Only `latest` takes an ordering field; elsewhere `by` is not part of an aggregate.
    assert!(compile_with("max value by at as top").ir.is_none());
}
