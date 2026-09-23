use forgegraph_semantic::concept::ConceptIR;
use forgegraph_semantic::concept_semantics::*;
use serde_json::{Value, json};
use std::collections::{BTreeMap, BTreeSet};

fn fixture(domain: &str) -> Value {
    serde_json::from_str(
        &std::fs::read_to_string(format!(
            "{}/../../examples/concept/business-semantics/{domain}.json",
            env!("CARGO_MANIFEST_DIR")
        ))
        .unwrap(),
    )
    .unwrap()
}
fn commerce() -> ConceptIR {
    ConceptIR::load(&fixture("commerce")).unwrap()
}
const P: &str = "@semantics/commerce/_/";
fn id(name: &str) -> String {
    format!("{P}{name}")
}

#[test]
fn cross_domain_semantics_roundtrip_and_authoritative_ownership() {
    for domain in [
        "commerce",
        "banking",
        "manufacturing",
        "configuration",
        "benefits",
        "insurance",
        "hospital",
        "payroll",
    ] {
        let c = ConceptIR::load(&fixture(domain)).unwrap_or_else(|e| panic!("{domain}: {e}"));
        let roundtrip =
            ConceptIR::load(&serde_json::from_str(&c.canonical_json()).unwrap()).unwrap();
        assert_eq!(c, roundtrip);
        assert_eq!(c.content_hash(), roundtrip.content_hash());
        assert_eq!(c.invariant_producers().values().next().unwrap().len(), 1);
        let graph = c.graph();
        for edge in &graph.edges {
            assert!(graph.nodes.contains_key(&edge.from), "{}", edge.from);
            assert!(graph.nodes.contains_key(&edge.to), "{}", edge.to);
        }
    }
}
#[test]
fn invalid_field_types_contracts_and_endpoint_bindings_fail_closed() {
    let base = fixture("commerce");
    let mut cases = vec![];
    let mut v = base.clone();
    v["semantics"]["temporal"][id("SettlementPosition")]["valid"]["from"] = json!("amount");
    cases.push((v, "E-L0-TEMPORAL"));
    let mut v = base.clone();
    v["semantics"]["selections"][id("validAtOccurrence")]["axis"] = json!("occurrence");
    cases.push((v, "E-L0-TEMPORAL"));
    let mut v = base.clone();
    v["semantics"]["contracts"][id("BoundedContribution")]["predicate"]["lhs"]["path"] =
        json!(["self", "missing"]);
    cases.push((v, "E-L0-CONTRACT"));
    let mut v = base.clone();
    v["semantics"]["contracts"][id("Available")]["predicate"]["lhs"]["path"] =
        json!(["result", "amount"]);
    cases.push((v, "E-L0-CONTRACT"));
    let mut v = base.clone();
    v["semantics"]["relationships"][id("PositionRoles")]["endpoints"]["creditor"]["target"] =
        json!(id("SettlementPosition"));
    cases.push((v, "E-L0-RELATIONSHIP"));
    let mut v = base.clone();
    v["semantics"]["effects"][id("BusinessConsequence")]["causes"]["cause"] =
        json!(id("SettlementApplied"));
    cases.push((v, "E-L0-EFFECT"));
    let mut v = base.clone();
    v["semantics"]["views"][id("CreditorView")]["fields"] = json!(["missing"]);
    cases.push((v, "E-L0-VIEW"));
    let mut v = base;
    v["semantics"]["views"][id("CreditorView")]["authorizations"] = json!(["unregistered-policy"]);
    cases.push((v, "E-L0-VIEW"));
    for (value, code) in cases {
        assert!(
            ConceptIR::load(&value).unwrap_err().contains(code),
            "{code}"
        );
    }
}
#[test]
fn latest_requires_axis_and_semantic_tie_breaking() {
    let mut v = fixture("commerce");
    v["semantics"]["selections"][id("validAtOccurrence")]["relation"] = json!({"kind":"latest"});
    assert!(ConceptIR::load(&v).is_err());
    v["semantics"]["selections"][id("validAtOccurrence")]["tie_break"] = json!(["id"]);
    assert!(ConceptIR::load(&v).is_ok());
}
#[test]
fn retroactive_decision_context_and_view_changes_have_separate_diff_paths() {
    let before = commerce();
    let mut value = fixture("commerce");
    value["semantics"]["selections"][id("knownAtDecision")]["relation"]["instant"]["path"] =
        json!(["current", "knownFrom"]);
    let corrected = ConceptIR::load(&value).unwrap();
    assert_ne!(before.content_hash(), corrected.content_hash());
    let diff = before.semantic_changes(&corrected);
    assert_eq!(diff.len(), 1);
    assert!(diff[0].path.starts_with("/semantics/selections/"));
    assert_eq!(before.entities, corrected.entities); // one business identity across knowledge contexts
    value["semantics"]["views"][id("CreditorView")]["fields"] = json!(["id", "amount"]);
    let view = ConceptIR::load(&value).unwrap();
    assert!(
        corrected
            .semantic_changes(&view)
            .iter()
            .all(|d| d.path.starts_with("/semantics/views/"))
    );
    assert_eq!(view.entities.len(), before.entities.len());
}
#[test]
fn realization_claims_are_separate_bound_and_not_a_proof() {
    let c = commerce();
    let claims: BTreeMap<_, _> = c
        .semantics
        .contracts
        .iter()
        .map(|(id, contract)| {
            (
                id.clone(),
                AssuranceClaim {
                    contract_hash: forgegraph_semantic::ir::hash_hex(
                        &serde_json::to_string(contract).unwrap(),
                    ),
                    status: AssuranceStatus::RuntimeEnforced,
                    evidence: BTreeSet::from(["test:bounded-contribution".into()]),
                },
            )
        })
        .collect();
    let mut a = Assurance {
        concept_hash: c.content_hash(),
        mechanism: "conditional-write".into(),
        claims,
    };
    assert!(c.check_assurance(&a).is_empty());
    let hash = c.content_hash();
    a.mechanism = "serialized-actor".into();
    assert!(c.check_assurance(&a).is_empty());
    assert_eq!(hash, c.content_hash());
    a.claims.get_mut(&id("Available")).unwrap().status = AssuranceStatus::Unknown;
    assert!(
        c.check_assurance(&a)
            .iter()
            .any(|e| e.code == "E-L0-UNPROVEN")
    );
    a.concept_hash = "stale".into();
    assert!(
        c.check_assurance(&a)
            .iter()
            .any(|e| e.code == "E-L0-ASSURANCE")
    );
    let package = forgegraph_semantic::Package::inline(
        "@semantics/commerce",
        vec![("empty.forge".into(), "resource Other { id : id }".into())],
    );
    let ir = forgegraph_semantic::compile(&package, &[]).ir.unwrap();
    assert!(!c.realization_report(&ir).is_satisfied());
    assert!(
        c.realization_report(&ir)
            .unproven
            .iter()
            .any(|e| e.subject == "/semantics")
    );
}

