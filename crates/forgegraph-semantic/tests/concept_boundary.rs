//! #88: discrete coordination versus facets, placement, and external semantic domains.
//! Corpus sidecars are research contracts, not additions to the ConceptIR schema.
use forgegraph_semantic::concept::{Activation, ConceptIR, Type};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::collections::BTreeSet;
use std::path::{Path, PathBuf};

fn root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../examples/concept-boundary")
}
fn read(path: &Path) -> Value {
    serde_json::from_slice(
        &std::fs::read(path).unwrap_or_else(|e| panic!("{}: {e}", path.display())),
    )
    .unwrap_or_else(|e| panic!("{}: {e}", path.display()))
}
fn strings(value: &Value) -> Vec<&str> {
    value
        .as_array()
        .unwrap()
        .iter()
        .map(|v| v.as_str().unwrap())
        .collect()
}
fn digest(bytes: &[u8]) -> String {
    hex::encode(Sha256::digest(bytes))
}
fn snapshot(path: &Path, value: &Value) {
    let text = format!("{}\n", serde_json::to_string_pretty(value).unwrap());
    if std::env::var("UPDATE_BOUNDARY_CORPUS").as_deref() == Ok("1") {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, &text).unwrap();
    }
    assert_eq!(
        std::fs::read_to_string(path).unwrap(),
        text,
        "stale corpus artifact {}",
        path.display()
    );
}
fn text(value: &Value) -> &str {
    let s = value.as_str().unwrap();
    assert!(!s.trim().is_empty());
    s
}
/// Graphs intentionally retain dangling reference nodes for diagnostics. Only declarations
/// can anchor corpus claims; graph membership is not declaration evidence.
fn declared_ids(c: &ConceptIR) -> BTreeSet<&str> {
    c.entities
        .keys()
        .chain(c.facts.keys())
        .chain(c.externals.keys())
        .chain(c.principals.keys())
        .chain(c.policies.keys())
        .chain(c.processes.keys())
        .chain(c.purposes.keys())
        .chain(c.data_classes.keys())
        .chain(c.shapes.keys())
        .chain(c.enums.keys())
        .map(String::as_str)
        .collect()
}
fn timing_valid(parameters: &Value) -> bool {
    let values = ["periodUs", "deadlineUs", "wcetBudgetUs"].map(|key| parameters[key].as_u64());
    matches!(values, [Some(period), Some(deadline), Some(wcet)] if wcet > 0 && wcet <= deadline && deadline <= period)
}
/// A finite observation checker. Passing a trace never proves worst-case latency.
fn timing_trace(parameters: &Value, trace: &[(u64, u64, u64)]) -> bool {
    if !timing_valid(parameters) || trace.is_empty() {
        return false;
    }
    let period = parameters["periodUs"].as_u64().unwrap();
    let deadline = parameters["deadlineUs"].as_u64().unwrap();
    let wcet = parameters["wcetBudgetUs"].as_u64().unwrap();
    trace
        .iter()
        .enumerate()
        .all(|(i, &(release, finish, execution))| {
            let expected = (i as u64).checked_mul(period);
            expected == Some(release)
                && finish
                    .checked_sub(release)
                    .is_some_and(|elapsed| elapsed <= deadline)
                && execution <= wcet
                && finish
                    .checked_sub(release)
                    .is_some_and(|elapsed| execution <= elapsed)
        })
}
fn semantic_hash(concept: &ConceptIR, boundary: &Value) -> String {
    // L1/L2 placement, file paths, tools and provider choices are deliberately outside L0 meaning.
    let semantic_concerns: Vec<_> = boundary["concerns"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|c| matches!(c["layer"].as_str(), Some("L0" | "L0-facet")))
        .collect();
    digest(
        &serde_json::to_vec(
            &json!({"concept":concept,"concerns":semantic_concerns,"facets":boundary["facets"]}),
        )
        .unwrap(),
    )
}

