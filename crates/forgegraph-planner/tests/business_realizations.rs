use forgegraph_semantic::compile;
use forgegraph_semantic::concept::project_with_semantics;
use serde_json::{Value, json};
#[test]
fn sql_history_and_dynamo_access_plans_preserve_checked_business_bindings() {
    let root = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..");
    let package = forgegraph_semantic::package::load_package(
        &root.join("examples/concept/business-semantics/realizations"),
    )
    .unwrap();
    let compilation = compile(&package, &[]);
    let ir = compilation
        .ir
        .as_ref()
        .unwrap_or_else(|| panic!("{}", compilation.render()));
    let semantics = serde_json::from_str(
        &std::fs::read_to_string(
            root.join("examples/concept/business-semantics/realizations/semantics.json"),
        )
        .unwrap(),
    )
    .unwrap();
    let projection = project_with_semantics(ir, &semantics).unwrap();
    let plans = forgegraph_planner::plan(ir).unwrap();
    let sql = serde_json::to_value(&plans.sql).unwrap();
    let dynamo = serde_json::to_value(&plans.dynamo).unwrap();
    assert_ne!(sql, dynamo);
    assert!(sql.to_string().contains("effectiveFrom"));
    assert!(dynamo.to_string().contains("effective"));
    assert!(!projection.concept.semantics.events.is_empty());
    assert!(!projection.concept.semantics.effects.is_empty());
    assert!(!projection.concept.semantics.contracts.is_empty());
    let mut other = ir.clone();
    other.package.targets = vec!["aws-dynamodb".into()];
    let mut first = ir.clone();
    first.package.targets = vec!["cloudflare-d1".into()];
    assert_ne!(first.content_hash(), other.content_hash());
    assert_eq!(
        project_with_semantics(&first, &semantics)
            .unwrap()
            .concept
            .content_hash(),
        project_with_semantics(&other, &semantics)
            .unwrap()
            .concept
            .content_hash()
    );
    // A declaration is checked, not evidence that either storage provider enforces it.
    assert!(!projection.concept.realization_report(ir).is_satisfied());
    let mut invalid: Value = serde_json::to_value(&semantics).unwrap();
    invalid["temporal"]["@semantics/realizations/_/Balance"]["knowledge"]["from"] = json!("amount");
    assert!(project_with_semantics(ir, &serde_json::from_value(invalid).unwrap()).is_err());
}
