use forgegraph_semantic::concept::ConceptIR;
use forgegraph_semantic::concept_archetypes::ProfileChangeKind;
use serde_json::{Value, json};
fn fixture(domain: &str) -> Value {
    serde_json::from_str(
        &std::fs::read_to_string(format!(
            "{}/../../examples/concept/archetypes/{domain}.json",
            env!("CARGO_MANIFEST_DIR")
        ))
        .unwrap(),
    )
    .unwrap()
}
#[test]
fn four_vocabularies_elaborate_the_same_graph_and_keep_provenance() {
    for domain in ["healthcare", "manufacturing", "telecom", "software"] {
        let model = ConceptIR::load_closed(&fixture(domain)).unwrap();
        let expanded = model.elaborate_archetypes().unwrap();
        assert_eq!(expanded.concept.semantics.relationships.len(), 3);
        assert_eq!(expanded.sources.len(), 7);
        assert_eq!(expanded.outputs[domain].len(), 1);
        assert!(
            expanded
                .sources
                .values()
                .flatten()
                .all(|s| s.profile == domain
                    && s.archetype.as_deref() == Some("RequestFulfillment")
                    && s.source.contains(domain))
        );
        assert!(expanded.concept.validate_closed().is_empty());
        assert!(expanded.concept.archetypes.is_empty());
        assert_eq!(
            ConceptIR::load(&serde_json::to_value(&model).unwrap()).unwrap(),
            model
        );
    }
}
#[test]
fn rejects_missing_unknown_and_mistyped_roles() {
    for (key, value) in [
        ("request", json!("missing")),
        ("unknown", json!("LabOrder")),
    ] {
        let mut raw = fixture("healthcare");
        raw["archetypes"]["profiles"]["healthcare"]["bindings"]["RequestFulfillment"][key] = value;
        assert!(ConceptIR::load(&raw).is_err());
    }
    let mut raw = fixture("healthcare");
    raw["archetypes"]["definitions"]["RequestFulfillment"]["roles"]["request"]["kind"] =
        json!("fact");
    assert!(ConceptIR::load(&raw).is_err());
    let mut raw = fixture("healthcare");
    raw["archetypes"]["profiles"]["healthcare"]["bindings"]["RequestFulfillment"]
        .as_object_mut()
        .unwrap()
        .remove("request");
    assert!(ConceptIR::load(&raw).is_err());
}
fn contract() -> Value {
    json!({"owner":{"kind":"entity","id":"request"},"kind":"invariant","predicate":{"kind":"literal","literal":{"type":"bool","value":true}},"selectors":[]})
}
#[test]
fn composition_keeps_contracts_and_detects_collisions() {
    let mut raw = fixture("healthcare");
    raw["archetypes"]["definitions"]["RequestFulfillment"]["contracts"]["valid"] = contract();
    raw["archetypes"]["definitions"]["Audit"] =
        raw["archetypes"]["definitions"]["RequestFulfillment"].clone();
    raw["archetypes"]["profiles"]["healthcare"]["bindings"]["Audit"] =
        raw["archetypes"]["profiles"]["healthcare"]["bindings"]["RequestFulfillment"].clone();
    let model = ConceptIR::load(&raw).unwrap();
    let expanded = model.elaborate_archetypes().unwrap();
    assert_eq!(expanded.concept.semantics.contracts.len(), 2);
    assert_eq!(expanded.sources["LabOrder"].len(), 2);
    let mut collision = model.clone();
    collision.semantics = expanded.concept.semantics;
    assert!(collision.elaborate_archetypes().is_err());
    raw["archetypes"]["definitions"]["Audit"]["contracts"]["valid"]["predicate"] =
        json!({"kind":"name","path":["missing"]});
    assert!(ConceptIR::load(&raw).is_err());
}
#[test]
fn additive_constraints_and_display_changes_are_classified() {
    let raw = fixture("healthcare");
    let before = ConceptIR::load(&raw).unwrap();
    let mut next = before.clone();
    next.archetypes
        .profiles
        .get_mut("healthcare")
        .unwrap()
        .label = "Laboratory".into();
    assert_eq!(
        before.archetype_changes(&next)[0].kind,
        ProfileChangeKind::DisplayRename
    );
    let mut raw = raw;
    let mut c = contract();
    c["owner"]["id"] = json!("LabOrder");
    raw["archetypes"]["profiles"]["healthcare"]["constraints"]["extra"] = c;
    let after = ConceptIR::load(&raw).unwrap();
    assert_eq!(
        before.archetype_changes(&after)[0].kind,
        ProfileChangeKind::StrengthenedConstraint
    );
    assert_eq!(
        after.archetype_changes(&before)[0].kind,
        ProfileChangeKind::BrokenContract
    );
}
#[test]
fn extensions_and_optional_roles_are_explicit() {
    let mut raw = fixture("healthcare");
    raw["archetypes"]["profiles"]["healthcare"]["extensions"] = json!(["LabOrder"]);
    assert!(ConceptIR::load(&raw).is_ok());
    raw["archetypes"]["definitions"]["RequestFulfillment"]["extensible"] = json!(false);
    assert!(ConceptIR::load(&raw).is_err());
    let mut raw = fixture("healthcare");
    raw["archetypes"]["definitions"]["RequestFulfillment"]["roles"]["optional"] =
        json!({"kind":"fact","required":false,"lifecycle":null});
    assert!(ConceptIR::load(&raw).is_ok());
    raw["archetypes"]["definitions"]["RequestFulfillment"]["outputs"] = json!(["optional"]);
    assert!(ConceptIR::load(&raw).is_err());
}

