use forge_planner::{plan, Plans};
use forge_semantic::{compile, load_package};
use std::path::Path;

fn acme() -> Plans {
    let ex = Path::new(concat!(env!("CARGO_MANIFEST_DIR"), "/../../examples"));
    let pay = compile(&load_package(&ex.join("payments")).unwrap(), &[]).ir.unwrap();
    let ir = compile(&load_package(&ex.join("acme")).unwrap(), &[&pay]).ir.unwrap();
    plan(&ir).unwrap()
}

#[test]
fn contracts_are_target_independent_and_snapshot_stable() {
    let p = acme();
    insta::assert_json_snapshot!("contracts", p.contracts);
}

#[test]
fn contract_record_schema_exposes_every_field_and_write_schemas_exclude_server_owned_fields() {
    let p = acme();
    let c = p.contracts.resources.iter().find(|r| r.name == "Customer").unwrap();
    let rec: Vec<&str> = c.record.properties.keys().map(|k| k.as_str()).collect();
    assert_eq!(rec, vec!["id", "version", "createdAt", "updatedAt", "deletedAt", "code", "name", "email", "tier"]);
    assert_eq!(c.record.required, vec!["id", "version", "createdAt", "updatedAt", "deletedAt", "code", "name", "email", "tier"]);
    let create: Vec<&str> = c.create.properties.keys().map(|k| k.as_str()).collect();
    assert_eq!(create, vec!["code", "name", "email", "tier"]);
    assert_eq!(c.create.required, vec!["code", "name"]); // email optional, tier has a default
    let patch: Vec<&str> = c.patch.properties.keys().map(|k| k.as_str()).collect();
    assert_eq!(patch, vec!["name", "email", "tier"]); // code is @immutable
    assert!(c.patch.required.is_empty());
    let ops: Vec<(&str, &str, &str)> = c.operations.iter().filter_map(|o| o.http.as_ref().map(|h| (o.kind.as_str(), h.method.as_str(), h.path.as_str()))).collect();
    assert!(ops.contains(&("find", "GET", "/v1/customers/queries/by-code")));
    assert!(ops.contains(&("restore", "POST", "/v1/customers/{id}/restore")));
}

#[test]
fn sql_schema_has_tenant_scoped_keys_composite_foreign_keys_and_indexes_per_query() {
    let p = acme();
    let ddl = forge_planner::sql::render_sqlite(&p.sql);
    insta::assert_snapshot!("d1_schema", ddl);
    assert!(ddl.contains("PRIMARY KEY (tenant, id)"));
    assert!(ddl.contains("FOREIGN KEY (tenant, customer) REFERENCES customer (tenant, id)"));
    assert!(ddl.contains("CREATE UNIQUE INDEX site_uq_code_within_customer ON site (tenant, customer, code)"));
    assert!(ddl.contains("CREATE INDEX customer_ix_by_tier ON customer (tenant, tier, name, id)"));
    assert!(ddl.contains("CONSTRAINT forge_precondition CHECK (satisfied = 1)"));
    // money is stored as minor units; booleans as integers; timestamps as canonical text
    let site = p.sql.tables.iter().find(|t| t.name == "site").unwrap();
    assert_eq!(site.columns.iter().find(|c| c.name == "enabled").unwrap().sql_type, "INTEGER");
    let order = p.sql.tables.iter().find(|t| t.name == "order_").unwrap(); // `order` is reserved
    assert_eq!(order.columns.iter().find(|c| c.name == "subtotal").unwrap().sql_type, "INTEGER");
    assert!(!order.columns.iter().any(|c| c.name == "total"), "derived fields are not stored");
}

#[test]
fn dynamo_plan_has_entity_claim_and_access_families_per_resource() {
    let p = acme();
    insta::assert_json_snapshot!("dynamo_plan", p.dynamo);
    let site = p.dynamo.resources.iter().find(|r| r.name == "Site").unwrap();
    assert_eq!(site.claims.iter().map(|c| c.name.as_str()).collect::<Vec<_>>(), vec!["code_within_customer"]);
    assert_eq!(site.claims[0].key_fields, vec!["customer", "code"]);
    let by_customer = site.access.iter().find(|a| a.name == "byCustomer").unwrap();
    assert_eq!(by_customer.partition_fields, vec!["customer"]);
    assert_eq!(by_customer.sort_fields, vec!["name", "id"]);
    assert_eq!(by_customer.projection, vec!["id", "version", "customer", "name"]);
}

#[test]
fn tie_breaker_follows_the_declared_direction_and_mixed_directions_are_rejected() {
    use forge_semantic::Package;
    let p = acme();
    let order = p.contracts.resources.iter().find(|r| r.name == "Order").unwrap();
    let by_customer = order.queries.iter().find(|q| q.name == "byCustomer").unwrap();
    assert_eq!(by_customer.order.iter().map(|o| (o.field.as_str(), o.direction.as_str())).collect::<Vec<_>>(), vec![("createdAt", "desc"), ("id", "desc")]);
    let mixed = Package::inline("@t/x", vec![("src/a.forge".into(), "resource R {\n  id : id\n  a : text\n  b : integer\n  list by a\n    order by b desc, a asc\n}\n".into())]);
    let ir = compile(&mixed, &[]).ir.unwrap();
    assert_eq!(plan(&ir).unwrap_err().code, "E-PLAN-002");
}

#[test]
fn plans_reject_unbounded_or_uncovered_queries_rather_than_emitting_scans() {
    use forge_semantic::Package;
    let p = Package::inline("@t/x", vec![("src/a.forge".into(), "resource R {\n  id : id\n  notes : text? length <= 2000\n  list by notes\n}\n".into())]);
    let ir = compile(&p, &[]).ir.unwrap();
    let err = plan(&ir).unwrap_err();
    assert_eq!(err.code, "E-PLAN-001");
    assert!(err.message.contains("optional field `notes`"));
}
