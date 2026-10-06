//! Contract IR v1 (ForgeGraph's registry format): `forgec build` emits it
//! from the OpenAPI projection with ForgeGraph's ids, policy and canonical
//! fingerprints; `import-contract` turns one into a Forge package and reports
//! what Forge cannot express; `contract-diff` compares two. A forgec contract
//! re-imported and rebuilt keeps every route and is stable from the second
//! generation on. (ForgeGraph's own validator runs over the emitted contracts
//! in conformance/test/contract-ir.test.ts.)
use forgegraph_codegen::contract_ir::{self, EmitOptions, emit::*};
use forgegraph_codegen::openapi_import::{ImportOptions, ImportOutput};
use serde_json::{Value, json};
use std::collections::BTreeSet;
use std::path::Path;

fn examples() -> &'static Path {
    Path::new(concat!(env!("CARGO_MANIFEST_DIR"), "/../../examples"))
}

fn fixture() -> String {
    std::fs::read_to_string(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/tests/fixtures/contract-import/users-api.json"
    ))
    .unwrap()
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

fn write(out: &ImportOutput) -> tempfile::TempDir {
    let dir = tempfile::tempdir().unwrap();
    for (path, text) in &out.files {
        let p = dir.path().join(path);
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        std::fs::write(p, text).unwrap();
    }
    dir
}