#[test]
fn occurrence_consequences_and_relationship_identity_remain_distinct() {
    let c = commerce();
    let event = id("PaymentReceived");
    assert_eq!(
        c.semantics
            .effects
            .values()
            .filter(|e| e.causes.values().any(|cause| cause == &event))
            .count(),
        2
    );
    let custody = &c.semantics.relationships[&id("Custody")];
    let control = &c.semantics.relationships[&id("Control")];
    assert_eq!(custody.endpoints, control.endpoints);
    assert_ne!(custody.carrier, control.carrier);
    let fulfillment = &c.semantics.relationships[&id("FulfillmentRelation")];
    assert!(
        c.facts[fulfillment.carrier.as_ref().unwrap()]
            .fields
            .contains_key("quantity")
    );
    assert!(c.semantics.views.contains_key(&id("Sale")));
    assert!(c.semantics.views.contains_key(&id("Purchase")));
    assert_eq!(
        c.semantics.views[&id("Sale")].fact,
        c.semantics.views[&id("Purchase")].fact
    );
    assert!(!c.entities.contains_key(&id("Invoice")));
    assert!(c.shapes.contains_key(&id("Invoice")));
    assert!(
        c.semantics
            .relationships
            .keys()
            .all(|id| !id.ends_with("/Duality"))
    );
}

#[test]
fn principal_representation_is_a_typed_relationship_not_a_polymorphic_reference() {
    let mut v = fixture("commerce");
    v["principals"][id("Operator")] = json!({"name":"Operator", "attributes":{}});
    let template = v["entities"][id("Party")].clone();
    v["entities"][id("Representation")] = template;
    v["entities"][id("Representation")]["name"] = json!("Representation");
    let mut principal = v["entities"][id("SettlementPosition")]["fields"]["creditor"].clone();
    principal["ty"]["base"] = json!({"kind":"principal", "id":id("Operator")});
    v["entities"][id("Representation")]["fields"]["principal"] = principal;
    v["entities"][id("Representation")]["fields"]["party"] =
        v["entities"][id("SettlementPosition")]["fields"]["creditor"].clone();
    v["semantics"]["relationships"][id("Representation")] = json!({
        "carrier":id("Representation"), "endpoints":{
            "principal":{"target":id("Operator"),"field":"principal"},
            "party":{"target":id("Party"),"field":"party"}
        }, "evidence":[]
    });
    assert!(ConceptIR::load(&v).is_ok());
    v["semantics"]["relationships"][id("Representation")]["endpoints"]["principal"]["target"] =
        json!(id("Party"));
    assert!(
        ConceptIR::load(&v)
            .unwrap_err()
            .contains("E-L0-RELATIONSHIP")
    );
}