#[test]
fn boundary_corpus_loads_current_kernel_and_checks_every_declared_seam() {
    let root = root();
    let manifest = read(&root.join("manifest.json"));
    let required: BTreeSet<_> = strings(&manifest["requiredPressures"])
        .into_iter()
        .collect();
    let slugs = strings(&manifest["fixtures"]);
    assert_eq!(slugs.len(), 10);
    assert_eq!(slugs.iter().collect::<BTreeSet<_>>().len(), 10);
    assert_eq!(
        slugs.iter().copied().collect::<BTreeSet<_>>(),
        BTreeSet::from([
            "flight-control",
            "packaging-line",
            "robot-mission",
            "network-control",
            "game-simulation",
            "consensus",
            "medical-device",
            "digital-twin",
            "hardware-dataflow",
            "scientific-workflow",
        ]),
        "the corpus must cover the ten issue88 boundary domains"
    );
    let filter = std::env::var("BOUNDARY_FIXTURE").ok();
    if let Some(filter) = &filter {
        assert!(slugs.contains(&filter.as_str()), "unknown fixture");
    }
    let mut coverage = serde_json::Map::new();
    let mut seen = BTreeSet::new();
    let mut timing_fixtures = BTreeSet::new();
    let mut formats = BTreeSet::new();
    for slug in slugs {
        if filter.as_ref().is_some_and(|f| f != slug) {
            continue;
        }
        let folder = root.join(slug);
        for file in [
            "domain.md",
            "concept-boundary.md",
            "questions.md",
            "specialized-model/README.md",
            "views/concept.mmd",
            "views/boundary.mmd",
        ] {
            let content = std::fs::read_to_string(folder.join(file))
                .unwrap_or_else(|e| panic!("{slug}/{file}: {e}"));
            assert!(
                content.trim().len() > 40,
                "{slug}/{file} is not a substantive artifact"
            );
        }
        let raw = read(&folder.join("concept-ir.json"));
        let c = ConceptIR::load(&raw).unwrap_or_else(|e| panic!("{slug}: {e:?}"));
        assert_eq!(c.version, manifest["conceptVersion"]);
        assert_eq!(c.package, format!("@boundary/{slug}"));
        assert!(!c.processes.is_empty());
        assert!(
            !c.externals.is_empty(),
            "{slug} must expose the environment boundary"
        );
        assert!(
            c.validate_closed().is_empty(),
            "{slug}: {:?}",
            c.validate_closed()
        );
        let mut unknown = raw.clone();
        unknown["continuousEquations"] = json!([]);
        assert!(
            ConceptIR::load(&unknown).is_err(),
            "external semantics must not silently become kernel fields"
        );
        let b = read(&folder.join("boundary.json"));
        assert_eq!(b["version"], 1);
        assert_eq!(b["slug"], slug);
        let graph = c.graph();
        let declarations = declared_ids(&c);
        let known = |id: &str| declarations.contains(id);
        let mut outcomes = BTreeSet::new();
        let mut concern_ids = BTreeSet::new();
        let mut fixture_pressures = BTreeSet::new();
        for concern in b["concerns"].as_array().unwrap() {
            assert!(
                concern_ids.insert(text(&concern["id"])),
                "duplicate concern"
            );
            text(&concern["description"]);
            text(&concern["rationale"]);
            let layer = text(&concern["layer"]);
            let outcome = text(&concern["outcome"]);
            assert!(["A", "B", "C"].contains(&outcome));
            outcomes.insert(outcome);
            match layer {
                "L0" => assert_eq!(outcome, "A"),
                "L0-facet" => assert_eq!(outcome, "B"),
                "external" => assert_eq!(outcome, "C"),
                "L1" | "L2" => {}
                _ => panic!("unknown layer"),
            }
            let refs = strings(&concern["conceptRefs"]);
            assert!(!refs.is_empty());
            for id in refs {
                assert!(known(id), "{slug}: missing concept anchor {id}");
            }
            for pressure in strings(&concern["pressures"]) {
                assert!(required.contains(pressure), "unknown pressure {pressure}");
                seen.insert(pressure.to_owned());
                fixture_pressures.insert(pressure.to_owned());
            }
        }
        assert!(!concern_ids.is_empty());
        assert_eq!(outcomes, strings(&b["outcomes"]).into_iter().collect());
        let mut facet_ids = BTreeSet::new();
        for (facet_index, facet) in b["facets"].as_array().unwrap().iter().enumerate() {
            assert!(facet_ids.insert(text(&facet["id"])));
            assert_eq!(facet["status"], "proposed");
            text(&facet["meaning"]);
            assert!(!strings(&facet["obligations"]).is_empty());
            let targets = strings(&facet["targets"]);
            assert!(!targets.is_empty());
            for id in targets {
                assert!(known(id), "facet target not in ConceptIR");
            }
            if facet["kind"] == "timing" {
                timing_fixtures.insert(slug);
                let params = &facet["parameters"];
                assert!(timing_valid(params));
                let period = params["periodUs"].as_u64().unwrap();
                let deadline = params["deadlineUs"].as_u64().unwrap();
                let wcet = params["wcetBudgetUs"].as_u64().unwrap();
                assert!(timing_trace(
                    params,
                    &[(0, wcet, wcet), (period, period + wcet, wcet)]
                ));
                assert!(!timing_trace(params, &[(0, deadline + 1, wcet)]));
                assert!(!timing_trace(
                    params,
                    &[(0, wcet, wcet), (period + 1, period + 1 + wcet, wcet)]
                ));
                assert!(!timing_trace(params, &[(0, wcet + 1, wcet + 1)]));
                let mut invalid = params.clone();
                invalid["wcetBudgetUs"] = json!(deadline + 1);
                assert!(!timing_valid(&invalid));
                let mut changed = b.clone();
                changed["facets"][facet_index]["parameters"]["periodUs"] = json!(period + 1);
                assert_ne!(semantic_hash(&c, &b), semantic_hash(&c, &changed));
                let mut changed_deadline = b.clone();
                changed_deadline["facets"][facet_index]["parameters"]["deadlineUs"] =
                    json!(deadline + 1);
                assert_ne!(semantic_hash(&c, &b), semantic_hash(&c, &changed_deadline));
            }
        }
        text(&b["realization"]["strategy"]);
        text(&b["realization"]["placement"]);
        assert!(!strings(&b["realization"]["limitations"]).is_empty());
        let mut placement = b.clone();
        placement["realization"]["placement"] = json!("different deployment mechanism");
        assert_eq!(semantic_hash(&c, &b), semantic_hash(&c, &placement));
        let mut handoffs = Vec::new();
        let mut artifact_ids = BTreeSet::new();
        assert!(
            !b["artifacts"].as_array().unwrap().is_empty(),
            "{slug}: missing specialized handoff"
        );
        for artifact in b["artifacts"].as_array().unwrap() {
            let id = text(&artifact["id"]);
            assert!(artifact_ids.insert(id));
            let relative = text(&artifact["path"]);
            let path = Path::new(relative);
            assert!(
                !path.is_absolute()
                    && path
                        .components()
                        .all(|c| matches!(c, std::path::Component::Normal(_)))
            );
            let bytes = std::fs::read(folder.join(path)).unwrap();
            assert!(!bytes.is_empty());
            let process = text(&artifact["process"]);
            let p = c.processes.get(process).expect("handoff process missing");
            let inputs = strings(&artifact["inputPorts"]);
            let outputs = strings(&artifact["outputPorts"]);
            assert!(!inputs.is_empty() && !outputs.is_empty());
            for port in inputs {
                assert!(
                    p.inputs.contains_key(port),
                    "{slug}: unknown input port {port}"
                );
            }
            for port in outputs {
                assert!(
                    p.outputs.contains_key(port),
                    "{slug}: unknown output port {port}"
                );
            }
            text(&artifact["claim"]);
            text(&artifact["status"]);
            formats.insert(text(&artifact["format"]).to_owned());
            handoffs.push(json!({"id":id,"sha256":digest(&bytes),"path":relative,"process":process,"inputPorts":artifact["inputPorts"],"outputPorts":artifact["outputPorts"],"status":artifact["status"],"claim":artifact["claim"]}));
        }
        assert!(!b["sources"].as_array().unwrap().is_empty());
        for source in b["sources"].as_array().unwrap() {
            text(&source["title"]);
            text(&source["supports"]);
            assert!(text(&source["url"]).starts_with("https://"));
        }
        snapshot(
            &folder.join("views/concept.json"),
            &serde_json::to_value(&graph).unwrap(),
        );
        snapshot(
            &folder.join("views/handoffs.json"),
            &json!({"version":1,"conceptHash":c.content_hash(),"boundarySemanticHash":semantic_hash(&c,&b),"artifacts":handoffs}),
        );
        coverage.insert(
            slug.to_owned(),
            json!({"outcomes":outcomes,"pressures":fixture_pressures,"proposedFacets":facet_ids}),
        );
    }
    if filter.is_none() {
        assert_eq!(seen, required.into_iter().map(str::to_owned).collect());
        assert!(timing_fixtures.len() >= 3);
        for slug in ["flight-control", "packaging-line", "medical-device"] {
            assert!(timing_fixtures.contains(slug));
        }
        for format in ["TLA+", "Modelica", "SSP"] {
            assert!(
                formats.iter().any(|f| f.contains(format)),
                "missing specialized handoff {format}"
            );
        }
        snapshot(&root.join("coverage.json"), &Value::Object(coverage));
    }
}

