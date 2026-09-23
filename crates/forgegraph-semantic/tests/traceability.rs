use forgegraph_semantic::{concept::ConceptIR, concept_traceability::TraceWitness};
use serde_json::{Value, json};
fn read(file: &str) -> Value {
    serde_json::from_str(
        &std::fs::read_to_string(format!(
            "{}/../../examples/concept/traceability/{file}.json",
            env!("CARGO_MANIFEST_DIR")
        ))
        .unwrap(),
    )
    .unwrap()
}
fn witness(c: &ConceptIR, domain: &str, journal: bool) -> TraceWitness {
    let data = if journal {
        let mut records = serde_json::Map::new();
        let mut links = vec![];
        for event in read(&format!("{domain}-journal")).as_array().unwrap() {
            match event["kind"].as_str().unwrap() {
                "record" => {
                    records.insert(event["id"].as_str().unwrap().into(), event["value"].clone());
                }
                "link" => links.push(event["value"].clone()),
                other => panic!("unknown journal event {other}"),
            }
        }
        json!({"records":records,"links":links})
    } else {
        read(&format!("{domain}-graph"))
    };
    serde_json::from_value(json!({"conceptHash":c.content_hash(),"requirement":format!("@trace/{domain}/_/Reconstruction"),"at":100,"evidence":if journal {"illustrative:evidence-journal"} else {"illustrative:lineage-graph"},"chain":["record-0","record-1","record-2"],"records":data["records"],"links":data["links"]})).unwrap()
}
#[test]
fn two_realizations_reconstruct_the_same_three_domain_contracts() {
    for domain in ["food", "automated-decision", "healthcare"] {
        let c = ConceptIR::load_closed(&read(domain)).unwrap();
        let hash = c.content_hash();
        for journal in [false, true] {
            let errors = c.check_trace_witness(&witness(&c, domain, journal));
            assert!(errors.is_empty(), "{domain}: {errors:?}");
        }
        assert_eq!(hash, c.content_hash());
        let g = c.graph();
        for edge in &g.edges {
            assert!(g.nodes.contains_key(&edge.from));
            assert!(g.nodes.contains_key(&edge.to));
        }
        let mut next = c.clone();
        next.semantics
            .traceability
            .values_mut()
            .next()
            .unwrap()
            .retention_days = Some(60);
        assert!(
            !next
                .check_trace_witness(&witness(&c, domain, false))
                .is_empty()
        );
        assert!(
            c.semantic_changes(&next)
                .iter()
                .any(|d| d.path.contains("retentionDays"))
        );
    }
}
#[test]
fn malformed_paths_and_insufficient_witnesses_fail_closed() {
    let raw = read("food");
    let id = "@trace/food/_/Reconstruction";
    for (field, value) in [
        ("destination", json!("missing")),
        ("requiredBy", json!("missing")),
        ("retentionDays", json!(0)),
        ("path", json!([])),
        ("requiredAttributes", json!({"missing":["id"]})),
    ] {
        let mut changed = raw.clone();
        changed["semantics"]["traceability"][id][field] = value;
        assert!(
            ConceptIR::load(&changed)
                .unwrap_err()
                .contains("E-L0-TRACEABILITY")
        );
    }
    let mut changed = raw.clone();
    changed["semantics"]["traceability"][id]["path"][1]["fromRole"] = json!("source");
    assert!(ConceptIR::load(&changed).is_err());
    let c = ConceptIR::load_closed(&raw).unwrap();
    let good = witness(&c, "food", false);
    for mutation in 0..8 {
        let mut bad = good.clone();
        match mutation {
            0 => {
                bad.links[0]
                    .roles
                    .insert("source".into(), "record-2".into());
            }
            1 => {
                bad.records.remove("record-1");
            }
            2 => bad.records.get_mut("record-1").unwrap().retained_until = 100,
            3 => bad.records.get_mut("record-1").unwrap().knowledge_time = None,
            4 => bad.records.get_mut("record-1").unwrap().attributes.clear(),
            5 => bad.records.get_mut("record-1").unwrap().declaration = "wrong".into(),
            6 => bad.at = 1000,
            _ => {
                bad.links.pop();
            }
        }
        assert!(
            !c.check_trace_witness(&bad).is_empty(),
            "mutation {mutation}"
        );
    }
}