#[test]
fn lifecycle_restriction_cannot_add_transitions_or_reopen_terminals() {
    let mut raw = fixture("healthcare");
    raw["archetypes"]["definitions"]["RequestFulfillment"]["roles"]["request"]["lifecycle"] = json!({"initial":"open","terminals":["done"],"transitions":[["open","done"],["open","open"]]});
    raw["entities"]["LabOrder"]["lifecycle"] = json!({"field":"status","enumId":"Status","states":["open","done"],"initial":"open","terminals":["done"],"transitions":[{"action":"finish","from":["open"],"to":"done","input":[]}]});
    let before = ConceptIR::load(&raw).unwrap();
    raw["entities"]["LabOrder"]["lifecycle"]["transitions"] = json!([]);
    let after = ConceptIR::load(&raw).unwrap();
    assert!(
        before
            .archetype_changes(&after)
            .iter()
            .any(|c| c.kind == ProfileChangeKind::LifecycleBinding)
    );
    raw["entities"]["LabOrder"]["lifecycle"]["transitions"] =
        json!([{"action":"reopen","from":["done"],"to":"open","input":[]}]);
    assert!(ConceptIR::load(&raw).is_err());
    raw["entities"]["LabOrder"]["lifecycle"]["transitions"] = json!([]);
    raw["entities"]["LabOrder"]["lifecycle"]["terminals"] = json!([]);
    assert!(ConceptIR::load(&raw).is_err());
}
#[test]
fn base_contract_removal_and_role_rebinding_are_not_display_renames() {
    let mut raw = fixture("healthcare");
    raw["archetypes"]["definitions"]["RequestFulfillment"]["contracts"]["valid"] = contract();
    let before = ConceptIR::load(&raw).unwrap();
    raw["archetypes"]["definitions"]["RequestFulfillment"]["contracts"] = json!({});
    let after = ConceptIR::load(&raw).unwrap();
    assert_eq!(
        before.archetype_changes(&after)[0].kind,
        ProfileChangeKind::BrokenContract
    );
    raw["archetypes"]["profiles"]["healthcare"]["bindings"]["RequestFulfillment"]["request"] =
        json!("LabResult");
    let rebound = ConceptIR::load(&raw).unwrap();
    assert_eq!(
        after.archetype_changes(&rebound)[0].kind,
        ProfileChangeKind::RoleRebinding
    );
    assert_eq!(rebound.graph().edges.len(), 6);
}
