use forgegraph_semantic::{Package, compile};
fn source(decorator: &str) -> Package {
    Package::inline(
        "@test/mqtt",
        vec![(
            "src/main.forge".into(),
            format!("channel Events\n{decorator}\n{{\n message Changed {{ value : text }}\n}}\n"),
        )],
    )
}
#[test]
fn mqtt_binding_roundtrips_with_prefix() {
    let out = compile(&source("@mqtt(\"forge/events\")"), &[]);
    assert!(out.diagnostics.is_empty(), "{:?}", out.diagnostics);
    let ir = out.ir.unwrap();
    assert!(ir.requires.contains(&"mqtt/1".to_string()));
    let json = serde_json::to_value(&ir).unwrap();
    assert_eq!(
        json["modules"][0]["channels"][0]["mqtt"]["prefix"],
        "forge/events"
    );
    let decoded: forgegraph_semantic::ir::DomainIR = serde_json::from_value(json).unwrap();
    assert_eq!(ir, decoded);
}
#[test]
fn rejects_invalid_bindings() {
    for decorator in [
        "@mqtt(42)",
        "@mqtt(\"forge/#\")",
        "@mqtt(\"\")",
        "@mqtt(\"/forge\")",
        "@mqtt(\"forge\", 0)",
        "@mqtt(\"forge\")\n@mqtt(\"forge\")",
    ] {
        assert!(
            !compile(&source(decorator), &[]).diagnostics.is_empty(),
            "{decorator}"
        );
    }
}