#[test]
fn offline_timing_checker_rejects_missing_invalid_and_late_observations() {
    let p = json!({"periodUs":10000,"deadlineUs":5000,"wcetBudgetUs":2000});
    assert!(!timing_trace(&p, &[]));
    assert!(!timing_valid(
        &json!({"periodUs":1,"deadlineUs":2,"wcetBudgetUs":1})
    ));
    assert!(!timing_valid(
        &json!({"periodUs":10,"deadlineUs":5,"wcetBudgetUs":0})
    ));
    assert!(!timing_valid(
        &json!({"periodUs":10.5,"deadlineUs":5,"wcetBudgetUs":1})
    ));
    assert!(!timing_trace(&p, &[(10, 5, 1)]));
    assert!(timing_trace(&p, &[(0, 2000, 2000), (10000, 12000, 2000)]));
}

#[test]
fn corpus_references_reject_diagnostic_only_nodes_and_unclosed_activation_types() {
    let raw = read(&root().join("flight-control/concept-ir.json"));
    let valid = ConceptIR::load(&raw).unwrap();
    assert!(valid.validate_closed().is_empty());
    let process = "@boundary/flight-control/_/ReactToFlightTick";
    let missing = "@boundary/flight-control/_/MissingObservation";
    let mut dangling = valid.clone();
    dangling
        .processes
        .get_mut(process)
        .unwrap()
        .activations
        .insert(
            format!("{process}#activation:missing"),
            Activation::Fact {
                fact: missing.into(),
            },
        );
    // The real loader currently admits this unresolved activation, and graph() keeps
    // a diagnostic reference node. Neither is evidence of a declared corpus anchor.
    assert!(ConceptIR::load(&serde_json::to_value(&dangling).unwrap()).is_ok());
    assert!(dangling.graph().nodes.contains_key(missing));
    assert!(!declared_ids(&dangling).contains(missing));
    assert_eq!(
        dangling.validate_closed()[0].message,
        format!("unknown activation fact `{missing}`")
    );

    let mut unknown_event = valid.clone();
    unknown_event
        .processes
        .get_mut(process)
        .unwrap()
        .activations
        .insert(
            format!("{process}#activation:unknown"),
            Activation::ExternalEvent {
                external: "@boundary/flight-control/_/AirframeIO".into(),
                event: "UndeclaredTick".into(),
            },
        );
    assert_eq!(
        unknown_event.validate_closed()[0].message,
        "unknown external event `UndeclaredTick`"
    );

    let mut payload = valid.clone();
    let mut ty = payload.processes[process]
        .inputs
        .values()
        .next()
        .unwrap()
        .ty
        .clone();
    ty.base = Type::Shape { id: missing.into() };
    payload
        .processes
        .get_mut(process)
        .unwrap()
        .activations
        .insert(
            format!("{process}#activation:request"),
            Activation::Request { payload: Some(ty) },
        );
    assert_eq!(
        payload.validate_closed()[0].message,
        format!("unknown shape `{missing}`")
    );

    let mut incompatible = valid.clone();
    incompatible
        .externals
        .get_mut("@boundary/flight-control/_/AirframeIO")
        .unwrap()
        .accepts
        .clear();
    assert!(
        incompatible
            .validate_closed()
            .iter()
            .any(|e| e.message.contains("external output type"))
    );
}
