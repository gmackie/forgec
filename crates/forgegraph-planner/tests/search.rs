use forgegraph_semantic::{Package, compile, load_package};
use std::path::Path;
#[test]
fn exact_search_has_physical_indexes_and_generated_route() {
    let ir = compile(
        &load_package(Path::new(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../examples/search"
        )))
        .unwrap(),
        &[],
    )
    .ir
    .unwrap();
    assert!(ir.requires.contains(&"search-exact/1".into()));
    let plan = forgegraph_planner::plan(&ir).unwrap();
    let sql = forgegraph_planner::sql::render_sqlite(&plan.sql);
    assert!(sql.contains("search_by_project_title"), "{sql}");
    let contracts = serde_json::to_string(&plan.contracts).unwrap();
    assert!(
        contracts.contains("/v1/issues/search/by-project-title"),
        "{contracts}"
    );
    assert!(contracts.contains("\"searchMode\":\"exact\""));
}
#[test]
fn unsupported_modes_and_unbounded_text_are_rejected() {
    for (mode, ty) in [
        ("prefix", "text length <= 128"),
        ("tokenized", "text length <= 128"),
        ("exact", "text"),
    ] {
        let c = compile(
            &Package::inline(
                "@test/search",
                vec![(
                    "src/a.forge".into(),
                    format!("resource R {{id : id\n title : {ty}\n search {mode} by title\n}}"),
                )],
            ),
            &[],
        );
        if let Some(ir) = c.ir {
            assert!(forgegraph_planner::plan(&ir).is_err());
        }
    }
}
