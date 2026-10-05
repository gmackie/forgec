use forgegraph_semantic::concept::ConceptIR;
use serde_json::Value;
use std::collections::BTreeMap;
use std::path::PathBuf;
fn fixture(name: &str) -> Value {
    serde_json::from_str(
        &std::fs::read_to_string(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join(format!(
            "../../examples/concept/business-semantics/{name}.json"
        )))
        .unwrap(),
    )
    .unwrap()
}
#[test]
fn ten_transaction_scenarios_are_typed_and_have_explicit_provenance() {
    let model = ConceptIR::load_closed(&fixture("rea-commerce")).unwrap();
    let corpus = fixture("rea-scenarios");
    let scenarios = corpus["scenarios"].as_array().unwrap();
    assert_eq!(scenarios.len(), 10);
    for scenario in scenarios {
        assert!(!scenario["assertions"].as_array().unwrap().is_empty());
        assert_eq!(
            scenario["provenance"],
            "Forge modeling choice inspired by REA literature; not verified ISO normative semantics"
        );
        let records = corpus["records"].as_array().unwrap();
        let by_id: BTreeMap<_, _> = records
            .iter()
            .map(|record| (record["id"].as_str().unwrap(), record))
            .collect();
        assert_eq!(records.len(), by_id.len(), "duplicate identity");
        for record in records {
            let declaration = record["declaration"].as_str().unwrap();
            let fields = model
                .entities
                .get(declaration)
                .map(|v| &v.fields)
                .or_else(|| model.facts.get(declaration).map(|v| &v.fields))
                .unwrap();
            for (name, field) in fields {
                assert!(
                    field.ty.optional || record["fields"].get(name).is_some(),
                    "missing required {declaration}.{name}"
                );
            }
            for (name, value) in record["fields"].as_object().unwrap() {
                let field = fields
                    .get(name)
                    .unwrap_or_else(|| panic!("undeclared {declaration}.{name}"));
                let ty = serde_json::to_value(&field.ty.base).unwrap();
                if let Some(scalar) = ty.get("name").and_then(Value::as_str) {
                    match scalar {
                        "decimal" => {
                            value
                                .as_str()
                                .unwrap()
                                .parse::<i128>()
                                .expect("exact whole units in this corpus");
                        }
                        "id" | "text" | "datetime" => {
                            assert!(value.is_string(), "invalid {name} scalar");
                        }
                        other => panic!("unhandled observed scalar {other}"),
                    }
                }
                if let Some(target) = ty.get("id").and_then(Value::as_str) {
                    let referenced = by_id.get(value.as_str().unwrap()).unwrap();
                    assert_eq!(
                        referenced["declaration"], target,
                        "wrong endpoint for {name}"
                    );
                }
            }
        }
        for assertion in scenario["assertions"].as_array().unwrap() {
            match assertion["kind"].as_str().unwrap() {
                "sum" => {
                    let sum: i128 = assertion["records"]
                        .as_array()
                        .unwrap()
                        .iter()
                        .map(|id| {
                            by_id[id.as_str().unwrap()]["fields"]
                                [assertion["field"].as_str().unwrap()]
                            .as_str()
                            .unwrap()
                            .parse::<i128>()
                            .unwrap()
                        })
                        .sum();
                    let expected = assertion["expected"]
                        .as_str()
                        .unwrap()
                        .parse::<i128>()
                        .unwrap();
                    assert_eq!(sum, expected);
                }
                "same" => {
                    let left = &by_id[assertion["left"].as_str().unwrap()]["fields"]
                        [assertion["leftField"].as_str().unwrap()];
                    let right = &by_id[assertion["right"].as_str().unwrap()]["fields"]
                        [assertion["rightField"].as_str().unwrap()];
                    assert_eq!(left, right);
                }
                "distinct" => {
                    let values: std::collections::BTreeSet<_> = assertion["records"]
                        .as_array()
                        .unwrap()
                        .iter()
                        .map(|id| id.as_str().unwrap())
                        .collect();
                    assert_eq!(values.len(), assertion["records"].as_array().unwrap().len());
                }
                "views" => {
                    let views: Vec<_> = assertion["views"]
                        .as_array()
                        .unwrap()
                        .iter()
                        .map(|id| &model.semantics.views[id.as_str().unwrap()])
                        .collect();
                    assert!(views.iter().all(|v| v.fact == views[0].fact));
                    assert_eq!(
                        by_id[assertion["record"].as_str().unwrap()]["declaration"],
                        views[0].fact
                    );
                }
                "before" => {
                    let index = |key: &str| {
                        records
                            .iter()
                            .position(|r| r["id"] == assertion[key])
                            .unwrap()
                    };
                    assert!(index("left") < index("right"));
                }
                "remaining" => {
                    let amount = by_id[assertion["position"].as_str().unwrap()]["fields"]["amount"]
                        .as_str()
                        .unwrap()
                        .parse::<i128>()
                        .unwrap();
                    let settled: i128 = assertion["payments"]
                        .as_array()
                        .unwrap()
                        .iter()
                        .map(|id| {
                            by_id[id.as_str().unwrap()]["fields"]["quantity"]
                                .as_str()
                                .unwrap()
                                .parse::<i128>()
                                .unwrap()
                        })
                        .sum();
                    assert_eq!(
                        (amount - settled).to_string(),
                        assertion["expected"].as_str().unwrap()
                    );
                }
                "composition" => {
                    let id = assertion["declaration"].as_str().unwrap();
                    assert!(model.entities.contains_key(id) || model.shapes.contains_key(id));
                }
                other => panic!("unknown scenario assertion {other}"),
            }
        }
    }
}

