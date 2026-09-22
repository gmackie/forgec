use forgegraph_semantic::{Package, compile, load_package};
use std::path::Path;
#[test]
fn credentials_are_write_only_in_contracts() {
    let ir = compile(
        &load_package(Path::new(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../examples/credentials"
        )))
        .unwrap(),
        &[],
    )
    .ir
    .unwrap();
    assert!(ir.requires.contains(&"credentials/1".into()));
    let plans = forgegraph_planner::plan(&ir).unwrap();
    let json = serde_json::to_value(plans.contracts).unwrap();
    let r = json["resources"]
        .as_array()
        .unwrap()
        .iter()
        .find(|r| r["name"] == "Integration")
        .unwrap();
    assert!(r["record"]["properties"]["accessToken"].is_null());
    assert_eq!(
        r["record"]["properties"]["accessTokenPresent"]["type"],
        "boolean"
    );
    assert_eq!(r["create"]["properties"]["accessToken"]["writeOnly"], true);
    assert_eq!(r["patch"]["properties"]["accessToken"]["writeOnly"], true);
}
#[test]
fn secret_index_or_derived_value_is_not_planned() {
    for extra in ["unique token", "derived leaked = token"] {
        let c = compile(
            &Package::inline(
                "@test/secrets",
                vec![(
                    "src/a.forge".into(),
                    format!("resource R @versioned {{id : id\n token : text @secret\n {extra}\n}}"),
                )],
            ),
            &[],
        );
        if let Some(ir) = c.ir {
            assert!(forgegraph_planner::plan(&ir).is_err());
        }
    }
}
