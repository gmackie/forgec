use forgegraph_semantic::concept::*;
use forgegraph_semantic::{DomainIR, Package, compile, load_package};
use std::path::Path;

fn acme() -> DomainIR {
    let root = Path::new(concat!(env!("CARGO_MANIFEST_DIR"), "/../../examples"));
    let payments = compile(&load_package(&root.join("payments")).unwrap(), &[])
        .ir
        .unwrap();
    compile(&load_package(&root.join("acme")).unwrap(), &[&payments])
        .ir
        .unwrap()
}
fn fixture(source: &str) -> DomainIR {
    let mut p = Package::inline(
        "@test/concept",
        vec![("src/model.forge".into(), source.into())],
    );
    p.edition = "2027".into();
    let result = compile(&p, &[]);
    assert!(result.ir.is_some(), "{}", result.render());
    result.ir.unwrap()
}

#[test]
fn acme_projection_is_stable_and_reports_partial_knowledge() {
    let projection = project(&acme());
    assert!(projection.concept.validate().is_empty());
    assert!(!projection.coverage.is_empty());
    assert!(projection.concept.externals.is_empty()); // dependency package != external business system
    assert!(
        projection
            .concept
            .processes
            .values()
            .flat_map(|p| p.outputs.values())
            .all(|o| matches!(o.disposition, OutputDisposition::Return))
    );
    assert_eq!(
        ConceptIR::load(&serde_json::to_value(&projection.concept).unwrap()).unwrap(),
        projection.concept
    );
    let fulfillment = &projection.concept.processes["@acme/commerce/_/FulfillOrder"];
    assert!(
        fulfillment
            .activations
            .values()
            .any(|a| matches!(a, Activation::Fact { .. }))
    );
    assert!(projection.concept.processes.values().any(|p| {
        p.activations
            .values()
            .any(|a| matches!(a, Activation::Schedule { .. }))
    }));
    let workflow = &projection.concept.processes["@acme/commerce/_/ProcessOrder"];
    let Some(Behavior::Workflow { waits }) = &workflow.behavior else {
        panic!("workflow semantics missing")
    };
    assert!(waits.keys().any(|id| id.ends_with("#step:captured")));
    insta::assert_json_snapshot!(projection);
}

#[test]
fn transport_provider_and_file_changes_preserve_business_hash() {
    let original = acme();
    let expected = project(&original).concept;
    let mut changed = original.clone();
    changed.package.targets = vec!["different-provider".into()];
    changed.package.profile = "different-profile".into();
    for module in &mut changed.modules {
        for resource in &mut module.resources {
            if let Some(crud) = &mut resource.decorators.crud {
                crud.path = "/different".into();
            }
            for op in &mut resource.operations {
                if let Some(http) = &mut op.http {
                    http.path = "/different".into();
                }
            }
        }
        for function in &mut module.functions {
            if let Some(http) = &mut function.http {
                http.path = "/different".into();
            }
        }
        for channel in &mut module.channels {
            channel.delivery = "different-delivery".into();
            channel.distribution = "different-distribution".into();
        }
    }
    assert_ne!(original.content_hash(), changed.content_hash());
    assert_eq!(
        expected.content_hash(),
        project(&changed).concept.content_hash()
    );
    assert!(expected.check_realization(&changed).is_empty());
    changed
        .modules
        .iter_mut()
        .flat_map(|m| &mut m.resources)
        .find(|r| r.name == "Customer")
        .unwrap()
        .fields
        .retain(|f| f.name != "name");
    assert_ne!(
        expected.content_hash(),
        project(&changed).concept.content_hash()
    );
    assert!(!expected.check_realization(&changed).is_empty());

    let mut package = Package::inline(
        "@test/move",
        vec![(
            "src/first.forge".into(),
            "resource Customer { id : id }".into(),
        )],
    );
    let first = project(&compile(&package, &[]).ir.unwrap()).concept;
    package.files[0].path = "src/other.forge".into();
    assert_eq!(
        first.content_hash(),
        project(&compile(&package, &[]).ir.unwrap())
            .concept
            .content_hash()
    );
}

#[test]
fn explicit_producer_contracts_reject_competing_owners() {
    let mut concept = project(&fixture("resource Customer { id : id }\nfunction A { output Customer.Record }\nfunction B { output Customer.Record }\n")).concept;
    for p in concept.processes.values_mut() {
        p.outputs.values_mut().next().unwrap().disposition = OutputDisposition::ProduceEntity;
    }
    let errors = concept.validate();
    assert_eq!(errors.len(), 1);
    assert_eq!(errors[0].code, "E-L0-PRODUCER");
    assert_eq!(errors[0].subject, "@test/concept/_/Customer");
    assert!(ConceptIR::load(&serde_json::to_value(&concept).unwrap()).is_err());
    concept.processes.remove("@test/concept/_/B");
    assert!(concept.validate().is_empty());
    concept
        .processes
        .values_mut()
        .next()
        .unwrap()
        .outputs
        .values_mut()
        .next()
        .unwrap()
        .disposition = OutputDisposition::EmitFact;
    assert_eq!(concept.validate()[0].code, "E-L0-OUTPUT");
}

#[test]
fn governance_reuses_catalog_ids_and_selection_is_explicit() {
    let concept = project(&fixture("purpose Support\ndataClass Email extends data.contact.email\nresource Customer {\n id : id\n email : text @data(Email)\n}\n")).concept;
    assert!(concept.purposes.contains_key("@test/concept/_/Support"));
    assert_eq!(
        concept.entities["@test/concept/_/Customer"].fields["email"]
            .ty
            .data_class
            .as_deref(),
        Some("@test/concept/_/Email")
    );
    assert_eq!(
        concept.data_classes["@test/concept/_/Email"].extends,
        "data.contact.email"
    );
    let selection = Selection {
        cardinality: Cardinality::Many,
        for_binding: Some("customer".into()),
        predicate: None,
        during: Some("90d".into()),
        as_of: None,
    };
    let roundtrip: Selection =
        serde_json::from_value(serde_json::to_value(&selection).unwrap()).unwrap();
    assert_eq!(selection, roundtrip);
}

