use forgegraph_semantic::{Package, compile};
fn source(rule: &str) -> String {
    format!(
        "enum State {{ Pending = \"pending\"\n Done = \"done\" }}\nresource R @versioned {{\n id : id\n lane : text\n state : State = State.Pending\n {rule}\n}}"
    )
}
fn compile_rule(rule: &str) -> forgegraph_semantic::Compilation {
    compile(
        &Package::inline("@test/claims", vec![("src/a.forge".into(), source(rule))]),
        &[],
    )
}
#[test]
fn conditions_are_canonical_enum_wire_values_and_not_unconditional_find_keys() {
    let a = compile_rule("unique lane while state in [Pending, Done]");
    assert!(a.ir.is_some(), "{}", a.render());
    let ir = a.ir.unwrap();
    assert_eq!(ir.requires, vec!["conditional-unique/1"]);
    assert_eq!(
        ir.modules[0].resources[0].uniques[0]
            .condition
            .as_ref()
            .unwrap()
            .values,
        vec!["done", "pending"]
    );
    assert_eq!(
        ir,
        compile_rule("unique lane while state in [Done, Pending, Pending]")
            .ir
            .unwrap()
    );
    assert!(
        compile_rule("unique lane while state in [Pending]\n find by lane")
            .diagnostics
            .iter()
            .any(|d| d.code == "E-QRY-001")
    );
    for rule in [
        "unique lane while missing in [Pending]",
        "unique lane while lane in [Pending]",
        "unique lane while state in [Missing]",
    ] {
        assert!(compile_rule(rule).ir.is_none(), "{rule}");
    }
}

#[test]
fn changed_conditions_require_migration_and_change_business_contract() {
    let before = compile_rule("unique lane while state in [Pending]")
        .ir
        .unwrap();
    let after = compile_rule("unique lane while state in [Done]")
        .ir
        .unwrap();
    let report = forgegraph_semantic::diff::compare(
        &serde_json::json!({"ir":before}),
        &serde_json::json!({"ir":after}),
    );
    assert!(
        report
            .findings
            .iter()
            .any(|f| f.code == "unique-invariant-changed"
                && f.needs.contains(&"rebuild-indexes-and-claims"))
    );
    assert_ne!(
        forgegraph_semantic::concept::project(&before)
            .concept
            .content_hash(),
        forgegraph_semantic::concept::project(&after)
            .concept
            .content_hash()
    );
}
