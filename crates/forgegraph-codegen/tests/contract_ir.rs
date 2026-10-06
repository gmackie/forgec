//! Contract IR v1 (ForgeGraph's registry format): `forgec build` emits it
//! from the OpenAPI projection with ForgeGraph's ids, policy and canonical
//! fingerprints.
use forgegraph_codegen::contract_ir::{self, EmitOptions, emit::*};
use serde_json::{Value, json};
use std::path::Path;

fn examples() -> &'static Path {
    Path::new(concat!(env!("CARGO_MANIFEST_DIR"), "/../../examples"))
}

/// Compile a dependency-free package and emit its contract, as `forgec build` does.
fn contract_of(dir: &Path, service_id: Option<&str>) -> Value {
    let pkg = forgegraph_semantic::load_package(dir).unwrap();
    let compiled = forgegraph_semantic::compile(&pkg, &[]);
    let errors: Vec<_> = compiled
        .diagnostics
        .iter()
        .filter(|d| d.severity == forgegraph_semantic::Severity::Error)
        .collect();
    assert!(errors.is_empty(), "{errors:?}");
    let plans = forgegraph_planner::plan(&compiled.ir.unwrap()).unwrap();
    let openapi = forgegraph_codegen::openapi(&plans.contracts, &plans.observability);
    contract_ir::emit(
        &openapi,
        &EmitOptions {
            package: pkg.name.clone(),
            service_id: service_id.map(String::from),
        },
    )
    .unwrap()
}

#[test]
fn emitted_contract_is_a_stable_golden() {
    let contract = contract_of(&examples().join("console-playground"), None);
    assert!(verify(&contract).is_empty(), "{:?}", verify(&contract));
    insta::assert_json_snapshot!("console_playground_contract", contract);
}

#[test]
fn ids_policy_and_slo_follow_forgegraph_conventions() {
    let contract = contract_of(&examples().join("studio-desk"), None);
    assert!(verify(&contract).is_empty(), "{:?}", verify(&contract));
    assert_eq!(contract["serviceId"], "service-desk");
    assert_eq!(contract["apiId"], "@demo/service-desk");
    assert_eq!(
        contract["generator"],
        json!({ "name": "forgec", "version": env!("CARGO_PKG_VERSION") })
    );
    let ops = contract["operations"].as_array().unwrap();
    let ids: Vec<&str> = ops.iter().map(|o| o["id"].as_str().unwrap()).collect();
    let mut sorted = ids.clone();
    sorted.sort();
    assert_eq!(ids, sorted, "operations are sorted by id");
    for id in [
        "service-desk.Contact.create",
        "service-desk.Contact.list-byOrganization",
        "service-desk.Ticket.status-assign",
        "service-desk.EscalationFollowUp.start",
        "service-desk.functions.EscalateTicket",
    ] {
        assert!(ids.contains(&id), "{id} in {ids:?}");
    }
    let assign = ops
        .iter()
        .find(|o| o["endpointId"] == "status-assign")
        .unwrap();
    assert_eq!(
        assign["transport"],
        json!({ "type": "http", "method": "POST", "path": "/v1/tickets/:id/actions/assign", "openApiPath": "/v1/tickets/{id}/actions/assign" })
    );
    // Every route sits behind the runtime's bearer AuthHost: ForgeGraph's classification says `service`.
    assert_eq!(
        assign["policy"]["authentication"],
        json!({ "mode": "service", "derived": "service", "mismatch": false, "schemes": ["bearer"] })
    );
    assert_eq!(assign["policy"]["isPublic"], false);
    assert_eq!(
        assign["policy"]["sla"],
        json!({ "policy": {}, "provenance": {} })
    );
    // The §20 starter objectives, exactly the doubles ForgeGraph's fixture uses.
    assert_eq!(
        assign["policy"]["slo"],
        json!({ "availability": 0.999, "latency": { "good": 0.99, "withinMs": 1000 }, "windowDays": 28 })
    );
    let get = ops
        .iter()
        .find(|o| o["id"] == "service-desk.Contact.get")
        .unwrap();
    assert_eq!(get["policy"]["slo"]["latency"]["withinMs"], 500);
    assert_eq!(
        get["request"]["params"]["jsonSchema"]["required"],
        json!(["id"])
    );
    assert_eq!(
        get["successes"][0]["bodies"][0]["schema"]["id"],
        "ContactRecord"
    );
    let statuses: Vec<u64> = get["errors"]
        .as_array()
        .unwrap()
        .iter()
        .map(|e| e["status"].as_u64().unwrap())
        .collect();
    assert_eq!(statuses, [401, 403, 404]);
    // The app slug can be supplied, and must be an identifier.
    let slugged = contract_of(&examples().join("studio-desk"), Some("desk"));
    assert!(
        slugged["operations"][0]["id"]
            .as_str()
            .unwrap()
            .starts_with("desk.")
    );
    let err = contract_ir::emit(
        &json!({}),
        &EmitOptions {
            package: "@a/b".into(),
            service_id: Some("9x".into()),
        },
    );
    assert!(err.unwrap_err().contains("not an identifier"));
}

#[test]
fn fingerprints_cover_content_and_verify_detects_tampering() {
    let contract = contract_of(&examples().join("studio-desk"), None);
    let mut tampered = contract.clone();
    tampered["operations"][0]["transport"]["path"] = json!("/elsewhere");
    let issues = verify(&tampered);
    assert!(
        issues
            .iter()
            .any(|i| i == "operations.0: fingerprint does not match content"),
        "{issues:?}"
    );
    // The contract fingerprint covers operations only through their fingerprints.
    tampered["operations"][0]["fingerprint"] =
        json!(fingerprint_operation(&tampered["operations"][0]));
    let issues = verify(&tampered);
    assert_eq!(issues, ["fingerprint does not match content"]);
    tampered["fingerprint"] = json!(fingerprint_contract(&tampered));
    assert!(verify(&tampered).is_empty());
    // `generator` is outside the fingerprint, as in ForgeGraph.
    let mut regenerated = contract.clone();
    regenerated["generator"]["version"] = json!("9.9.9");
    assert!(verify(&regenerated).is_empty());
}
