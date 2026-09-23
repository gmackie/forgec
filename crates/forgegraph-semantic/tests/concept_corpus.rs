//! #69: domain-authored contracts, checked evidence, and adversarial substitutions.
use forgegraph_semantic::concept::*;
use forgegraph_semantic::{DomainIR, Package, compile};
use serde_json::Value;
use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};

fn root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../examples/concept")
}
fn json(path: &Path) -> Value {
    serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap()
}
fn files(path: &Path) -> Vec<PathBuf> {
    let mut paths: Vec<_> = std::fs::read_dir(path)
        .unwrap()
        .map(|p| p.unwrap().path())
        .collect();
    paths.sort();
    assert!(
        !paths.is_empty(),
        "empty mutation class: {}",
        path.display()
    );
    paths
}
fn snapshot(path: &Path, value: &impl serde::Serialize) {
    let expected = format!("{}\n", serde_json::to_string_pretty(value).unwrap());
    if std::env::var("UPDATE_CONCEPT_CORPUS").as_deref() == Ok("1") {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, &expected).unwrap();
    }
    assert_eq!(
        std::fs::read_to_string(path).unwrap(),
        expected,
        "stale snapshot: {}",
        path.display()
    );
}
fn compile_signature(folder: &Path, slug: &str, variant: &str) -> DomainIR {
    let source = std::fs::read_to_string(
        folder
            .join("realizations")
            .join(variant)
            .join("signature.forge"),
    )
    .unwrap();
    let mut package = Package::inline(
        format!("@corpus/{slug}").as_str(),
        vec![(format!("{variant}/signature.forge"), source)],
    );
    package.edition = "2027".into();
    let result = compile(&package, &[]);
    assert!(result.ir.is_some(), "{slug}: {}", result.render());
    result.ir.unwrap()
}
fn type_references(ty: &ConceptType, c: &ConceptIR) {
    match &ty.base {
        Type::Entity { id, .. } => assert!(c.entities.contains_key(id), "unknown entity {id}"),
        Type::Fact { id } => assert!(c.facts.contains_key(id), "unknown fact {id}"),
        Type::Shape { id } => assert!(c.shapes.contains_key(id), "unknown shape {id}"),
        Type::Enum { id } => assert!(c.enums.contains_key(id), "unknown enum {id}"),
        Type::Collection { element, .. } => type_references(element, c),
        Type::Scalar { .. } => {}
    }
    if let Some(id) = &ty.data_class {
        assert!(c.data_classes.contains_key(id));
    }
    if let Some(id) = &ty.purpose {
        assert!(c.purposes.contains_key(id));
    }
}
fn check_integrity(c: &ConceptIR) {
    let mut owners: BTreeMap<&str, BTreeSet<&str>> = BTreeMap::new();
    for entity in c.entities.values() {
        for field in entity.fields.values() {
            type_references(&field.ty, c);
        }
    }
    for fields in c.facts.values().map(|f| &f.fields).chain(c.shapes.values()) {
        for field in fields.values() {
            type_references(&field.ty, c);
        }
    }
    for external in c.externals.values() {
        for ty in external.data.values().chain(external.accepts.values()) {
            type_references(ty, c);
        }
    }
    for policy in c.policies.values() {
        type_references(&policy.resource, c);
    }
    for (id, p) in &c.processes {
        for input in p.inputs.values() {
            type_references(&input.ty, c);
            if let InputOrigin::ProcessResult { process, output } = &input.origin {
                assert_eq!(c.processes[process].outputs[output].ty, input.ty);
            }
        }
        for output in p.outputs.values() {
            type_references(&output.ty, c);
            if matches!(
                output.disposition,
                OutputDisposition::ProduceEntity | OutputDisposition::EmitFact
            ) {
                let target = match &output.ty.base {
                    Type::Entity { id, .. } | Type::Fact { id } => id,
                    _ => panic!("invalid durable output"),
                };
                owners.entry(target).or_default().insert(id);
            }
        }
        for activation in p.activations.values() {
            match activation {
                Activation::Fact { fact } => assert!(c.facts.contains_key(fact)),
                Activation::Change { entity } => assert!(c.entities.contains_key(entity)),
                Activation::ExternalEvent { external, event } => {
                    assert!(c.externals[external].events.contains(event))
                }
                Activation::Request { payload: Some(ty) } => type_references(ty, c),
                _ => {}
            }
        }
        if let Some(behavior) = &p.behavior {
            if let Some(state) = &behavior.stateful {
                type_references(state, c);
            }
            if let Some(workflow) = &behavior.workflow {
                for fact in workflow.waits.values() {
                    assert!(c.facts.contains_key(fact));
                }
            }
        }
    }
    for id in c.entities.keys().chain(c.facts.keys()) {
        assert_eq!(
            owners.get(id.as_str()).map(BTreeSet::len),
            Some(1),
            "{id}: every durable declaration needs exactly one owner"
        );
    }
}
fn mutate(value: &Value, mutation: &Value) -> Value {
    let mut changed = value.clone();
    match mutation["operation"].as_str().unwrap() {
        "replace" => {
            *changed
                .pointer_mut(mutation["path"].as_str().unwrap())
                .expect("mutation pointer must exist") = mutation["value"].clone()
        }
        "remove" => {
            let path = mutation["path"].as_str().unwrap();
            let (parent, field) = path.rsplit_once('/').unwrap();
            let field = field.replace("~1", "/").replace("~0", "~");
            assert!(
                changed
                    .pointer_mut(parent)
                    .unwrap()
                    .as_object_mut()
                    .unwrap()
                    .remove(&field)
                    .is_some()
            );
        }
        "duplicateOwner" | "moveOwner" => {
            let id = mutation["process"].as_str().unwrap();
            let port = mutation["port"].as_str().unwrap();
            let mut other = changed["processes"][id].clone();
            let output = other["outputs"][port].clone();
            other["name"] = "CompetingAuthority".into();
            other["outputs"] = serde_json::json!({"alternative#output:owned": output});
            changed["processes"]
                .as_object_mut()
                .unwrap()
                .insert(format!("{id}Alternative"), other);
            if mutation["operation"] == "moveOwner" {
                changed["processes"][id]["outputs"]
                    .as_object_mut()
                    .unwrap()
                    .remove(port)
                    .unwrap();
            }
        }
        operation => panic!("unknown mutation {operation}"),
    }
    assert_ne!(changed, *value, "mutation must change its target");
    changed
}