#[test]
fn views_cannot_project_credentials_or_change_authoritative_data() {
    let mut v = fixture("commerce");
    v["entities"][id("SettlementPosition")]["fields"]["amount"]["secret"] = json!(true);
    assert!(ConceptIR::load(&v).unwrap_err().contains("E-L0-VIEW"));
    let before = commerce();
    let mut after = before.clone();
    after
        .semantics
        .views
        .get_mut(&id("CreditorView"))
        .unwrap()
        .fields
        .remove("amount");
    assert_eq!(before.facts, after.facts);
    assert_eq!(before.entities, after.entities);
    assert!(!before.semantic_changes(&after).is_empty());
}

#[test]
fn temporal_bounds_preserve_calendar_dates_and_instant_types() {
    let mut v = fixture("commerce");
    v["entities"][id("SettlementPosition")]["fields"]["validFrom"]["ty"]["base"]["name"] =
        json!("date");
    assert!(ConceptIR::load(&v).unwrap_err().contains("E-L0-TEMPORAL"));
    v["facts"][id("PaymentReceived")]["fields"]["occurredAt"]["ty"]["base"]["name"] = json!("date");
    ConceptIR::load(&v).unwrap();
    v["semantics"]["selections"][id("validAtOccurrence")]["relation"] = json!({
        "kind":"during", "from":{"kind":"name", "path":["occurrence", "occurredAt"]},
        "to":{"kind":"name", "path":["occurrence", "knownAt"]}
    });
    assert!(ConceptIR::load(&v).is_err_and(|e| e.contains("E-L0-TEMPORAL")));
    v["semantics"]["selections"][id("validAtOccurrence")]["relation"]["to"]["path"] =
        json!(["current", "validFrom"]);
    ConceptIR::load(&v).unwrap();
    v["semantics"]["contracts"][id("Available")]["predicate"] = json!({
        "kind":"binary", "op":"<=", "lhs":{"kind":"name", "path":["current", "validFrom"]},
        "rhs":{"kind":"name", "path":["occurrence", "occurredAt"]}
    });
    ConceptIR::load(&v).unwrap();
    v["semantics"]["contracts"][id("Available")]["predicate"]["rhs"]["path"] =
        json!(["occurrence", "knownAt"]);
    assert!(ConceptIR::load(&v).is_err_and(|e| e.contains("E-L0-CONTRACT")));
    let mut aliases = fixture("commerce");
    aliases["entities"][id("SettlementPosition")]["fields"]["validUntil"] =
        aliases["entities"][id("SettlementPosition")]["fields"]["validFrom"].clone();
    aliases["entities"][id("SettlementPosition")]["fields"]["validUntil"]["ty"]["base"]["name"] =
        json!("timestamp");
    aliases["entities"][id("SettlementPosition")]["fields"]["validUntil"]["ty"]["optional"] =
        json!(true);
    aliases["semantics"]["temporal"][id("SettlementPosition")]["valid"]["to"] = json!("validUntil");
    aliases["facts"][id("PaymentReceived")]["fields"]["occurredAt"]["ty"]["base"]["name"] =
        json!("timestamp");
    ConceptIR::load(&aliases).unwrap();
}

#[test]
fn temporal_intervals_and_latest_require_compatible_orderable_fields() {
    let base = fixture("commerce");
    let mut cases = vec![];
    let mut v = base.clone();
    v["entities"][id("SettlementPosition")]["fields"]["validUntil"] =
        v["entities"][id("SettlementPosition")]["fields"]["validFrom"].clone();
    v["entities"][id("SettlementPosition")]["fields"]["validUntil"]["ty"]["base"]["name"] =
        json!("date");
    v["semantics"]["temporal"][id("SettlementPosition")]["valid"]["to"] = json!("validUntil");
    cases.push(v);
    let mut latest = base.clone();
    latest["semantics"]["selections"][id("validAtOccurrence")]["relation"] =
        json!({"kind":"latest"});
    latest["semantics"]["selections"][id("validAtOccurrence")]["tie_break"] = json!(["id"]);
    ConceptIR::load(&latest).unwrap();
    let mut v = latest.clone();
    v["entities"][id("SettlementPosition")]["fields"]["id"]["ty"]["optional"] = json!(true);
    cases.push(v);
    for keys in [json!(["id", "creditor"]), json!(["id", "id"])] {
        let mut v = latest.clone();
        v["semantics"]["selections"][id("validAtOccurrence")]["tie_break"] = keys;
        cases.push(v);
    }
    for (i, v) in cases.iter().enumerate() {
        assert!(
            ConceptIR::load(v).is_err_and(|e| e.contains("E-L0-TEMPORAL")),
            "case {i} must reject ambiguous temporal ordering"
        );
    }
}

#[test]
fn percent_literals_cannot_bypass_quantity_type_checks() {
    let mut v = fixture("commerce");
    v["semantics"]["contracts"][id("Available")]["predicate"]["rhs"] =
        json!({"kind":"literal", "literal":{"type":"percent", "value":"50"}});
    assert!(ConceptIR::load(&v).is_err_and(|e| e.contains("E-L0-CONTRACT")));
}
