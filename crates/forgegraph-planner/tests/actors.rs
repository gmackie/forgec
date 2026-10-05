use forgegraph_semantic::{compile, load_package};
use std::path::Path;
#[test]
fn actors_are_typed_and_require_an_explicit_preview_profile() {
    let c = compile(
        &load_package(Path::new(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../examples/actors"
        )))
        .unwrap(),
        &[],
    );
    assert!(c.ir.is_some(), "{}", c.render());
    let mut ir = c.ir.unwrap();
    assert_eq!(ir.modules[0].actors.len(), 3);
    assert!(ir.requires.contains(&"actors/1".into()));
    assert!(forgegraph_planner::plan(&ir).is_ok());
    ir.package.profile = "portable-v1".into();
    assert_eq!(
        forgegraph_planner::plan(&ir).unwrap_err().code,
        "E-PLAN-ACTOR-001"
    );
    ir.package.profile = "actor-preview".into();
    ir.package.targets = vec!["aws-dynamodb".into()];
    assert!(forgegraph_planner::plan(&ir).is_err());
}
