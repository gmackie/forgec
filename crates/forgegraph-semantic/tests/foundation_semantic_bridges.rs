use forgegraph_semantic::concept::{ConceptIR, project_with_semantics};
use forgegraph_semantic::concept_semantics::BusinessSemantics;
use serde_json::{Value, json};
use std::path::PathBuf;

#[test]
fn compiled_foundation_relationships_and_server_knowledge_have_checked_bindings() {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..");
    for slug in ["resource-relations", "settlement"] {
        let bundle: Value = serde_json::from_str(
            &std::fs::read_to_string(root.join(format!("conformance/fixtures/{slug}/app.json")))
                .unwrap(),
        )
        .unwrap();
        let ir: forgegraph_semantic::ir::DomainIR =
            serde_json::from_value(bundle["ir"].clone()).unwrap();
        let original_hash = ir.content_hash();
        let semantics: BusinessSemantics = serde_json::from_str(
            &std::fs::read_to_string(root.join(format!(
                "packages/foundation/{slug}/fixtures/semantics.json"
            )))
            .unwrap(),
        )
        .unwrap();
        let projection = project_with_semantics(&ir, &semantics).unwrap();
        assert_eq!(original_hash, ir.content_hash());
        let mut changed = semantics.clone();
        changed
            .temporal
            .values_mut()
            .for_each(|binding| binding.knowledge = None);
        changed.temporal.retain(|_, binding| {
            binding.occurrence.is_some() || binding.valid.is_some() || binding.knowledge.is_some()
        });
        let changed = project_with_semantics(&ir, &changed).unwrap();
        assert!(
            projection
                .concept
                .semantic_changes(&changed.concept)
                .iter()
                .any(|change| change.path.starts_with("/semantics/temporal/"))
        );
        ConceptIR::load_closed(&serde_json::to_value(&projection.concept).unwrap()).unwrap();
        let commit = format!(
            "@forgegraph/foundation/{slug}/_/{}",
            if slug == "settlement" {
                "SettlementCommit"
            } else {
                "RelationCommit"
            }
        );
        assert_eq!(
            projection.concept.semantics.temporal[&commit]
                .knowledge
                .as_ref()
                .unwrap()
                .from,
            "createdAt"
        );
        assert!(
            projection.concept.entities[&commit]
                .fields
                .contains_key("createdAt")
        );
        let mut invalid = serde_json::to_value(&semantics).unwrap();
        invalid["temporal"][&commit]["knowledge"]["from"] = json!("recordedBy");
        assert!(project_with_semantics(&ir, &serde_json::from_value(invalid).unwrap()).is_err());
        let mut invalid = semantics.clone();
        invalid
            .relationships
            .values_mut()
            .next()
            .unwrap()
            .endpoints
            .values_mut()
            .next()
            .unwrap()
            .target = "@missing/Entity".into();
        assert!(project_with_semantics(&ir, &invalid).is_err());
    }
}