#[test]
fn explicit_ingestion_contract_separates_acquisition_activation_and_authority() {
    use forgegraph_semantic::ir::Expr;
    use std::collections::BTreeMap;
    let mut concept = project(&fixture("resource Customer { id : id }\nresource Transaction { id : id }\nresource Risk { id : id }\nfunction AssessRisk { input Customer.Record\n output Risk.Record }\n")).concept;
    let process_id = "@test/concept/_/AssessRisk";
    let input_type = concept.processes[process_id]
        .inputs
        .values()
        .next()
        .unwrap()
        .ty
        .clone();
    let principal_id = "@test/concept/_/Employee";
    let policy_id = "@test/concept/_/SameOrganization";
    let external_id = "@test/concept/_/CreditBureau";
    concept.principals.insert(
        principal_id.into(),
        Principal {
            name: "Employee".into(),
            attributes: BTreeMap::from([("customer".into(), input_type.clone())]),
        },
    );
    concept.policies.insert(
        policy_id.into(),
        Policy {
            name: "SameOrganization".into(),
            principal: principal_id.into(),
            resource: input_type.clone(),
            purpose: None,
            required_attributes: ["employee.customer".into(), "customer.id".into()].into(),
            effect: PolicyEffect::Permit,
            predicate: Expr::Binary {
                op: "==".into(),
                lhs: Box::new(Expr::Name {
                    path: vec!["employee".into(), "customer".into()],
                }),
                rhs: Box::new(Expr::Name {
                    path: vec!["customer".into(), "id".into()],
                }),
            },
        },
    );
    concept.externals.insert(
        external_id.into(),
        External {
            name: "CreditBureau".into(),
            data: BTreeMap::from([("Customer".into(), input_type.clone())]),
            events: ["Updated".into()].into(),
            accepts: BTreeMap::new(),
        },
    );
    let process = concept.processes.get_mut(process_id).unwrap();
    process.principal = Some(principal_id.into());
    process.authorizations.push(Authorization {
        policy: policy_id.into(),
        mode: AuthorizationMode::RequireAll,
    });
    process.activations.insert(
        format!("{process_id}#activation:nightly"),
        Activation::Schedule {
            expression: "0 0 * * *".into(),
            timezone: Some("UTC".into()),
        },
    );
    process.activations.insert(
        format!("{process_id}#activation:updated"),
        Activation::ExternalEvent {
            external: external_id.into(),
            event: "Updated".into(),
        },
    );
    process.inputs.insert(
        format!("{process_id}#input:credit"),
        ProcessInput {
            ty: input_type.clone(),
            origin: InputOrigin::External {
                external: external_id.into(),
            },
            selection: Selection {
                cardinality: Cardinality::Latest,
                for_binding: Some("customer".into()),
                predicate: None,
                during: None,
                as_of: None,
            },
            authorization: None,
        },
    );
    let mut transactions = input_type;
    transactions.base = Type::Entity {
        id: "@test/concept/_/Transaction".into(),
        representation: EntityRepresentation::Record,
    };
    process.inputs.insert(
        format!("{process_id}#input:transactions"),
        ProcessInput {
            ty: transactions,
            origin: InputOrigin::Internal,
            selection: Selection {
                cardinality: Cardinality::Many,
                for_binding: Some("customer".into()),
                predicate: None,
                during: Some("90d".into()),
                as_of: None,
            },
            authorization: None,
        },
    );
    process.outputs.values_mut().next().unwrap().disposition = OutputDisposition::ProduceEntity;
    assert!(concept.validate().is_empty());
    let graph = concept.graph();
    assert!(
        graph
            .edges
            .iter()
            .any(|e| e.from == external_id && e.to == process_id && e.kind == "acquire")
    );
    assert!(
        graph
            .edges
            .iter()
            .any(|e| e.from == external_id && e.to == process_id && e.kind == "activate")
    );
    assert!(
        graph
            .edges
            .iter()
            .any(|e| e.from == process_id && e.to.ends_with("/Risk") && e.kind == "produce")
    );
    assert_eq!(
        ConceptIR::load(&serde_json::to_value(&concept).unwrap()).unwrap(),
        concept
    );
    let mut invalid = concept.clone();
    invalid.externals.clear();
    assert!(
        invalid
            .validate()
            .iter()
            .any(|e| e.code == "E-L0-REFERENCE")
    );
    invalid = concept.clone();
    invalid.policies.clear();
    assert!(
        invalid
            .validate()
            .iter()
            .any(|e| e.code == "E-L0-REFERENCE")
    );
    insta::assert_json_snapshot!(concept);
}

#[test]
fn projection_order_and_version_validation_are_deterministic() {
    let mut ir = acme();
    let original = project(&ir).concept;
    ir.modules.reverse();
    for module in &mut ir.modules {
        module.resources.reverse();
        module.functions.reverse();
    }
    assert_eq!(
        original.canonical_json(),
        project(&ir).concept.canonical_json()
    );
    let mut json = serde_json::to_value(&original).unwrap();
    json["version"] = serde_json::json!("concept-ir/999");
    assert!(ConceptIR::load(&json).is_err());
    let mut json = serde_json::to_value(&original).unwrap();
    json["provider"] = serde_json::json!("accidental runtime metadata");
    assert!(ConceptIR::load(&json).is_err());
    assert!(original.graph().edges.iter().any(|e| e.kind == "wait"));
}
