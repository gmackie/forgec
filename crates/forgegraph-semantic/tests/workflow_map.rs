use forgegraph_semantic::{Package, compile, load_package};
use std::path::Path;
#[test]
fn maps_are_typed_and_change_the_pinned_graph() {
    let package = load_package(Path::new(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../examples/workflow-map"
    )))
    .unwrap();
    let c = compile(&package, &[]);
    assert!(c.ir.is_some(), "{}", c.render());
    let ir = c.ir.unwrap();
    assert!(ir.requires.contains(&"workflow-map/1".into()));
    assert!(matches!(
        ir.modules[0].workflows[0].steps[0],
        forgegraph_semantic::ir::Step::Map {
            concurrency: 4,
            max_items: 32,
            ..
        }
    ));
    let source = std::fs::read_to_string(Path::new(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../examples/workflow-map/src/model.forge"
    )))
    .unwrap();
    let changed = compile(
        &Package::inline(
            "@dogfood/workflow-map",
            vec![(
                "src/model.forge".into(),
                source.replace("concurrency 4", "concurrency 2"),
            )],
        ),
        &[],
    )
    .ir
    .unwrap();
    assert_ne!(
        ir.modules[0].workflows[0].graph_hash,
        changed.modules[0].workflows[0].graph_hash
    );
}
#[test]
fn invalid_map_inputs_and_concurrency_are_rejected() {
    let source = std::fs::read_to_string(Path::new(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../examples/workflow-map/src/model.forge"
    )))
    .unwrap();
    for modified in [
        source.replace("concurrency 4", "concurrency 0"),
        source.replace("concurrency 4", "concurrency 33"),
        source.replace("in input.candidates", "in input.missing"),
        source.replace("list<integer> length <= 32", "integer"),
    ] {
        let c = compile(
            &Package::inline("@test/map", vec![("src/a.forge".into(), modified)]),
            &[],
        );
        assert!(c.ir.is_none(), "invalid map compiled");
    }
}
