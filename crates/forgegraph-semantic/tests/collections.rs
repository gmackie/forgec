use forgegraph_semantic::{Package, compile, load_package};
use std::path::Path;

#[test]
fn bounded_collections_preserve_nested_types_and_classification() {
    let c = compile(
        &load_package(Path::new(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../examples/collections"
        )))
        .unwrap(),
        &[],
    );
    assert!(c.ir.is_some(), "{}", c.render());
    let ir = c.ir.unwrap();
    assert!(ir.requires.contains(&"collections/1".into()));
    let json = serde_json::to_string(&ir).unwrap();
    assert!(json.contains("ContactEmail"));
    assert!(json.contains("\"collection\":\"map\""));
}

#[test]
fn unbounded_or_invalid_collections_are_rejected() {
    for ty in [
        "list<text>",
        "set<text> length <= 1025",
        "map<integer,text> length <= 8",
        "list<text> length 9..2",
    ] {
        let c = compile(
            &Package::inline(
                "@test/collections",
                vec![(
                    "src/a.forge".into(),
                    format!("resource R {{ id : id\n values : {ty}\n}}"),
                )],
            ),
            &[],
        );
        assert!(c.ir.is_none(), "accepted {ty}");
    }
}

#[test]
fn recursive_aliases_report_an_error_instead_of_overflowing() {
    let c = compile(
        &Package::inline(
            "@test/cycle",
            vec![(
                "src/a.forge".into(),
                "type A = B\ntype B = A\nresource R { id : id\n values : list<A> length <= 2\n}"
                    .into(),
            )],
        ),
        &[],
    );
    assert!(c.ir.is_none());
}

#[test]
fn collection_changes_require_codec_review() {
    let old = serde_json::json!({"ir":{"modules":[{"resources":[{"id":"R","fields":[{"name":"items","type":{"base":{"kind":"collection","collection":"list"}}}]}]}]}});
    let mut new = old.clone();
    new["ir"]["modules"][0]["resources"][0]["fields"][0]["type"]["base"]["collection"] =
        "set".into();
    let report = forgegraph_semantic::diff::compare(&old, &new);
    assert!(
        report
            .findings
            .iter()
            .any(|f| f.code == "collection-type-changed" && f.direction == Some("both"))
    );
}
