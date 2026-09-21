use forgegraph_syntax::parse;

fn fixture(rel: &str) -> String {
    let p = concat!(env!("CARGO_MANIFEST_DIR"), "/../../examples/");
    std::fs::read_to_string(format!("{p}{rel}")).unwrap()
}

#[test]
fn parses_every_reference_app_file_without_errors() {
    for rel in [
        "acme/src/index.forge",
        "acme/src/shared/types.forge",
        "acme/src/customers/customer.forge",
        "acme/src/sites/site.forge",
        "acme/src/orders/order.forge",
        "acme/src/orders/order-events.forge",
        "acme/src/orders/fulfillment.forge",
        "acme/src/orders/attachments.forge",
        "acme/src/orders/summaries.forge",
        "acme/src/orders/process-order.forge",
        "payments/src/index.forge",
    ] {
        let src = fixture(rel);
        let parsed = parse(&src);
        assert!(parsed.errors().is_empty(), "{rel}: {:?}", parsed.errors());
        assert_eq!(
            parsed.syntax().text().to_string(),
            src,
            "{rel}: tree is not lossless"
        );
    }
}

#[test]
fn tree_snapshot_types() {
    let src = fixture("acme/src/shared/types.forge");
    insta::assert_snapshot!(parse(&src).debug_tree());
}

#[test]
fn tree_snapshot_customer() {
    let src = fixture("acme/src/customers/customer.forge");
    insta::assert_snapshot!(parse(&src).debug_tree());
}

#[test]
fn tree_snapshot_order() {
    let src = fixture("acme/src/orders/order.forge");
    insta::assert_snapshot!(parse(&src).debug_tree());
}

#[test]
fn tree_snapshot_fulfillment_and_events() {
    let a = fixture("acme/src/orders/fulfillment.forge");
    let b = fixture("acme/src/orders/order-events.forge");
    insta::assert_snapshot!(format!(
        "{}\n{}",
        parse(&a).debug_tree(),
        parse(&b).debug_tree()
    ));
}

#[test]
fn tree_snapshot_workflow() {
    let src = fixture("acme/src/orders/process-order.forge");
    insta::assert_snapshot!(parse(&src).debug_tree());
}

#[test]
fn workflow_step_errors_recover_per_item() {
    let src = "workflow W {\n  step a = sleep\n  step b = F()\n}\n";
    let parsed = parse(src);
    assert_eq!(parsed.errors().len(), 1, "{:?}", parsed.errors());
    assert!(parsed.debug_tree().contains("STEP_CALL"));
}

#[test]
fn expression_precedence_is_pratt() {
    let src = "resource R {\n  rules {\n    a + b * c == d && !e || f\n  }\n}\n";
    insta::assert_snapshot!(parse(src).debug_tree());
}

#[test]
fn recovers_from_a_bad_field_and_keeps_parsing_the_rest() {
    let src = "resource R {\n  id : id\n  bogus ??? here\n  name : text\n}\nenum E {\n  A\n}\n";
    let parsed = parse(src);
    let msgs: Vec<String> = parsed
        .errors()
        .iter()
        .map(|e| format!("{}..{}: {}", e.range.start, e.range.end, e.message))
        .collect();
    insta::assert_snapshot!(format!("{}\n---\n{}", msgs.join("\n"), parsed.debug_tree()));
    assert_eq!(
        parsed.syntax().text().to_string(),
        src,
        "lossless even with errors"
    );
}

#[test]
fn recovers_from_unclosed_block_at_eof() {
    let src = "resource R {\n  id : id\n";
    let parsed = parse(src);
    assert!(!parsed.errors().is_empty());
    assert_eq!(parsed.syntax().text().to_string(), src);
}

#[test]
fn keywords_are_contextual_field_names() {
    let src = "resource R {\n  order : text\n  status : text\n  list by order\n}\n";
    let parsed = parse(src);
    assert!(parsed.errors().is_empty(), "{:?}", parsed.errors());
}

#[test]
fn doc_comments_attach_to_the_following_declaration_field_and_member() {
    use forgegraph_syntax::ast::Declaration;
    let src = "/// Customer doc\n/// second line\nresource Customer {\n  /// the code\n  code : text\n}\n\n/// tiers\nenum Tier {\n  /// gold doc\n  Gold\n}\n";
    let parsed = parse(src);
    assert!(parsed.errors().is_empty(), "{:?}", parsed.errors());
    let decls: Vec<Declaration> = parsed.root().declarations().collect();
    assert_eq!(decls[0].doc().as_deref(), Some("Customer doc\nsecond line"));
    assert_eq!(decls[1].doc().as_deref(), Some("tiers"));
    let Declaration::Resource(r) = &decls[0] else {
        panic!()
    };
    assert_eq!(
        r.fields().next().unwrap().doc().as_deref(),
        Some("the code")
    );
    let Declaration::Enum(e) = &decls[1] else {
        panic!()
    };
    assert_eq!(
        e.members().next().unwrap().doc().as_deref(),
        Some("gold doc")
    );
}

#[test]
fn parses_blob_declarations_with_content_block() {
    let src = fixture("acme/src/orders/attachments.forge");
    let parsed = parse(&src);
    assert!(parsed.errors().is_empty(), "{:?}", parsed.errors());
    assert_eq!(parsed.syntax().text().to_string(), src);
    insta::assert_snapshot!(parsed.debug_tree());
}

#[test]
fn parses_cache_view_and_projection_declarations() {
    let src = fixture("acme/src/orders/summaries.forge");
    let parsed = parse(&src);
    assert!(parsed.errors().is_empty(), "{:?}", parsed.errors());
    assert_eq!(parsed.syntax().text().to_string(), src);
    insta::assert_snapshot!(parsed.debug_tree());
}

#[test]
fn edition_2027_governance_fixtures_parse_losslessly() {
    for rel in [
        "next/governance/src/index.forge",
        "next/payments/src/index.forge",
        "next/acme-next/src/index.forge",
        "next/acme-next/src/customers.forge",
        "next/acme-next/src/orders.forge",
    ] {
        let src = fixture(rel);
        let parsed = parse(&src);
        assert!(parsed.errors().is_empty(), "{rel}: {:?}", parsed.errors());
        assert_eq!(
            parsed.syntax().text().to_string(),
            src,
            "{rel}: tree is not lossless"
        );
    }
}

#[test]
fn tree_snapshot_governance() {
    let a = fixture("next/governance/src/index.forge");
    let b = fixture("next/acme-next/src/customers.forge");
    insta::assert_snapshot!(format!(
        "{}\n{}",
        parse(&a).debug_tree(),
        parse(&b).debug_tree()
    ));
}
