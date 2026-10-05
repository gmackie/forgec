use forgegraph_semantic::{Package, compile, load_package};
use std::path::Path;
#[test]
fn sequence_fields_are_server_owned_and_partition_is_immutable() {
    let c = compile(
        &load_package(Path::new(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../examples/issue-numbers"
        )))
        .unwrap(),
        &[],
    );
    assert!(c.ir.is_some(), "{}", c.render());
    let ir = c.ir.unwrap();
    assert!(ir.requires.contains(&"sequences/1".into()));
    let r = &ir.modules[0].resources[0];
    let number = r.fields.iter().find(|f| f.name == "number").unwrap();
    assert!(number.server_owned && number.immutable);
    assert_eq!(
        number.sequence.as_ref().unwrap().partition.as_deref(),
        Some("project")
    );
    assert!(
        r.fields
            .iter()
            .find(|f| f.name == "project")
            .unwrap()
            .immutable
    );
}
#[test]
fn invalid_sequence_declarations_are_rejected() {
    for field in [
        "number : text @sequence",
        "number : integer? @sequence",
        "number : integer @sequence(start: 0)",
        "number : integer @sequence(start: 8, max: 3)",
        "number : integer @sequence(partition: missing)",
        "number : integer @sequence @sequence",
    ] {
        let c = compile(
            &Package::inline(
                "@test/sequences",
                vec![(
                    "src/a.forge".into(),
                    format!("resource R {{ id : id\n{field}\n}}"),
                )],
            ),
            &[],
        );
        assert!(c.ir.is_none(), "accepted {field}");
    }
}
