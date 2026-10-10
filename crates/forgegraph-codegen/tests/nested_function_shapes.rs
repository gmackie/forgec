use forgegraph_codegen::contract_ir::{EmitOptions, emit};
use forgegraph_semantic::{Package, compile};

#[test]
fn recursive_shapes_fail_before_inline_emission() {
    let pkg = Package::inline("@test/recursive", vec![("src/api.forge".into(), "shape Node { next : Node? }\nexport function Read @http(POST, \"/read\") {\n input Node\n output Node\n}\n".into())]);
    let compiled = compile(&pkg, &[]);
    let error = forgegraph_planner::plan(&compiled.ir.unwrap()).unwrap_err();
    assert_eq!(error.code, "E-PLAN-SHAPE-001");
}

#[test]
fn nested_function_shapes_emit_resolvable_contracts_and_typed_clients() {
    let pkg = Package::inline(
        "@test/nested",
        vec![(
            "src/api.forge".into(),
            r#"
shape Repository { repositoryId : text length 1..128 }
shape Target { environmentId : text length 1..128
 repository : Repository
}
shape Request { target : Target
 targets : list<Target> length <= 8
 origin : Target?
}
shape Result { target : Target }
export function Submit @http(POST, "/v1/submit") {
 input Request
 output Result
}
"#
            .into(),
        )],
    );
    let compiled = compile(&pkg, &[]);
    assert!(compiled.ir.is_some(), "{}", compiled.render());
    let plans = forgegraph_planner::plan(&compiled.ir.unwrap()).unwrap();
    let openapi = forgegraph_codegen::openapi(&plans.contracts, &plans.observability);
    let input = &openapi["paths"]["/v1/submit"]["post"]["requestBody"]["content"]["application/json"]
        ["schema"];
    assert_eq!(
        input["properties"]["target"]["properties"]["repository"]["properties"]["repositoryId"]["minLength"],
        1
    );
    assert_eq!(input["properties"]["target"]["additionalProperties"], false);
    assert_eq!(
        input["properties"]["targets"]["items"]["properties"]["repository"]["additionalProperties"],
        false
    );
    assert_eq!(
        input["properties"]["origin"]["type"],
        serde_json::json!(["object", "null"])
    );
    let contract = emit(
        &openapi,
        &EmitOptions {
            package: pkg.name.clone(),
            service_id: Some("nested".into()),
        },
    )
    .unwrap();
    assert!(emit::verify(&contract).is_empty());
    let client = forgegraph_codegen::client_ts(&plans.contracts);
    assert!(
        client.contains("submit(input: SubmitInput, opts?: CallOptions): Promise<SubmitOutput>")
    );
    assert!(client.contains("export interface SubmitInput"));
    assert!(client.contains("export type SubmitOutput = {"));
    assert!(client.contains("\"repositoryId\": string"));
    assert!(!client.contains("target: unknown"));
}
