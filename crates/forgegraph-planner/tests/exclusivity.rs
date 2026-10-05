use forgegraph_semantic::{compile, load_package};
use std::path::Path;
#[test]
fn deployment_lane_has_partial_indexes_and_conditional_dynamo_claims() {
    let path = Path::new(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../examples/deployment-lanes"
    ));
    let c = compile(&load_package(path).unwrap(), &[]);
    assert!(c.ir.is_some(), "{}", c.render());
    let p = forgegraph_planner::plan(&c.ir.unwrap()).unwrap();
    let sql = forgegraph_planner::sql::render_sqlite(&p.sql);
    assert!(
        sql.contains("WHERE \"status\" IN ('Deploying', 'HealthChecking', 'Pending')"),
        "{sql}"
    );
    let pg = forgegraph_planner::sql::render_postgres(&p.sql);
    assert!(pg.contains("WHERE \"status\" IN ('Deploying', 'HealthChecking', 'Pending')"));
    assert_eq!(
        p.dynamo.resources[0].claims[0]
            .condition
            .as_ref()
            .unwrap()
            .field,
        "status"
    );
}
