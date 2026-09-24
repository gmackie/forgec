use forgegraph_semantic::concept::ConceptIR;
use forgegraph_semantic::concept_registry::{Registration, RegistryRealization, RevisionPin};
use serde_json::{Value, json};
fn registered() -> (ConceptIR, String, String) {
    let raw: Value = serde_json::from_str(include_str!(
        "../../../examples/concept/interactions/support.json"
    ))
    .unwrap();
    let mut c = ConceptIR::load_closed(&raw).unwrap();
    let anchor = "@interaction/support/_/Customer".to_owned();
    let identity = "https://registry.example/actors#customer".to_owned();
    c.registry.bindings.insert(anchor.clone(), identity.clone());
    let digest = c.registry_definition_digest(&anchor).unwrap();
    c.registry.entries.insert(
        identity.clone(),
        Registration {
            authority: "https://registry.example/actors".into(),
            stable_id: "customer".into(),
            revision: "definition-1".into(),
            digest,
            label: "Customer".into(),
            aliases: ["legacy-customer".into()].into(),
            deprecated: false,
            supersedes: Default::default(),
            external_mappings: ["urn:external-standard:customer:2026".into()].into(),
        },
    );
    assert!(c.validate_closed().is_empty(), "{:?}", c.validate_closed());
    (c, anchor, identity)
}
#[test]
fn moves_and_presentation_renames_preserve_identity_and_references() {
    let (c, old, identity) = registered();
    let new = "@interaction/support/renamed/Client";
    // Move the declaration and every typed reference in this fixture.
    let mut moved: ConceptIR =
        serde_json::from_str(&serde_json::to_string(&c).unwrap().replace(&old, new)).unwrap();
    moved.entities.get_mut(new).unwrap().name = "Client".into();
    assert!(moved.validate_closed().is_empty());
    assert_eq!(
        c.registry_definition_digest(&old),
        moved.registry_definition_digest(new)
    );
    assert!(
        c.semantic_changes(&moved).is_empty(),
        "{:?}",
        c.semantic_changes(&moved)
    );
    moved.registry.entries.get_mut(&identity).unwrap().label = "Client".into();
    let changes = c.semantic_changes(&moved);
    assert_eq!(changes.len(), 1);
    assert!(changes[0].path.ends_with("/label"));
    moved
        .registry
        .entries
        .get_mut(&identity)
        .unwrap()
        .deprecated = true;
    assert!(moved.validate_registry().is_empty());
}
#[test]
fn definitions_imports_and_collisions_fail_closed() {
    let (c, anchor, identity) = registered();
    let mut changed = c.clone();
    changed.entities.get_mut(&anchor).unwrap().fields.clear();
    assert!(
        changed
            .validate_registry()
            .iter()
            .any(|e| e.message.contains("digest"))
    );
    let entry = c.registry.entries[&identity].clone();
    let pin = RevisionPin {
        identity: identity.clone(),
        revision: entry.revision.clone(),
        digest: entry.digest.clone(),
    };
    let mut imported = c.clone();
    imported.registry.imports.push(pin.clone());
    assert!(imported.validate_registry().is_empty());
    imported.registry.imports[0].revision = "definition-2".into();
    assert!(!imported.validate_registry().is_empty());
    for collision in ["alias", "mapping", "identity"] {
        let mut other = entry.clone();
        other.stable_id = "other".into();
        other.aliases.clear();
        other.external_mappings.clear();
        match collision {
            "alias" => {
                other.aliases.insert("legacy-customer".into());
            }
            "mapping" => other.external_mappings = entry.external_mappings.clone(),
            _ => {
                other.aliases.insert(identity.clone());
            }
        }
        let mut invalid = c.clone();
        invalid
            .registry
            .entries
            .insert("https://registry.example/actors#other".into(), other);
        assert!(!invalid.validate_registry().is_empty(), "{collision}");
    }
    let mut invalid = c.clone();
    invalid
        .registry
        .entries
        .get_mut(&identity)
        .unwrap()
        .supersedes
        .insert(identity.clone());
    assert!(!invalid.validate_registry().is_empty());
    let mut unknown = c.clone();
    unknown.registry.bindings.insert("missing".into(), identity);
    assert!(!unknown.validate_registry().is_empty());
    let mut raw = serde_json::to_value(c).unwrap();
    raw["registry"]["imports"] =
        json!([{"identity": pin.identity, "revision": "*", "digest": pin.digest}]);
    assert!(ConceptIR::load(&raw).is_err());
}
#[test]
fn two_l1_artifacts_share_an_exact_semantic_identity_without_certification() {
    let (c, anchor, identity) = registered();
    let entry = &c.registry.entries[&identity];
    let pin = RevisionPin {
        identity,
        revision: entry.revision.clone(),
        digest: entry.digest.clone(),
    };
    let mut refs: Vec<_> = ["oci://service-a@sha256:aaa", "wasm://service-b@sha256:bbb"]
        .into_iter()
        .map(|artifact| RegistryRealization {
            pin: pin.clone(),
            declaration: anchor.clone(),
            artifact: artifact.into(),
        })
        .collect();
    assert!(c.check_registry_realizations(&refs).is_empty());
    refs[1].pin.digest = "0".repeat(64);
    assert!(!c.check_registry_realizations(&refs).is_empty());
}

#[test]
fn registered_declaration_moves_preserve_all_typed_references() {
    for raw in [
        include_str!("../../../examples/concept/interactions/support.json"),
        include_str!("../../../examples/concept/business-semantics/commerce.json"),
    ] {
        let raw: Value = serde_json::from_str(raw).unwrap();
        for family in [
            "entities",
            "facts",
            "processes",
            "principals",
            "policies",
            "externals",
        ] {
            for anchor in raw[family].as_object().unwrap().keys() {
                let mut c = ConceptIR::load(&raw).unwrap();
                let (_, _, identity) = registered();
                c.registry.bindings.insert(anchor.clone(), identity.clone());
                let mut entry = registered().0.registry.entries[&identity].clone();
                entry.digest = c.registry_definition_digest(anchor).unwrap();
                c.registry.entries.insert(identity, entry);
                let mut moved: ConceptIR =
                    serde_json::from_str(&serde_json::to_string(&c).unwrap().replace(
                        &serde_json::to_string(anchor).unwrap(),
                        &serde_json::to_string("@moved/model/new/Declaration").unwrap(),
                    ))
                    .unwrap();
                if let Some(entity) = moved.entities.get_mut("@moved/model/new/Declaration") {
                    entity.name = "Renamed".into();
                }
                assert!(
                    moved.validate().is_empty(),
                    "{family}: {:?}",
                    moved.validate()
                );
                assert!(
                    c.semantic_changes(&moved).is_empty(),
                    "{family} {anchor}: {:?}",
                    c.semantic_changes(&moved)
                );
            }
        }
    }
}
