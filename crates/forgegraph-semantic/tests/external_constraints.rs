use forgegraph_semantic::concept::ConceptIR;
use serde_json::{Value, json};
fn fixture(domain: &str) -> Value {
    serde_json::from_str(
        &std::fs::read_to_string(format!(
            "{}/../../examples/concept/governance/{domain}.json",
            env!("CARGO_MANIFEST_DIR")
        ))
        .unwrap(),
    )
    .unwrap()
}
#[test]
fn external_rules_preserve_authority_provenance_and_effective_history() {
    for domain in ["privacy", "safety", "consumer"] {
        let c = ConceptIR::load_closed(&fixture(domain)).unwrap();
        assert_eq!(
            c,
            ConceptIR::load_closed(&serde_json::from_str(&c.canonical_json()).unwrap()).unwrap()
        );
        let process = format!("@governance/{domain}/_/Respond");
        assert!(c.external_constraints_for(&process, -1).is_empty());
        let before = c.external_constraints_for(&process, 999);
        assert_eq!(before.len(), 1);
        assert_eq!(before[0].requirements.len(), 1);
        assert!(!before[0].prohibited);
        assert!(
            before[0]
                .citations
                .iter()
                .next()
                .unwrap()
                .contains("revision-1")
        );
        let after = c.external_constraints_for(&process, 1000);
        assert_eq!(after.len(), 1);
        assert!(after[0].prohibited);
        assert!(after[0].requirements.is_empty());
        assert_ne!(before[0].constraint, after[0].constraint);
        let graph = c.graph();
        for kind in [
            "imposes",
            "jurisdiction",
            "applicability",
            "requires",
            "prohibits",
            "supersedes",
        ] {
            assert!(graph.edges.iter().any(|e| e.kind == kind));
        }
        for e in &graph.edges {
            assert!(graph.nodes.contains_key(&e.from));
            assert!(graph.nodes.contains_key(&e.to));
        }
        let mut changed = c.clone();
        changed
            .semantics
            .external_constraints
            .values_mut()
            .next()
            .unwrap()
            .citations
            .insert("illustrative:correction".into());
        assert_ne!(c.content_hash(), changed.content_hash());
        assert!(
            c.semantic_changes(&changed)
                .iter()
                .any(|d| d.path.contains("externalConstraints"))
        );
        // Internal contracts do not become externally imposed merely by being present.
        changed.semantics.external_constraints.clear();
        assert!(changed.external_constraints_for(&process, 10).is_empty());
    }
}
#[test]
fn external_constraints_reject_dangling_untyped_and_cyclic_declarations() {
    let base = fixture("privacy");
    let rule = "@governance/privacy/_/ExternalRule";
    for (field, value) in [
        ("authority", json!("missing")),
        ("jurisdiction", json!("missing")),
        ("citations", json!([])),
        (
            "applicability",
            json!({"process":"missing","predicate":{"kind":"literal","literal":{"type":"bool","value":true}}}),
        ),
        ("requirements", json!(["missing"])),
        ("prohibitions", json!(["missing"])),
        ("validUntil", json!(0)),
        ("evidence", json!(["missing"])),
        ("supersedes", json!([rule])),
    ] {
        let mut raw = base.clone();
        raw["semantics"]["externalConstraints"][rule][field] = value;
        assert!(
            ConceptIR::load(&raw)
                .unwrap_err()
                .contains("E-L0-EXTERNAL-CONSTRAINT"),
            "{field}"
        );
    }
    let mut raw = base.clone();
    raw["semantics"]["subjects"]["@governance/privacy/_/Authority"]["profiles"] = json!(["party"]);
    assert!(
        ConceptIR::load(&raw)
            .unwrap_err()
            .contains("authority profile")
    );
    let mut raw = base;
    raw["semantics"]["externalConstraints"][rule]["applicability"]["predicate"]["path"] =
        json!(["engagement", "missing"]);
    assert!(
        ConceptIR::load(&raw)
            .unwrap_err()
            .contains("typed boolean predicate")
    );
}
