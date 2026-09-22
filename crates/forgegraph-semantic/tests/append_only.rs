use forgegraph_semantic::{Package, compile};

#[test]
fn append_only_exposes_only_creation_and_reads() {
    let c = compile(
        &Package::inline(
            "@test/append",
            vec![(
                "src/a.forge".into(),
                "resource Pin @appendOnly @crud(\"/pins\") { id : id\n value : text\n}".into(),
            )],
        ),
        &[],
    );
    assert!(c.ir.is_some(), "{}", c.render());
    let ir = c.ir.unwrap();
    assert!(ir.requires.contains(&"append-only/1".into()));
    let r = &ir.modules[0].resources[0];
    assert!(r.fields.iter().all(|f| f.immutable));
    assert!(
        r.operations
            .iter()
            .all(|op| matches!(op.kind.as_str(), "create" | "get" | "list"))
    );
    assert!(r.operations.iter().any(|op| op.kind == "create"));
}

#[test]
fn append_only_rejects_mutable_resource_features() {
    for decorator in ["@softDelete", "@hierarchical"] {
        let c = compile(
            &Package::inline(
                "@test/append",
                vec![(
                    "src/a.forge".into(),
                    format!("resource Pin @appendOnly {decorator} {{ id : id\n value : text\n}}"),
                )],
            ),
            &[],
        );
        assert!(c.ir.is_none());
        assert!(c.render().contains("E-APPEND-001"));
    }
}

#[test]
fn changing_append_only_requires_migration_review() {
    let old = serde_json::json!({"ir":{"modules":[{"resources":[{"id":"Pin","decorators":{"appendOnly":true}}]}]}});
    let mut new = old.clone();
    new["ir"]["modules"][0]["resources"][0]["decorators"]["appendOnly"] = false.into();
    assert!(
        forgegraph_semantic::diff::compare(&old, &new)
            .findings
            .iter()
            .any(|f| f.code == "append-only-changed")
    );
}

#[test]
fn specification_pins_use_compiler_semantic_anchors_across_file_moves() {
    let source = "export resource Order { id : id\n title : text\n}";
    let compile_at = |path: &str| {
        compile(
            &Package::inline("@test/spec", vec![(path.into(), source.into())]),
            &[],
        )
    };
    let old = compile_at("src/old.forge");
    let new = compile_at("src/moved.forge");
    let first = old.source_map("build", "test", Some(&"a".repeat(40)));
    let second = new.source_map("build", "test", Some(&"b".repeat(40)));
    assert_eq!(
        first["anchors"]["@test/spec/_/Order"]["file"],
        "src/old.forge"
    );
    assert_eq!(
        second["anchors"]["@test/spec/_/Order"]["file"],
        "src/moved.forge"
    );
    assert_ne!(first["revision"], second["revision"]);
}

#[test]
fn write_once_requires_a_blob_and_removes_metadata_mutations() {
    let c = compile(
        &Package::inline(
            "@test/seal",
            vec![(
                "src/a.forge".into(),
                "resource R @writeOnce { id : id }".into(),
            )],
        ),
        &[],
    );
    assert!(c.ir.is_none());
    assert!(c.render().contains("E-SEAL-001"));
    let c = compile(&Package::inline("@test/seal", vec![("src/a.forge".into(), "blob B @writeOnce { content { mediaTypes [\"application/octet-stream\"]\n maxBytes 100\n } }".into())]), &[]);
    assert!(c.ir.is_some(), "{}", c.render());
    let ir = c.ir.unwrap();
    assert!(ir.requires.contains(&"sealed-content/1".into()));
    let r = &ir.modules[0].resources[0];
    assert!(
        !r.operations
            .iter()
            .any(|op| matches!(op.kind.as_str(), "update" | "delete"))
    );
    assert!(r.operations.iter().any(|op| op.kind == "finalizeUpload"));
}
