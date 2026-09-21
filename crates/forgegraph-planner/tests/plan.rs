use forgegraph_planner::{Plans, plan};
use forgegraph_semantic::{compile, load_package};
use std::path::Path;

fn acme() -> Plans {
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
fn contracts_are_target_independent_and_snapshot_stable() {
    let p = acme();
    insta::assert_json_snapshot!("contracts", p.contracts);
}

#[test]
fn contract_record_schema_exposes_every_field_and_write_schemas_exclude_server_owned_fields() {
    let p = acme();
    let c = p
        .contracts
        .resources
        .iter()
        .find(|r| r.name == "Customer")
        .unwrap();
    let rec: Vec<&str> = c.record.properties.keys().map(|k| k.as_str()).collect();
    assert_eq!(
        rec,
        vec![
            "id",
            "version",
            "createdAt",
            "updatedAt",
            "deletedAt",
            "code",
            "name",
            "email",
            "tier"
        ]
    );
    assert_eq!(
        c.record.required,
        vec![
            "id",
            "version",
            "createdAt",
            "updatedAt",
            "deletedAt",
            "code",
            "name",
            "email",
            "tier"
        ]
    );
    let create: Vec<&str> = c.create.properties.keys().map(|k| k.as_str()).collect();
    assert_eq!(create, vec!["code", "name", "email", "tier"]);
    assert_eq!(c.create.required, vec!["code", "name"]); // email optional, tier has a default
    let patch: Vec<&str> = c.patch.properties.keys().map(|k| k.as_str()).collect();
    assert_eq!(patch, vec!["name", "email", "tier"]); // code is @immutable
    assert!(c.patch.required.is_empty());
    let ops: Vec<(&str, &str, &str)> = c
        .operations
        .iter()
        .filter_map(|o| {
            o.http
                .as_ref()
                .map(|h| (o.kind.as_str(), h.method.as_str(), h.path.as_str()))
        })
        .collect();
    assert!(ops.contains(&("find", "GET", "/v1/customers/queries/by-code")));
    assert!(ops.contains(&("restore", "POST", "/v1/customers/{id}/restore")));
}

#[test]
fn sql_schema_has_tenant_scoped_keys_composite_foreign_keys_and_indexes_per_query() {
    let p = acme();
    let ddl = forgegraph_planner::sql::render_sqlite(&p.sql);
    insta::assert_snapshot!("d1_schema", ddl);
    assert!(ddl.contains("PRIMARY KEY (tenant, id)"));
    assert!(ddl.contains("FOREIGN KEY (tenant, customer) REFERENCES customer (tenant, id)"));
    assert!(ddl.contains(
        "CREATE UNIQUE INDEX site_uq_code_within_customer ON site (tenant, customer, code)"
    ));
    assert!(ddl.contains("CREATE INDEX customer_ix_by_tier ON customer (tenant, tier, name, id)"));
    assert!(ddl.contains("CONSTRAINT forge_precondition CHECK (satisfied = 1)"));
    // money is stored as minor units; booleans as integers; timestamps as canonical text
    let site = p.sql.tables.iter().find(|t| t.name == "site").unwrap();
    assert_eq!(
        site.columns
            .iter()
            .find(|c| c.name == "enabled")
            .unwrap()
            .sql_type,
        "INTEGER"
    );
    let order = p.sql.tables.iter().find(|t| t.name == "order_").unwrap(); // `order` is reserved
    assert_eq!(
        order
            .columns
            .iter()
            .find(|c| c.name == "subtotal")
            .unwrap()
            .sql_type,
        "INTEGER"
    );
    assert!(
        !order.columns.iter().any(|c| c.name == "total"),
        "derived fields are not stored"
    );
}

#[test]
fn dynamo_plan_has_entity_claim_and_access_families_per_resource() {
    let p = acme();
    insta::assert_json_snapshot!("dynamo_plan", p.dynamo);
    let site = p
        .dynamo
        .resources
        .iter()
        .find(|r| r.name == "Site")
        .unwrap();
    assert_eq!(
        site.claims
            .iter()
            .map(|c| c.name.as_str())
            .collect::<Vec<_>>(),
        vec!["code_within_customer"]
    );
    assert_eq!(site.claims[0].key_fields, vec!["customer", "code"]);
    let by_customer = site.access.iter().find(|a| a.name == "byCustomer").unwrap();
    assert_eq!(by_customer.partition_fields, vec!["customer"]);
    assert_eq!(by_customer.sort_fields, vec!["name", "id"]);
    assert_eq!(
        by_customer.projection,
        vec!["id", "version", "customer", "name"]
    );
}

#[test]
fn tie_breaker_follows_the_declared_direction_and_mixed_directions_are_rejected() {
    use forgegraph_semantic::Package;
    let p = acme();
    let order = p
        .contracts
        .resources
        .iter()
        .find(|r| r.name == "Order")
        .unwrap();
    let by_customer = order
        .queries
        .iter()
        .find(|q| q.name == "byCustomer")
        .unwrap();
    assert_eq!(
        by_customer
            .order
            .iter()
            .map(|o| (o.field.as_str(), o.direction.as_str()))
            .collect::<Vec<_>>(),
        vec![("createdAt", "desc"), ("id", "desc")]
    );
    let mixed = Package::inline("@t/x", vec![("src/a.forge".into(), "resource R {\n  id : id\n  a : text\n  b : integer\n  list by a\n    order by b desc, a asc\n}\n".into())]);
    let ir = compile(&mixed, &[]).ir.unwrap();
    assert_eq!(plan(&ir).unwrap_err().code, "E-PLAN-002");
}

#[test]
fn plans_reject_unbounded_or_uncovered_queries_rather_than_emitting_scans() {
    use forgegraph_semantic::Package;
    let p = Package::inline(
        "@t/x",
        vec![(
            "src/a.forge".into(),
            "resource R {\n  id : id\n  notes : text? length <= 2000\n  list by notes\n}\n".into(),
        )],
    );
    let ir = compile(&p, &[]).ir.unwrap();
    let err = plan(&ir).unwrap_err();
    assert_eq!(err.code, "E-PLAN-001");
    assert!(err.message.contains("optional field `notes`"));
}

#[test]
fn ui_descriptor_drives_tables_forms_relationships_and_actions() {
    let p = acme();
    insta::assert_json_snapshot!("ui", p.ui);
    let cust =
        p.ui.resources
            .iter()
            .find(|r| r.name == "Customer")
            .unwrap();
    assert_eq!(cust.route, "customers");
    assert_eq!(cust.label, "Customer");
    assert_eq!(cust.title_field, "name");
    let code = cust.fields.iter().find(|f| f.name == "code").unwrap();
    assert_eq!(
        (
            code.editable_on_create,
            code.editable_on_update,
            code.widget.as_str()
        ),
        (true, false, "text")
    );
    let tier = cust.fields.iter().find(|f| f.name == "tier").unwrap();
    assert_eq!(tier.widget, "select");
    assert_eq!(
        tier.options
            .as_ref()
            .unwrap()
            .iter()
            .map(|o| o.value.as_str())
            .collect::<Vec<_>>(),
        vec!["standard", "gold", "enterprise"]
    );
    let version = cust.fields.iter().find(|f| f.name == "version").unwrap();
    assert!(
        !version.editable_on_create && !version.editable_on_update && version.widget == "readonly"
    );
    let site = p.ui.resources.iter().find(|r| r.name == "Site").unwrap();
    let customer = site.fields.iter().find(|f| f.name == "customer").unwrap();
    assert_eq!(customer.widget, "reference");
    assert_eq!(
        customer.reference.as_ref().unwrap().resource,
        "@acme/commerce/_/Customer"
    );
    assert_eq!(
        customer.reference.as_ref().unwrap().lookup,
        "@acme/commerce/_/Customer.list.all"
    );
    let order = p.ui.resources.iter().find(|r| r.name == "Order").unwrap();
    assert_eq!(
        order
            .actions
            .iter()
            .map(|a| a.name.as_str())
            .collect::<Vec<_>>(),
        vec!["approve", "complete", "cancel"]
    );
    assert_eq!(
        order.actions[2]
            .input_fields
            .iter()
            .map(|f| f.name.as_str())
            .collect::<Vec<_>>(),
        vec!["reason"]
    );
    let status = order.fields.iter().find(|f| f.name == "status").unwrap();
    assert_eq!(status.widget, "status");
    assert_eq!(
        order
            .lists
            .iter()
            .map(|l| l.name.as_str())
            .collect::<Vec<_>>(),
        vec!["all", "byCustomer", "bySiteStatus"]
    );
    let doc =
        p.ui.resources
            .iter()
            .find(|r| r.name == "OrderDocument")
            .unwrap();
    assert_eq!(doc.kind, "blob");
    assert!(!doc.fields.iter().any(|f| f.name == "stagedByteCount"));
}

#[test]
fn messaging_plan_has_one_durable_delivery_per_subscription_and_typed_envelopes() {
    let p = acme();
    insta::assert_json_snapshot!("messaging", p.messaging);
    let m = &p.messaging;
    // implicit change channels for audited resources + declared channels
    let channels: Vec<&str> = m.channels.iter().map(|c| c.id.as_str()).collect();
    assert!(channels.contains(&"@acme/commerce/_/OrderEvents"));
    assert!(channels.contains(&"@acme/commerce/_/Customer.changes"));
    let oe = m
        .channels
        .iter()
        .find(|c| c.id == "@acme/commerce/_/OrderEvents")
        .unwrap();
    assert_eq!(oe.distribution, "broadcast");
    assert_eq!(
        oe.messages
            .iter()
            .map(|x| x.name.as_str())
            .collect::<Vec<_>>(),
        vec!["OrderSubmitted"]
    );
    // `on OrderEvents.OrderSubmitted -> FulfillOrder` becomes one logical subscription with its own queue
    let sub = m
        .subscriptions
        .iter()
        .find(|s| s.handler == "@acme/commerce/_/FulfillOrder")
        .unwrap();
    assert_eq!(sub.channel, "@acme/commerce/_/OrderEvents");
    assert_eq!(sub.message, "OrderSubmitted");
    assert_eq!(sub.name, "fulfill-order");
    assert_eq!(sub.queue, "forge-acme-commerce-fulfill-order");
    // functions declare what they may send; the runtime refuses anything else
    let f = m
        .senders
        .iter()
        .find(|s| s.function == "@acme/commerce/_/SubmitOrder")
        .unwrap();
    assert_eq!(
        f.sends,
        vec![(
            "@acme/commerce/_/OrderEvents".to_string(),
            "OrderSubmitted".to_string()
        )]
    );
    // imported recv-only channel: a subscription may consume it, never publish
    let pe = m
        .channels
        .iter()
        .find(|c| c.id == "@acme/commerce/_/PaymentEvents")
        .unwrap();
    assert_eq!(
        pe.contract.as_deref(),
        Some("@acme/payments/_/PaymentEvents")
    );
    assert_eq!(pe.direction.as_deref(), Some("recv-only"));
}

/// FORGE-033: the PostgreSQL dialect renders the same relational plan with portable collation and exact numerics.
#[test]
fn postgres_dialect_preserves_portable_semantics() {
    let plans = acme();
    let pg = forgegraph_planner::sql::render_postgres(&plans.sql);
    assert!(
        pg.contains("\"code\" TEXT COLLATE \"C\" NOT NULL"),
        "text columns sort by byte order like D1/DynamoDB:\n{pg}"
    );
    assert!(
        pg.contains("\"subtotal\" BIGINT NOT NULL"),
        "money is exact minor units in a 64-bit integer"
    );
    assert!(
        pg.contains("CONSTRAINT forge_precondition CHECK (satisfied)"),
        "the guarded-batch assertion row is a boolean check"
    );
    assert!(
        pg.contains("CREATE TABLE forge_document")
            && pg.contains("CREATE TABLE forge_processed")
            && pg.contains("\"trace\" TEXT"),
        "the PostgreSQL baseline is the complete current schema"
    );
    assert!(!pg.contains("PRAGMA"));
    insta::assert_snapshot!("postgres", pg);
}