#[test]
fn effects_support_multiple_causes_typed_inventory_targets_and_derived_status() {
    let raw = fixture("rea-commerce");
    let model = ConceptIR::load_closed(&raw).unwrap();
    let id = |name: &str| format!("@semantics/commerce/_/{name}");
    assert_eq!(
        model.semantics.effects[&id("ExchangeCompletion")]
            .causes
            .len(),
        2
    );
    let decrease = &model.semantics.effects[&id("StockDecreased")];
    let increase = &model.semantics.effects[&id("StockIncreased")];
    assert_eq!(decrease.causes, increase.causes);
    assert_ne!(decrease.fact, increase.fact);
    assert_eq!(model.processes[&id("ReadTransferStatus")].inputs.len(), 2);
    assert!(!model.semantics.events.contains(&id("TransferStatus")));
    assert!(
        model.semantics.temporal[&id("StockIncreased")]
            .valid
            .is_some()
    );
    assert!(
        model.semantics.temporal[&id("StockIncreased")]
            .knowledge
            .is_some()
    );
    assert!(matches!(
        model.semantics.contracts[&id("NonnegativeStockEffect")].owner,
        forgegraph_semantic::concept_semantics::ContractOwner::Fact { .. }
    ));
    let mut bad = raw.clone();
    bad["semantics"]["effects"][id("StockIncreased")]["targets"]["target"] =
        serde_json::json!(id("Party"));
    assert!(
        ConceptIR::load_closed(&bad)
            .unwrap_err()
            .contains("E-L0-EFFECT")
    );
    let mut bad = raw;
    bad["semantics"]["relationships"][id("Custody")]["evidence"] =
        serde_json::json!([id("Missing")]);
    assert!(
        ConceptIR::load_closed(&bad)
            .unwrap_err()
            .contains("E-L0-RELATIONSHIP")
    );
}

#[test]
fn relationship_endpoint_carrier_evidence_and_validity_changes_are_semantic() {
    let model = ConceptIR::load_closed(&fixture("rea-commerce")).unwrap();
    let id = |name: &str| format!("@semantics/commerce/_/{name}");
    for change in ["endpoint", "carrier", "evidence", "validity"] {
        let mut changed = model.clone();
        match change {
            "endpoint" => {
                changed
                    .semantics
                    .relationships
                    .get_mut(&id("Custody"))
                    .unwrap()
                    .endpoints
                    .get_mut("party")
                    .unwrap()
                    .field = Some("resource".into())
            }
            "carrier" => {
                changed
                    .semantics
                    .relationships
                    .get_mut(&id("Custody"))
                    .unwrap()
                    .carrier = Some(id("ControlAssignment"))
            }
            "evidence" => changed
                .semantics
                .relationships
                .get_mut(&id("Custody"))
                .unwrap()
                .evidence
                .clear(),
            "validity" => {
                changed
                    .semantics
                    .temporal
                    .get_mut(&id("CustodyAssignment"))
                    .unwrap()
                    .valid = None
            }
            _ => unreachable!(),
        }
        let diffs = model.semantic_changes(&changed);
        assert!(!diffs.is_empty());
        assert!(
            diffs
                .iter()
                .all(|d| d.path.starts_with(if change == "validity" {
                    "/semantics/temporal/"
                } else {
                    "/semantics/relationships/"
                }))
        );
    }
}