fn import(contract: &Value, package: &str) -> ImportOutput {
    contract_ir::import_contract(
        &contract.to_string(),
        &ImportOptions {
            package: package.into(),
            ..Default::default()
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

#[test]
fn import_contract_reports_what_forge_cannot_express() {
    let out = contract_ir::import_contract(
        &fixture(),
        &ImportOptions {
            package: "@acme/users".into(),
            ..Default::default()
        },
    )
    .unwrap();
    let report = &out.report;
    assert_eq!(report.version, "contract-import/1");
    let features: BTreeSet<&str> = report
        .unsupported
        .iter()
        .map(|u| u.feature.as_str())
        .collect();
    for f in [
        "rpc-transport",
        "http-method",
        "anonymous-operation",
        "public-visibility",
        "declared-authentication",
        "sla-policy",
        "slo",
        "middleware",
        "alternate-media",
        "additional-success-response",
        "error-body",
        "server-error-response",
        "header-parameter",
    ] {
        assert!(features.contains(f), "{f} not reported: {features:?}");
    }
    assert_eq!(
        report.skipped_operations,
        ["users.jobs.run", "users.users.headUser"]
    );
    // Operations keep their contract ids in the report.
    let ids: Vec<&str> = report
        .operations
        .iter()
        .map(|o| o.operation_id.as_str())
        .collect();
    assert_eq!(
        ids,
        [
            "users.users.getUser",
            "users.users.createUser",
            "users.users.listUsers",
            "users.health.check"
        ]
    );
    let src = &out.files["src/index.forge"];
    assert!(src.contains("by `forgec import-contract`"), "{src}");
    // A component name OpenAPI cannot key (`Api Error`) is renamed, refs follow.
    assert!(src.contains("export shape ApiError {"), "{src}");
    assert!(out.files["openapi.json"].contains("#/components/schemas/Api_Error"));
    // 422 is served by the runtime itself, so it is not a declared domain error.
    assert!(!src.contains("UnprocessableContent"), "{src}");
    let dir = write(&out);
    let compiled =
        forgegraph_semantic::compile(&forgegraph_semantic::load_package(dir.path()).unwrap(), &[]);
    assert!(
        compiled
            .diagnostics
            .iter()
            .all(|d| d.severity != forgegraph_semantic::Severity::Error),
        "{:?}",
        compiled.diagnostics
    );
    insta::assert_snapshot!("users_api_index", src);
    insta::assert_snapshot!("users_api_report", out.files["import-report.json"]);
}

#[test]
fn import_refuses_a_contract_that_does_not_validate() {
    let mut contract: Value = serde_json::from_str(&fixture()).unwrap();
    contract["operations"][0]["transport"]["openApiPath"] = json!("/people/{id}");
    let err = contract_ir::import_contract(
        &contract.to_string(),
        &ImportOptions {
            package: "@acme/users".into(),
            ..Default::default()
        },
    )
    .unwrap_err();
    assert!(err.contains("not a valid contract IR v1 document"), "{err}");
    assert!(err.contains("fingerprint does not match content"), "{err}");
}

/// Differences a forgec contract re-imported as functions is expected to show:
/// operation ids (CRUD and workflow routes become functions), the function
/// transport profile (Idempotency-Key, JSON input bodies, 200 + 409/412/422
/// statuses, the `function` SLO class) and JSON Schema re-derived from Forge
/// types (no `readOnly`/`default`, `x-forge-type` per Forge scalar).
const EXPECTED_ROUND_TRIP: [&str; 8] = [
    "id",
    "request.headers",
    "request.query",
    "request.bodies",
    "successes",
    "errors",
    "response",
    "policy.slo",
];

#[test]
fn round_trip_keeps_every_route_and_reaches_a_fixed_point() {
    let a0 = contract_of(&examples().join("studio-desk"), None);
    let s1 = write(&import(&a0, "@demo/service-desk"));
    let a1 = contract_of(s1.path(), None);
    let ignore: Vec<String> = EXPECTED_ROUND_TRIP.iter().map(|s| s.to_string()).collect();
    let first = contract_ir::diff(&a0, &a1, &ignore);
    assert!(
        first.is_clean(),
        "{:#?}",
        first
            .differences
            .iter()
            .filter(|d| !d.ignored)
            .collect::<Vec<_>>()
    );
    // No route is lost or invented and identity-free policy survives.
    for regression in [
        "added",
        "removed",
        "transport.path",
        "policy.authentication",
        "policy.isPublic",
        "middleware",
    ] {
        assert!(
            !first.kinds().contains(regression),
            "{regression}: {:?}",
            first.kinds()
        );
    }
    // The handwritten function keeps its id; resource routes become functions.
    let id_changes: Vec<&str> = first
        .differences
        .iter()
        .filter(|d| d.kind == "id")
        .map(|d| d.detail.as_str())
        .collect();
    assert!(
        id_changes
            .contains(&"service-desk.Contact.create → service-desk.functions.ContactCreateOp"),
        "{id_changes:?}"
    );
    assert!(
        !id_changes.iter().any(|d| d.contains("EscalateTicket")),
        "{id_changes:?}"
    );

    let s2 = write(&import(&a1, "@demo/service-desk"));
    let a2 = contract_of(s2.path(), None);
    let second = contract_ir::diff(&a1, &a2, &[]);
    assert!(second.differences.is_empty(), "{:#?}", second.differences);
    assert_eq!(second.equal, a1["operations"].as_array().unwrap().len());
}

#[test]
fn diff_compares_shapes_not_names() {
    let a: Value = serde_json::from_str(&fixture()).unwrap();
    assert!(contract_ir::diff(&a, &a, &[]).differences.is_empty());
    // Renaming a component (and its refs) is not a difference.
    let renamed: Value = serde_json::from_str(
        &fixture()
            .replace("\"User\"", "\"Person\"")
            .replace("schemas/User", "schemas/Person"),
    )
    .unwrap();
    let report = contract_ir::diff(&a, &renamed, &[]);
    assert!(report.differences.is_empty(), "{:#?}", report.differences);
    // Changing a referenced component is, at every route that reaches it.
    let mut changed = a.clone();
    changed["components"]["Role"]["enum"] = json!(["admin", "member", "guest"]);
    let report = contract_ir::diff(&a, &changed, &[]);
    let at: Vec<(&str, &str)> = report
        .differences
        .iter()
        .map(|d| (d.kind.as_str(), d.at.as_str()))
        .collect();
    assert!(at.contains(&("response.200", "GET /users/{}")), "{at:?}");
    assert!(at.contains(&("request.bodies", "POST /users")), "{at:?}");
    assert!(!report.is_clean());
    // Expected kinds are listed but do not block; prefixes match dotted kinds.
    let report = contract_ir::diff(&a, &changed, &["response".into(), "request".into()]);
    assert!(report.is_clean(), "{:#?}", report.differences);
    // A route only one side has is added/removed; a renamed path parameter is still the same route.
    let mut moved = a.clone();
    moved["operations"][0]["transport"]["openApiPath"] = json!("/users/{userId}");
    moved["operations"][4]["transport"]["openApiPath"] = json!("/healthz");
    let kinds = contract_ir::diff(&a, &moved, &[]).kinds();
    assert_eq!(
        kinds,
        ["added", "removed", "transport.path"]
            .map(String::from)
            .into_iter()
            .collect()
    );
}
