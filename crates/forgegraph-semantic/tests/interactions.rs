use forgegraph_semantic::concept::ConceptIR;
use serde_json::{Value, json};
fn fixture(domain: &str) -> Value {
    serde_json::from_str(
        &std::fs::read_to_string(format!(
            "{}/../../examples/concept/interactions/{domain}.json",
            env!("CARGO_MANIFEST_DIR")
        ))
        .unwrap(),
    )
    .unwrap()
}
#[test]
fn six_domain_engagements_keep_identity_across_events_and_processes() {
    for domain in [
        "support",
        "healthcare",
        "negotiation",
        "inspection",
        "incident-response",
        "economic-exchange",
    ] {
        let c =
            ConceptIR::load_closed(&fixture(domain)).unwrap_or_else(|e| panic!("{domain}: {e}"));
        assert_eq!(
            ConceptIR::load_closed(&serde_json::from_str(&c.canonical_json()).unwrap()).unwrap(),
            c
        );
        let (id, engagement) = c.semantics.interactions.iter().next().unwrap();
        assert_eq!(engagement.events.len(), 2);
        assert_eq!(engagement.processes.len(), 2);
        assert!(engagement.parent.is_some());
        let graph = c.graph();
        assert_eq!(graph.nodes[id], "interaction");
        for kind in [
            "occursIn",
            "engagesIn",
            "participatesIn",
            "parentInteraction",
        ] {
            assert!(
                graph.edges.iter().any(|e| e.kind == kind),
                "{domain}: {kind}"
            );
        }
        for edge in &graph.edges {
            assert!(graph.nodes.contains_key(&edge.from));
            assert!(graph.nodes.contains_key(&edge.to));
        }
        let mut changed = c.clone();
        changed.semantics.interactions.get_mut(id).unwrap().parent = None;
        assert_ne!(c.content_hash(), changed.content_hash());
        assert!(
            c.semantic_changes(&changed)
                .iter()
                .any(|change| change.path.ends_with("/parent"))
        );
    }
}
#[test]
fn interaction_bindings_reject_dangling_and_wrong_kind_references() {
    let base = fixture("support");
    let id = "@interaction/support/_/Engagement";
    for (field, value) in [
        ("carrier", json!("missing")),
        ("participation", json!([])),
        ("participation", json!(["missing"])),
        ("events", json!({"missing":"context"})),
        (
            "processes",
            json!({"@interaction/support/_/Respond":"missing"}),
        ),
        ("parent", json!("id")),
        ("purpose", json!("missing")),
    ] {
        let mut raw = base.clone();
        raw["semantics"]["interactions"][id][field] = value;
        assert!(
            ConceptIR::load(&raw)
                .unwrap_err()
                .contains("E-L0-INTERACTION"),
            "{field}"
        );
    }
    let mut raw = base.clone();
    raw["semantics"]["temporal"] = json!({});
    assert!(
        ConceptIR::load(&raw)
            .unwrap_err()
            .contains("engagement bounds")
    );
    let mut raw = base.clone();
    raw["semantics"]["interactions"]["duplicate"] = base["semantics"]["interactions"][id].clone();
    assert!(
        ConceptIR::load(&raw)
            .unwrap_err()
            .contains("multiple semantic")
    );
    let mut raw = base;
    raw["facts"]["@interaction/support/_/MessageReceived"]["fields"]["context"]["ty"]["optional"] =
        json!(true);
    assert!(
        ConceptIR::load(&raw)
            .unwrap_err()
            .contains("required entity reference")
    );
}

#[test]
fn interaction_declarations_are_not_implementation_evidence() {
    let c = ConceptIR::load_closed(&fixture("support")).unwrap();
    let package = forgegraph_semantic::Package::inline(
        "@interaction/support",
        vec![("src/empty.forge".into(), String::new())],
    );
    let candidate = forgegraph_semantic::compile(&package, &[]).ir.unwrap();
    let report = c.realization_report(&candidate);
    assert!(!report.is_satisfied());
    assert!(
        report
            .unproven
            .iter()
            .any(|v| v.subject.starts_with("/semantics"))
    );
}