#[test]
fn cross_domain_contracts_and_mutations() {
    let root = root();
    let manifest = json(&root.join("manifest.json"));
    let fixtures = manifest["fixtures"].as_array().unwrap();
    assert_eq!(fixtures.len(), 10);
    let mut external_count = 0;
    let mut security_count = 0;
    let mut temporal_count = 0;
    let mut behavior_count = 0;
    let mut concepts = BTreeMap::new();
    for slug in fixtures.iter().map(|v| v.as_str().unwrap()) {
        let folder = root.join(slug);
        for doc in ["README.md", "domain.md", "questions.md"] {
            assert!(
                std::fs::read_to_string(folder.join(doc)).unwrap().len() > 250,
                "{slug}: missing narrative or limitations"
            );
        }
        let value = json(&folder.join("concept-ir.json"));
        let concept = ConceptIR::load(&value).unwrap_or_else(|e| panic!("{slug}: {e}"));
        check_integrity(&concept);
        snapshot(&folder.join("concept-ir.json"), &concept);
        let graph = concept.graph();
        snapshot(&folder.join("views/overview.json"), &graph);
        for (view, kinds) in [
            ("ownership", vec!["produce", "emit"]),
            (
                "security",
                vec!["principal", "resource", "authorize", "purpose"],
            ),
            ("external", vec!["acquire", "export", "activate"]),
        ] {
            let edges: BTreeSet<_> = graph
                .edges
                .iter()
                .filter(|e| {
                    kinds.contains(&e.kind.as_str())
                        && (view != "external"
                            || concept.externals.contains_key(&e.from)
                            || concept.externals.contains_key(&e.to))
                })
                .cloned()
                .collect();
            assert!(!edges.is_empty(), "{slug}: empty {view} view");
            let nodes = graph
                .nodes
                .iter()
                .filter(|(id, _)| edges.iter().any(|e| &e.from == *id || &e.to == *id))
                .map(|(k, v)| (k.clone(), v.clone()))
                .collect();
            snapshot(
                &folder.join(format!("views/{view}.json")),
                &Graph { nodes, edges },
            );
        }
        external_count += usize::from(
            !concept.externals.is_empty()
                && concept.processes.values().any(|p| {
                    p.inputs
                        .values()
                        .any(|i| matches!(i.origin, InputOrigin::External { .. }))
                }),
        );
        security_count += usize::from(
            !concept.policies.is_empty()
                && !concept.purposes.is_empty()
                && concept
                    .entities
                    .values()
                    .any(|e| e.fields.values().any(|f| f.ty.data_class.is_some())),
        );
        temporal_count += usize::from(concept.processes.values().any(|p| {
            p.inputs
                .values()
                .any(|i| i.selection.as_of.is_some() || i.selection.during.is_some())
        }));
        behavior_count += usize::from(concept.processes.values().any(|p| p.behavior.is_some()));
        let a = compile_signature(&folder, slug, "realization-a");
        let b = compile_signature(&folder, slug, "realization-b");
        assert_ne!(a.content_hash(), b.content_hash());
        assert_eq!(
            project(&a).concept.content_hash(),
            project(&b).concept.content_hash()
        );
        let report = concept.realization_report(&a);
        assert!(
            !report.is_satisfied(),
            "sketch must never claim full realization"
        );
        assert_eq!(report, concept.realization_report(&b));
        let sketch_a = json(&folder.join("realizations/realization-a/sketch.json"));
        let sketch_b = json(&folder.join("realizations/realization-b/sketch.json"));
        assert_ne!(sketch_a["implementation"], sketch_b["implementation"]);
        assert_eq!(sketch_a["concept"], sketch_b["concept"]);
        for path in files(&folder.join("mutations/semantic")) {
            let mutation = json(&path);
            let changed = ConceptIR::load(&mutate(&value, &mutation))
                .unwrap_or_else(|e| panic!("{}: {e}", path.display()));
            assert_ne!(
                concept.content_hash(),
                changed.content_hash(),
                "{}",
                path.display()
            );
        }
        for path in files(&folder.join("mutations/invalid")) {
            let mutation = json(&path);
            if mutation["operation"] == "checkProjection" {
                let code = mutation["expectedCode"].as_str().unwrap();
                assert!(
                    report
                        .unproven
                        .iter()
                        .chain(&report.violations)
                        .any(|e| e.code == code
                            && e.subject == mutation["subject"].as_str().unwrap()),
                    "{}",
                    path.display()
                );
            } else {
                let changed = mutate(&value, &mutation);
                let error = ConceptIR::load(&changed).expect_err("invalid mutation must fail load");
                assert!(
                    error.contains(mutation["expectedCode"].as_str().unwrap()),
                    "{}: {error}",
                    path.display()
                );
            }
        }
        for path in files(&folder.join("mutations/realization-only")) {
            let mutation = json(&path);
            assert_eq!(mutation["operation"], "substituteTransport");
            let mut changed = a.clone();
            changed.package.profile = mutation["profile"].as_str().unwrap().into();
            changed.package.targets = serde_json::from_value(mutation["targets"].clone()).unwrap();
            for function in changed.modules.iter_mut().flat_map(|m| &mut m.functions) {
                if let Some(http) = &mut function.http {
                    http.path = mutation["httpPath"].as_str().unwrap().into();
                    http.method = mutation["httpMethod"].as_str().unwrap().into();
                }
            }
            assert_ne!(a.content_hash(), changed.content_hash());
            assert_eq!(
                project(&a).concept.content_hash(),
                project(&changed).concept.content_hash()
            );
            assert_eq!(report, concept.realization_report(&changed));
        }
        concepts.insert(slug, value);
    }
    assert!(external_count >= 6);
    assert!(security_count >= 3);
    assert!(temporal_count >= 3);
    assert!(behavior_count >= 3);
    let coverage = json(&root.join("coverage.json"));
    let mut covered = BTreeSet::new();
    for row in coverage.as_array().unwrap() {
        let axis = row["axis"].as_str().unwrap();
        assert!(covered.insert(axis), "duplicate coverage axis");
        let evidence = concepts[row["fixture"].as_str().unwrap()]
            .pointer(row["pointer"].as_str().unwrap())
            .unwrap();
        assert!(!evidence.is_null());
        assert!(evidence.as_object().is_none_or(|v| !v.is_empty()));
        match row["status"].as_str().unwrap() {
            "gap" => assert!(row["limitation"].as_str().unwrap().len() > 30),
            "represented" => assert!(row["limitation"].is_null()),
            _ => panic!("invalid coverage status"),
        }
    }
    assert_eq!(
        covered,
        manifest["requiredAxes"]
            .as_array()
            .unwrap()
            .iter()
            .map(|v| v.as_str().unwrap())
            .collect()
    );
}
