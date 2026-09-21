use forge_codegen::client_ts;
use forge_planner::plan;
use forge_semantic::{compile, load_package};
use std::path::Path;

fn acme() -> forge_planner::Plans {
    let ex = Path::new(concat!(env!("CARGO_MANIFEST_DIR"), "/../../examples"));
    let pay = compile(&load_package(&ex.join("payments")).unwrap(), &[])
        .ir
        .unwrap();
    let ir = compile(&load_package(&ex.join("acme")).unwrap(), &[&pay])
        .ir
        .unwrap();
    plan(&ir).unwrap()
}

#[test]
fn generated_client_is_typed_per_resource_and_snapshot_stable() {
    let ex = Path::new(concat!(env!("CARGO_MANIFEST_DIR"), "/../../examples"));
    let pay = compile(&load_package(&ex.join("payments")).unwrap(), &[])
        .ir
        .unwrap();
    let ir = compile(&load_package(&ex.join("acme")).unwrap(), &[&pay])
        .ir
        .unwrap();
    let plans = plan(&ir).unwrap();
    let ts = client_ts(&plans.contracts);
    assert!(ts.contains("export interface CustomerRecord {"));
    assert!(ts.contains("tier: \"standard\" | \"gold\" | \"enterprise\";"));
    assert!(ts.contains("email?: string | null;"));
    assert!(ts.contains("listByTier(params: { tier: "));
    assert!(ts.contains("cancel(id: string, expectedVersion: number, input: OrderCancelInput"));
    assert!(
        !ts.contains("submit(id: string"),
        "submit is owned by the SubmitOrder function and must not be exposed by @crud"
    );
    assert!(ts.contains("\"@acme/commerce/_/Customer.find.byCode\""));
    insta::assert_snapshot!(ts);
}

/// FORGE-056: the OpenAPI document is a projection of the same contracts the client and runtime use.
#[test]
fn openapi_export_projects_the_contracts() {
    let plans = acme();
    let doc = forge_codegen::openapi(&plans.contracts, &plans.observability);
    assert_eq!(doc["openapi"], "3.1.0");
    assert_eq!(doc["info"]["title"], "@acme/commerce");
    let paths = doc["paths"].as_object().unwrap();
    assert!(
        paths.contains_key("/v1/customers")
            && paths.contains_key("/v1/customers/{id}")
            && paths.contains_key("/v1/orders/{order}/submit")
    );
    let patch = &paths["/v1/customers/{id}"]["patch"];
    assert_eq!(patch["operationId"], "@acme/commerce/_/Customer.update");
    assert!(
        patch["parameters"]
            .as_array()
            .unwrap()
            .iter()
            .any(|p| p["name"] == "If-Match" && p["required"] == true)
    );
    assert_eq!(
        patch["responses"]["412"]["content"]["application/problem+json"]["schema"]["$ref"],
        "#/components/schemas/Problem"
    );
    assert_eq!(
        patch["responses"]["428"]["description"],
        "Precondition required (If-Match)"
    );
    let create = &paths["/v1/customers"]["post"];
    assert!(
        create["parameters"]
            .as_array()
            .unwrap()
            .iter()
            .any(|p| p["name"] == "Idempotency-Key")
    );
    assert_eq!(
        create["responses"]["201"]["content"]["application/json"]["schema"]["$ref"],
        "#/components/schemas/CustomerRecord"
    );
    assert_eq!(
        create["responses"]["201"]["headers"]["ETag"]["schema"]["type"],
        "string"
    );
    let schemas = doc["components"]["schemas"].as_object().unwrap();
    assert_eq!(
        schemas["CustomerRecord"]["properties"]["tier"]["x-forge-enum"],
        "@acme/commerce/_/CustomerTier"
    );
    assert_eq!(
        schemas["Problem"]["required"],
        serde_json::json!(["type", "title", "status", "code"])
    );
    // errors declared by functions are enumerated per operation
    let submit = &paths["/v1/orders/{order}/submit"]["post"];
    assert!(
        submit["responses"]["409"]["description"]
            .as_str()
            .unwrap()
            .contains("PaymentDeclined")
    );
    // SLO descriptors travel as vendor extensions, not promises
    assert_eq!(submit["x-forge-slo"]["latencyWithinMs"], 1000);
    // purpose selection is a documented header on every operation
    assert!(
        create["parameters"]
            .as_array()
            .unwrap()
            .iter()
            .any(|p| p["name"] == "X-Forge-Purpose")
    );
    insta::assert_json_snapshot!("openapi", doc);
}

/// Smithy IDL export for toolchains that consume it (PAR-123 groundwork).
#[test]
fn smithy_export_is_stable() {
    let plans = acme();
    let idl = forge_codegen::smithy(&plans.contracts);
    assert!(idl.starts_with("$version: \"2.0\""));
    assert!(idl.contains("structure CustomerRecord {"));
    assert!(idl.contains("operation CustomerCreate {"));
    insta::assert_snapshot!("smithy", idl);
}
