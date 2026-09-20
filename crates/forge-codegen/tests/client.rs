use forge_codegen::client_ts;
use forge_planner::plan;
use forge_semantic::{compile, load_package};
use std::path::Path;

#[test]
fn generated_client_is_typed_per_resource_and_snapshot_stable() {
    let ex = Path::new(concat!(env!("CARGO_MANIFEST_DIR"), "/../../examples"));
    let pay = compile(&load_package(&ex.join("payments")).unwrap(), &[]).ir.unwrap();
    let ir = compile(&load_package(&ex.join("acme")).unwrap(), &[&pay]).ir.unwrap();
    let plans = plan(&ir).unwrap();
    let ts = client_ts(&plans.contracts);
    assert!(ts.contains("export interface CustomerRecord {"));
    assert!(ts.contains("tier: \"standard\" | \"gold\" | \"enterprise\";"));
    assert!(ts.contains("email?: string | null;"));
    assert!(ts.contains("listByTier(params: { tier: "));
    assert!(ts.contains("cancel(id: string, expectedVersion: number, input: OrderCancelInput"));
    assert!(!ts.contains("submit(id: string"), "submit is owned by the SubmitOrder function and must not be exposed by @crud");
    assert!(ts.contains("\"@acme/commerce/_/Customer.find.byCode\""));
    insta::assert_snapshot!(ts);
}
