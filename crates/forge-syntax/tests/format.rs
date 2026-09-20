use forge_syntax::{format, parse};

fn fixture(rel: &str) -> String {
    let p = concat!(env!("CARGO_MANIFEST_DIR"), "/../../examples/");
    std::fs::read_to_string(format!("{p}{rel}")).unwrap()
}

const FILES: &[&str] = &[
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
];

#[test]
fn reference_files_are_already_canonical() {
    for rel in FILES {
        let src = fixture(rel);
        assert_eq!(format(&parse(&src)), src, "{rel} is not a fixed point of fmt");
    }
}

#[test]
fn formatting_is_idempotent_on_messy_input() {
    let messy = "resource   Site @tenant @crud(\"/v1/sites\")   {\nid:id\n  customer:Customer   @immutable\n  list by customer\n  order by name asc\n\n\n  lifecycle status { initial Draft\n    cancel: Draft->Cancelled input { reason : text }\n  }\n}\n";
    let once = format(&parse(messy));
    let twice = format(&parse(&once));
    assert_eq!(once, twice);
}

#[test]
fn normalizes_spacing_indentation_decorators_and_blank_lines() {
    let messy = "resource   Site @tenant @crud(\"/v1/sites\")   {\nid:id\n  customer:Customer   @immutable\n  list by customer\n  order by name asc\n\n\n  lifecycle status { initial Draft\n    cancel: Draft->Cancelled input { reason : text }\n  }\n}\n";
    let expected = "resource Site\n  @tenant\n  @crud(\"/v1/sites\")\n{\n  id : id\n  customer : Customer @immutable\n  list by customer\n    order by name asc\n\n  lifecycle status {\n    initial Draft\n    cancel: Draft -> Cancelled\n      input {\n        reason : text\n      }\n  }\n}\n";
    assert_eq!(format(&parse(messy)), expected);
}

#[test]
fn preserves_comments_and_unparseable_regions_verbatim() {
    let src = "// header comment\nresource R {\n  id : id // trailing\n  bogus ??? here\n  // between\n  name : text\n}\n";
    let out = format(&parse(src));
    assert_eq!(out, "// header comment\nresource R {\n  id : id // trailing\n  bogus ??? here\n  // between\n  name : text\n}\n");
}

#[test]
fn expressions_and_type_args_are_spaced_canonically() {
    let src = "type A = money<USD>>=0\nresource R {\n  total:=subtotal+tax*2\n  rules {\n    site.customer==customer&&!x\n  }\n}\n";
    let out = format(&parse(src));
    assert_eq!(out, "type A = money<USD> >= 0\nresource R {\n  total := subtotal + tax * 2\n  rules {\n    site.customer == customer && !x\n  }\n}\n");
}
