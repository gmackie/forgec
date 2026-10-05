use forgegraph_semantic::{Package, compile};

/// JSON Schema `enum` is exhaustive: a nullable enumerated field must list `null`, or a strict
/// validator rejects the `null` that `type: ["string", "null"]` allows (#199).
#[test]
fn optional_enum_fields_list_null() {
    let source = "enum Advice {\n  compact\n  handoff\n}\nexport resource Turn @versioned {\n  id : id\n  advice : Advice?\n  required : Advice\n  tags : list<Advice?> length <= 4\n}\n";
    let ir = compile(
        &Package::inline("@test/nullable-enum", vec![("src/a.forge".into(), source.into())]),
        &[],
    )
    .ir
    .unwrap_or_else(|| panic!("does not compile"));
    let contracts = serde_json::to_value(forgegraph_planner::plan(&ir).unwrap().contracts).unwrap();
    let turn = contracts["resources"].as_array().unwrap().iter().find(|r| r["name"] == "Turn").unwrap();
    let props = &turn["record"]["properties"];
    assert_eq!(props["advice"]["type"], serde_json::json!(["string", "null"]));
    assert_eq!(props["advice"]["enum"], serde_json::json!(["compact", "handoff", null]));
    assert_eq!(props["required"]["enum"], serde_json::json!(["compact", "handoff"]));
    assert_eq!(props["tags"]["items"]["enum"], serde_json::json!(["compact", "handoff", null]));
}
